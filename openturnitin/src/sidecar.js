const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const http = require('http');
const { EventEmitter } = require('events');

class Sidecar extends EventEmitter {
  constructor(binDir) {
    super();
    this.binDir = binDir;
    this.proc = null;
    this.port = null;
    this.ready = false;
    this.starting = false;
  }

  binaryPath() {
    const name = process.platform === 'win32'
      ? 'llama-server-win32-x64.exe'
      : `llama-server-${process.platform}-${process.arch}`;
    return path.join(this.binDir, name);
  }

  isAvailable() { return fs.existsSync(this.binaryPath()); }

  async start(modelPath) {
    if (this.proc || this.starting) return;
    this.starting = true;
    if (!this.isAvailable()) throw new Error('llama-server binary not found. Run `npm run setup`.');

    this.port = await findFreePort(8181);
    const args = [
      '-m', modelPath,
      '-c', '8192',
      '-np', '1',
      '-ngl', '99',
      '--host', '127.0.0.1',
      '--port', String(this.port),
      '--cors',
      '--no-webui'
    ];

    this.emit('starting', { port: this.port });
    this.proc = spawn(this.binaryPath(), args, {
      cwd: this.binDir,
      env: { ...process.env, LD_LIBRARY_PATH: this.binDir, DYLD_LIBRARY_PATH: this.binDir },
      stdio: ['ignore', 'pipe', 'pipe']
    });

    let stderrBuf = '';
    this.proc.stderr.on('data', (d) => {
      stderrBuf += d.toString();
      if (stderrBuf.length > 4000) stderrBuf = stderrBuf.slice(-4000);
    });
    this.proc.stdout.on('data', () => {});

    this.proc.on('exit', (code, sig) => {
      this.ready = false;
      this.proc = null;
      this.starting = false;
      this.emit('stopped', { code, sig, log: stderrBuf.slice(-800) });
    });

    // Poll /health until ready
    const deadline = Date.now() + 90000; // 90s
    while (Date.now() < deadline) {
      if (this.proc === null) throw new Error('llama-server exited during load:\n' + stderrBuf.slice(-800));
      if (await this.health()) {
        this.ready = true;
        this.starting = false;
        this.emit('ready', { port: this.port });
        return this.port;
      }
      await sleep(500);
    }
    this.stop();
    throw new Error('Model failed to load within 90s. It may be too large for this machine.');
  }

  health() {
    return new Promise((resolve) => {
      if (!this.port) return resolve(false);
      const req = http.get({ host: '127.0.0.1', port: this.port, path: '/health', timeout: 1000 }, (res) => {
        let body = '';
        res.on('data', (c) => (body += c));
        res.on('end', () => resolve(res.statusCode === 200 && body.includes('ok')));
      });
      req.on('error', () => resolve(false));
      req.on('timeout', () => { req.destroy(); resolve(false); });
    });
  }

  stop() {
    if (!this.proc) return;
    try { this.proc.kill('SIGTERM'); } catch (e) {}
    const proc = this.proc;
    setTimeout(() => { try { if (!proc.killed) proc.kill('SIGKILL'); } catch (e) {} }, 3000);
    this.proc = null;
    this.ready = false;
  }
}

function findFreePort(start) {
  return new Promise((resolve, reject) => {
    const net = require('net');
    const tryPort = (p) => {
      const srv = net.createServer();
      srv.once('error', () => tryPort(p + 1));
      srv.once('listening', () => srv.close(() => resolve(p)));
      srv.listen(p, '127.0.0.1');
    };
    tryPort(start);
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

module.exports = { Sidecar };