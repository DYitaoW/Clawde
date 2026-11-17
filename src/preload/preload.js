const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  getUsage: () => ipcRenderer.invoke('get-usage'),
  refresh: () => ipcRenderer.invoke('refresh-usage'),
  login: (provider) => ipcRenderer.invoke('log-in', provider),
  logout: (provider) => ipcRenderer.invoke('log-out', provider),
  quit: () => ipcRenderer.invoke('quit-app'),
  resizePopover: (height, width) => ipcRenderer.invoke('resize-popover', height, width),
  setPopoverBackground: (color) => ipcRenderer.invoke('set-popover-background', color),
  getSettings: () => ipcRenderer.invoke('get-settings'),
  getSystemStats: () => ipcRenderer.invoke('get-system-stats'),
  getUpdateStatus: () => ipcRenderer.invoke('get-update-status'),
  checkForUpdates: () => ipcRenderer.invoke('check-for-updates'),
  openReleasePage: () => ipcRenderer.invoke('open-release-page'),
  installUpdate: () => ipcRenderer.invoke('install-update'),
  openUsagePage: (provider) => ipcRenderer.invoke('open-usage-page', provider),
  onOpenSettings: (callback) => {
    const handler = () => callback();
    ipcRenderer.on('open-settings', handler);
    return () => ipcRenderer.removeListener('open-settings', handler);
  },
  onUpdateStatus: (callback) => {
    const handler = (_event, status) => callback(status);
    ipcRenderer.on('update-status', handler);
    return () => ipcRenderer.removeListener('update-status', handler);
  },
  updateSettings: (settings) => ipcRenderer.invoke('update-settings', settings),
  onUsageUpdated: (callback) => {
    const handler = (_event, data) => callback(data);
    ipcRenderer.on('usage-updated', handler);
    return () => ipcRenderer.removeListener('usage-updated', handler);
  }
});
