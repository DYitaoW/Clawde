const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  getUsage: () => ipcRenderer.invoke('get-usage'),
  refresh: () => ipcRenderer.invoke('refresh-usage'),
  login: (provider) => ipcRenderer.invoke('log-in', provider),
  submitAntigravityCode: (code) => ipcRenderer.invoke('antigravity-submit-code', code),
  logout: (provider) => ipcRenderer.invoke('log-out', provider),
  quit: () => ipcRenderer.invoke('quit-app'),
  resizePopover: (height) => ipcRenderer.invoke('resize-popover', height),
  getSettings: () => ipcRenderer.invoke('get-settings'),
  getSystemStats: () => ipcRenderer.invoke('get-system-stats'),
  updateSettings: (settings) => ipcRenderer.invoke('update-settings', settings),
  onUsageUpdated: (callback) => {
    const handler = (_event, data) => callback(data);
    ipcRenderer.on('usage-updated', handler);
    return () => ipcRenderer.removeListener('usage-updated', handler);
  }
});
