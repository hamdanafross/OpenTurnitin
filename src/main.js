const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const http = require('http');
const fs = require('fs');
const { ModelManager } = require('./model-manager');
const { Sidecar } = require('./sidecar');

let win = null;
let uiServer = null;
let uiPort = null;
let modelManager = null;
let sidecar = null;

function startUiServer() {
  // Serves renderer/ over http://127.0.0.1:PORT — avoids file:// CORS weirdness
  // and gives a stable origin for localStorage.
  const root = path.join(__dirname, '..', 'renderer');
  const mime = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'application/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.svg': 'image/svg+xml',
    '.png': 'image/png',
    '.ico': 'image/x-icon'
  };
  return new Promise((resolve) => {
    uiServer = http.createServer((req, res) => {
      let p = decodeURIComponent(req.url.split('?')[0]);
      if (p === '/') p = '/index.html';
      // Only allow known files inside renderer/ (path traversal guard)
      const safe = path.normalize(p).replace(/^(\.\.[/\\])+/, '');
      const file = path.join(root, safe);
      if (!file.startsWith(root)) { res.writeHead(403); return res.end(); }
      fs.readFile(file, (err, data) => {
        if (err) { res.writeHead(404); return res.end('Not found'); }
        res.writeHead(200, { 'Content-Type': mime[path.extname(file)] || 'application/octet-stream' });
        res.end(data);
      });
    });
    uiServer.listen(0, '127.0.0.1', () => {
      uiPort = uiServer.address().port;
      resolve();
    });
  });
}

async function createWindow() {
  await startUiServer();
  win = new BrowserWindow({
    width: 1280,
    height: 900,
    minWidth: 900,
    minHeight: 640,
    title: 'Turnitout',
    backgroundColor: '#f7f9fc',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  });
  win.loadURL(`http://127.0.0.1:${uiPort}/`);
  if (process.argv.includes('--dev')) win.webContents.openDevTools({ mode: 'detach' });
}

app.whenReady().then(async () => {
  modelManager = new ModelManager(app.getPath('userData'));
  sidecar = new Sidecar(path.join(process.resourcesPath || path.join(__dirname, '..'), 'bin'));
  // In dev, resourcesPath points elsewhere — fall back to project bin
  if (!sidecar.isAvailable()) {
    sidecar = new Sidecar(path.join(__dirname, '..', 'bin'));
  }

  // Forward sidecar events to renderer
  sidecar.on('starting', (info) => win?.webContents.send('sidecar:starting', info));
  sidecar.on('ready', (info) => win?.webContents.send('sidecar:ready', info));
  sidecar.on('stopped', (info) => win?.webContents.send('sidecar:stopped', info));

  await createWindow();
});

app.on('window-all-closed', () => {
  sidecar?.stop();
  uiServer?.close();
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', () => {
  sidecar?.stop();
  uiServer?.close();
});

// ---------- IPC ----------

ipcMain.handle('model:status', () => {
  const installed = modelManager.installed();
  const recommended = modelManager.recommend();
  return {
    installed: installed ? { key: installed.key, file: installed.file, size: installed.size } : null,
    recommended: recommended ? { key: recommended.key, label: recommended.label, size: recommended.size } : null,
    totalRamGB: Math.round((require('os').totalmem() / 1e9) * 10) / 10,
    sidecarAvailable: sidecar.isAvailable(),
    sidecarReady: sidecar.ready,
    sidecarPort: sidecar.port
  };
});

ipcMain.handle('model:download', async (event, quantKey) => {
  const modelManagerRef = modelManager;
  const progressListener = (p) => event.sender.send('model:progress', p);
  modelManagerRef.on('progress', progressListener);
  try {
    const p = await modelManagerRef.download(quantKey);
    return { ok: true, path: p };
  } catch (e) {
    return { ok: false, error: e.message };
  } finally {
    modelManagerRef.off('progress', progressListener);
  }
});

ipcMain.handle('model:cancelDownload', () => {
  modelManager.cancel();
  return { ok: true };
});

ipcMain.handle('sidecar:start', async () => {
  const installed = modelManager.installed();
  if (!installed) return { ok: false, error: 'No model installed' };
  try {
    const port = await sidecar.start(installed.path);
    return { ok: true, port };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

ipcMain.handle('sidecar:stop', () => {
  sidecar.stop();
  return { ok: true };
});

ipcMain.handle('app:quit', () => {
  app.quit();
});