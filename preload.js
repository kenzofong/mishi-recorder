const { contextBridge, ipcRenderer } = require('electron');

console.log('Preload script loaded.');

// Expose protected methods that allow the renderer process to use
// the ipcRenderer without exposing the entire object
contextBridge.exposeInMainWorld('electron', {
    ipcRenderer: {
        send: (...args) => ipcRenderer.send(...args),
        invoke: (...args) => ipcRenderer.invoke(...args),
        on: (...args) => ipcRenderer.on(...args),
        once: (...args) => ipcRenderer.once(...args),
        removeListener: (...args) => ipcRenderer.removeListener(...args),
        // Add more methods as needed
    }
});

console.log('IPC channels exposed to window object.');

// Add recording window API
contextBridge.exposeInMainWorld('electronAPI', {
    // Existing login APIs
    invokeLoginAttempt: (email, password) => ipcRenderer.invoke('login', { email, password }),
    loginWithGoogle: () => ipcRenderer.invoke('oauth-login', { provider: 'google' }),
    notifyLoginSuccess: () => ipcRenderer.send('login-success'),

    // Recording window APIs
    startRecording: () => ipcRenderer.send('start-recording'),
    stopRecording: () => ipcRenderer.send('stop-recording'),
    openSettings: () => ipcRenderer.send('open-settings'),
    toggleSettings: () => ipcRenderer.send('toggle-settings'),
    toggleRecordingWindow: () => ipcRenderer.send('toggle-recording-window'),
    closeWindow: () => ipcRenderer.send('close-recording-window'),
    onAudioData: (callback) => ipcRenderer.on('audio-data', (_, data) => callback(data)),
    onRecordingStateChange: (callback) => ipcRenderer.on('recording-state-change', (_, state) => callback(state)),
    
    // System APIs
    onSystemThemeChange: (callback) => ipcRenderer.on('system-theme-change', (_, isDark) => callback(isDark)),

    // Settings APIs
    getSettings: () => ipcRenderer.invoke('get-settings'),
    updateSettings: (changes) => ipcRenderer.invoke('update-settings', changes),
    listAudioInputDevices: () => ipcRenderer.invoke('list-audio-input-devices'),
    onSettingsChange: (callback) => ipcRenderer.on('settings-change', (_, settings) => callback(settings)),
    onSettingsStateChange: (callback) => ipcRenderer.on('settings-state-change', (_, isOpen) => callback(isOpen)),
    onBeforeHide: (callback) => ipcRenderer.on('before-hide', callback)
});

// Add meeting update handler with enhanced logging
ipcRenderer.on('meeting-updated', (event, data) => {
    console.log('[Preload] Received meeting update:', {
        hasData: !!data,
        type: data?.type,
        hasMeeting: !!data?.meeting,
        meetingId: data?.meeting?.id
    });

    // Ensure we're sending a properly formatted message
    window.postMessage({
        type: 'meeting-updated',
        meeting: data.meeting
    }, '*');

    console.log('[Preload] Posted meeting update to window');
}); 