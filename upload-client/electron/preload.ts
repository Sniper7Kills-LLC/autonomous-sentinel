import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('sentinel', {
  selectWatchFolder: () => ipcRenderer.invoke('settings:selectWatchFolder'),
  getSettings: () => ipcRenderer.invoke('settings:get'),
  saveSettings: (s: unknown) => ipcRenderer.invoke('settings:save', s),
});
