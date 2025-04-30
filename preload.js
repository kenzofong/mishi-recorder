const { contextBridge, ipcRenderer } = require('electron');

console.log('Preload script loaded.');

// Expose protected methods that allow the renderer process to use
// the ipcRenderer without exposing the entire object
contextBridge.exposeInMainWorld(
    'electron',
    {
        ipcRenderer: {
            invoke: (channel, data) => {
                const validChannels = ['login', 'oauth-login'];
                if (validChannels.includes(channel)) {
                    return ipcRenderer.invoke(channel, data);
                }
                throw new Error(`Invalid channel: ${channel}`);
            },
            send: (channel, data) => {
                const validChannels = ['login-success'];
                if (validChannels.includes(channel)) {
                    ipcRenderer.send(channel, data);
                }
            }
        }
    }
);

console.log('IPC channels exposed to window object.'); 