const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('turnitout', {
  modelStatus: () => ipcRenderer.invoke('model:status'),
  downloadModel: (key) => ipcRenderer.invoke('model:download', key),
  cancelDownload: () => ipcRenderer.invoke('model:cancelDownload'),
  onModelProgress: (cb) => {
    const h = (_e, p) => cb(p);
    ipcRenderer.on('model:progress', h);
    return () => ipcRenderer.removeListener('model:progress', h);
  },
  startSidecar: () => ipcRenderer.invoke('sidecar:start'),
  stopSidecar: () => ipcRenderer.invoke('sidecar:stop'),
  onSidecarReady: (cb) => {
    const h = (_e, p) => cb(p);
    ipcRenderer.on('sidecar:ready', h);
    return () => ipcRenderer.removeListener('sidecar:ready', h);
  },
  onSidecarStopped: (cb) => {
    const h = (_e, p) => cb(p);
    ipcRenderer.on('sidecar:stopped', h);
    return () => ipcRenderer.removeListener('sidecar:stopped', h);
  },
  quit: () => ipcRenderer.invoke('app:quit')
});