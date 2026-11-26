/* PERCEPTION - preload bridge */
const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('perceptionHost', {
  isElectron: true,
  readSave: (name) => ipcRenderer.invoke('perception:read-save', name),
  writeSave: (name, data) => ipcRenderer.invoke('perception:write-save', name, data),
  deleteSave: (name) => ipcRenderer.invoke('perception:delete-save', name),
  meta: () => ipcRenderer.invoke('perception:meta'),
  savePng: (dataUrl, name) => ipcRenderer.invoke('perception:save-png', dataUrl, name),
  quit: () => ipcRenderer.invoke('app:quit'),
  capture: (name) => ipcRenderer.invoke('app:capture', name)
});
