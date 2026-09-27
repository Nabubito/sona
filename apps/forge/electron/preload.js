// Bridge: exposes native app-window actions to the page as window.forge.
const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('forge', {
  isElectron: true,
  pickFile: (opts) => ipcRenderer.invoke('forge:pickFile', opts),
  pickFiles: () => ipcRenderer.invoke('forge:pickFiles'),
  pickFolder: () => ipcRenderer.invoke('forge:pickFolder'),
  saveAs: (name) => ipcRenderer.invoke('forge:saveAs', name),
  reveal: (p) => ipcRenderer.invoke('forge:reveal', p),
  openDrive: (d) => ipcRenderer.invoke('forge:openDrive', d),
  runInstaller: (d) => ipcRenderer.invoke('forge:runInstaller', d),
  onHandle: (cb) => ipcRenderer.on('forge:handle', (_e, job) => cb(job))
});
