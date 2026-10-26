const fs = require('fs');
const path = require('path');
const os = require('os');
const https = require('https');
const crypto = require('crypto');
const { EventEmitter } = require('events');

const MODELS = require('../models.json');

class ModelManager extends EventEmitter {
  constructor(userDataDir) {
    super();
    this.dir = path.join(userDataDir, 'models');
    fs.mkdirSync(this.dir, { recursive: true });
    this.activeDownload = null;
  }

  // Pick the best quant for the user's RAM, honoring an explicit override.
  recommend() {
    const totalGB = os.totalmem() / 1e9;
    const entries = Object.entries(MODELS.quants).sort((a, b) => b[1].minRamGB - a[1].minRamGB);
    for (const [key, q] of entries) {
      if (totalGB >= q.minRamGB) return { key, ...q };
    }
    return null; // below minimum
  }

  installed() {
    for (const [key, q] of Object.entries(MODELS.quants)) {
      const p = path.join(this.dir, q.file);
      if (fs.existsSync(p) && fs.statSync(p).size === q.size) return { key, ...q, path: p };
    }
    return null;
  }

  pathFor(key) {
    const q = MODELS.quants[key];
    if (!q) throw new Error(`Unknown quant: ${key}`);
    return path.join(this.dir, q.file);
  }

  async download(quantKey) {
    if (this.activeDownload) throw new Error('A download is already in progress');
    const q = MODELS.quants[quantKey];
    if (!q) throw new Error(`Unknown quant: ${quantKey}`);

    const dest = this.pathFor(quantKey);
    const tmp = dest + '.part';
    const url = MODELS.baseUrl + q.file;

    // Resume support
    let startByte = 0;
    if (fs.existsSync(tmp)) startByte = fs.statSync(tmp).size;
    if (startByte === q.size) { fs.renameSync(tmp, dest); return dest; }

    this.activeDownload = { cancelled: false };
    const controller = this.activeDownload;

    await new Promise((resolve, reject) => {
      const headers = { 'User-Agent': 'turnitout' };
      if (startByte > 0) headers.Range = `bytes=${startByte}-`;

      const req = https.get(url, { headers }, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          req.destroy();
          // Follow redirect by recursing with the same state
          return https.get(res.headers.location, { headers }, handle).on('error', reject);
        }
        handle(res);
      }).on('error', reject);

      function handle(res) {
        if (res.statusCode !== 200 && res.statusCode !== 206) {
          return reject(new Error(`HTTP ${res.statusCode}`));
        }
        const total = q.size;
        let received = startByte;
        const file = fs.createWriteStream(tmp, { flags: startByte ? 'a' : 'w' });
        let lastEmit = 0;

        res.on('data', (chunk) => {
          if (controller.cancelled) {
            res.destroy();
            file.end(() => reject(new Error('cancelled')));
            return;
          }
          received += chunk.length;
          const now = Date.now();
          if (now - lastEmit > 200) {
            lastEmit = now;
            this.emit('progress', { received, total, percent: received / total });
          }
        });
        res.pipe(file);
        file.on('finish', () => {
          file.close(() => {
            if (received < total) return reject(new Error(`Incomplete: ${received}/${total}`));
            this.emit('progress', { received, total, percent: 1 });
            resolve();
          });
        });
        file.on('error', reject);
      }
    }).finally(() => { this.activeDownload = null; });

    // Verify checksum if provided
    const expected = MODELS.checksums[q.file];
    if (expected) {
      this.emit('progress', { verify: true });
      const actual = await sha256File(tmp);
      if (actual !== expected) {
        fs.unlinkSync(tmp);
        throw new Error(`Checksum mismatch: expected ${expected.slice(0, 12)}…, got ${actual.slice(0, 12)}…`);
      }
    }

    fs.renameSync(tmp, dest);
    return dest;
  }

  cancel() {
    if (this.activeDownload) this.activeDownload.cancelled = true;
  }

  async remove(key) {
    const p = this.pathFor(key);
    if (fs.existsSync(p)) fs.unlinkSync(p);
  }
}

function sha256File(filePath) {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash('sha256');
    const s = fs.createReadStream(filePath);
    s.on('data', (c) => h.update(c));
    s.on('end', () => resolve(h.digest('hex')));
    s.on('error', reject);
  });
}

module.exports = { ModelManager };