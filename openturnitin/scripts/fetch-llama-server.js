#!/usr/bin/env node
// Downloads the appropriate llama-server build into ./bin for the current platform.
// Run with --all to fetch all platforms (for CI cross-builds).
const fs = require('fs');
const path = require('path');
const https = require('https');
const { execSync } = require('child_process');

const BIN = path.join(__dirname, '..', 'bin');
fs.mkdirSync(BIN, { recursive: true });

function fetchJson(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'User-Agent': 'turnitout-setup' } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return fetchJson(res.headers.location).then(resolve, reject);
      }
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => {
        try { resolve(JSON.parse(data)); } catch (e) { reject(e); }
      });
    }).on('error', reject);
  });
}

function download(url, dest) {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(dest);
    https.get(url, { headers: { 'User-Agent': 'turnitout-setup' } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        file.close(); fs.unlinkSync(dest);
        return download(res.headers.location, dest).then(resolve, reject);
      }
      if (res.statusCode !== 200) {
        file.close();
        return reject(new Error(`HTTP ${res.statusCode} for ${url}`));
      }
      res.pipe(file);
      file.on('finish', () => file.close(resolve));
    }).on('error', (e) => { fs.unlink(dest, () => {}); reject(e); });
  });
}

function platformAssetName(platform, arch) {
  // llama.cpp release asset naming (as of b4xxx builds):
  if (platform === 'darwin') return `llama-${arch === 'arm64' ? 'macos-arm64' : 'macos-x64'}.zip`;
  if (platform === 'win32') return 'llama-win-vulkan-x64.zip';   // Vulkan: works on AMD/Intel/Nvidia
  if (platform === 'linux') return 'llama-linux-x64.zip';
  throw new Error(`Unsupported platform: ${platform}`);
}

function localBinaryName(platform) {
  return platform === 'win32' ? 'llama-server-win32-x64.exe' : `llama-server-${platform}-${process.arch}`;
}

async function install(platform, arch) {
  console.log(`Fetching llama-server for ${platform}/${arch}...`);
  const release = await fetchJson('https://api.github.com/repos/ggml-org/llama.cpp/releases/latest');
  const suffix = platformAssetName(platform, arch);
  const asset = release.assets.find(a => a.name.endsWith(suffix));
  if (!asset) throw new Error(`No asset matching *${suffix} in ${release.tag_name}`);

  const tmpZip = path.join(BIN, `_dl_${asset.name}`);
  await download(asset.browser_download_url, tmpZip);

  // Extract
  const extractDir = path.join(BIN, `_x_${platform}`);
  fs.mkdirSync(extractDir, { recursive: true });
  if (process.platform === 'win32') {
    execSync(`powershell -NoProfile -Command "Expand-Archive -Path '${tmpZip}' -DestinationPath '${extractDir}' -Force"`, { stdio: 'inherit' });
  } else {
    execSync(`unzip -o "${tmpZip}" -d "${extractDir}"`, { stdio: 'inherit' });
  }

  // Find llama-server inside the extracted tree
  const findFile = (dir, name) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) { const hit = findFile(p, name); if (hit) return hit; }
      else if (e.name === name) return p;
    }
    return null;
  };
  const exeName = platform === 'win32' ? 'llama-server.exe' : 'llama-server';
  const found = findFile(extractDir, exeName);
  if (!found) throw new Error(`llama-server not found in archive ${asset.name}`);

  const dest = path.join(BIN, localBinaryName(platform));
  fs.copyFileSync(found, dest);
  if (platform !== 'win32') fs.chmodSync(dest, 0o755);

  // Copy shared libs alongside (llama.cpp ships .so / .dylib / .dll)
  const libDir = path.dirname(found);
  for (const f of fs.readdirSync(libDir)) {
    if (/\.(so|dylib|dll)(\.\d+)*$/.test(f)) {
      fs.copyFileSync(path.join(libDir, f), path.join(BIN, f));
    }
  }

  fs.rmSync(tmpZip, { force: true });
  fs.rmSync(extractDir, { recursive: true, force: true });
  console.log(`  → ${dest}`);
}

(async () => {
  const all = process.argv.includes('--all');
  if (all) {
    for (const p of ['darwin', 'win32', 'linux']) {
      try { await install(p, p === 'darwin' ? 'arm64' : 'x64'); }
      catch (e) { console.error(`  ! ${p}: ${e.message}`); }
    }
  } else {
    await install(process.platform, process.arch);
  }
  console.log('Done.');
})().catch((e) => { console.error(e); process.exit(1); });