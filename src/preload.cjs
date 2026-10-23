const { contextBridge, ipcRenderer } = require('electron');
// Fixed operations only. No generic filesystem, IPC, shell or credential read API.
contextBridge.exposeInMainWorld('ws', {
  snapshot: () => ipcRenderer.invoke('snapshot'),
  task: (action, revision) => ipcRenderer.invoke('task', action, revision),
  window: (action, payload) => ipcRenderer.invoke('window-action', action, payload),
  config: (value) => ipcRenderer.invoke('save-config', value),
  credential: (key) => ipcRenderer.invoke('credential', key),
  testLLM: () => ipcRenderer.invoke('test-llm'),
  privateData: (command, payload = {}) => ipcRenderer.invoke('private-data', command, payload),
  integration: (command, payload = {}) => ipcRenderer.invoke('integration', command, payload),
  theme: () => ipcRenderer.invoke('theme'),
  subscribe: (callback) => {
    const handler = () => callback();
    ipcRenderer.on('changed', handler);
    return () => ipcRenderer.removeListener('changed', handler);
  },
  performance: (callback) => {
    const handler = (_event, data) => callback(data);
    ipcRenderer.on('performance', handler);
    return () => ipcRenderer.removeListener('performance', handler);
  },
});
