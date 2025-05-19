const { BrowserWindow, dialog, ipcMain, screen } = require('electron');
const path = require('path');

let loginWindow = null;
let recordingWindow = null;
let settingsWindow = null;
let dockBarWindow = null;

function showLoginWindow({ preloadPath, loginHtmlPath }) {
    if (loginWindow && !loginWindow.isDestroyed()) {
        loginWindow.focus();
        return loginWindow;
    }
    loginWindow = new BrowserWindow({
        width: 400,
        height: 600,
        resizable: false,
        frame: false,
        ...(process.platform === 'darwin' ? { titleBarStyle: 'hidden' } : {}),
        webPreferences: {
            preload: preloadPath,
            nodeIntegration: false,
            contextIsolation: true,
        },
        autoHideMenuBar: true,
        title: 'Login',
    });
    loginWindow.loadFile(loginHtmlPath);
    loginWindow.on('closed', () => { loginWindow = null; });
    return loginWindow;
}

function toggleSettingsPanel({ recordingWindow, preloadPath, settingsHtmlPath, screen, onHide }) {
    if (settingsWindow && !settingsWindow.isDestroyed()) {
        settingsWindow.hide();
        if (onHide) onHide();
        settingsWindow = null;
        return;
    }
    settingsWindow = new BrowserWindow({
        width: 350,
        height: 400,
        parent: recordingWindow,
        modal: false,
        show: true,
        webPreferences: {
            preload: preloadPath,
            nodeIntegration: false,
            contextIsolation: true,
        },
        autoHideMenuBar: true,
        title: 'Settings',
    });
    settingsWindow.loadFile(settingsHtmlPath);
    settingsWindow.on('closed', () => {
        settingsWindow = null;
        if (onHide) onHide();
    });
}

function createSettingsWindow({ recordingWindow, preloadPath, settingsHtmlPath, screen, onHide }) {
    if (!recordingWindow) return null;
    let settingsWindow = new BrowserWindow({
        width: 300,
        height: 400,
        frame: false,
        transparent: true,
        resizable: false,
        skipTaskbar: true,
        alwaysOnTop: true,
        hasShadow: true,
        webPreferences: {
            preload: preloadPath,
            contextIsolation: true,
            nodeIntegration: false,
        },
        show: false,
        type: 'panel',
        vibrancy: 'menu',
        parent: recordingWindow,
    });
    settingsWindow.loadFile(settingsHtmlPath);
    function positionWindow() {
        if (!recordingWindow || recordingWindow.isDestroyed()) {
            settingsWindow?.close();
            return;
        }
        const recordingBounds = recordingWindow.getBounds();
        const settingsBounds = settingsWindow.getBounds();
        const x = Math.round(recordingBounds.x + (recordingBounds.width / 2) - (settingsBounds.width / 2));
        const y = Math.round(recordingBounds.y - settingsBounds.height - 8);
        const display = screen.getDisplayNearestPoint({ x: recordingBounds.x, y: recordingBounds.y });
        const workArea = display.workArea;
        const adjustedX = Math.max(workArea.x, Math.min(x, workArea.x + workArea.width - settingsBounds.width));
        const adjustedY = Math.max(workArea.y, Math.min(y, workArea.y + workArea.height - settingsBounds.height));
        settingsWindow.setPosition(adjustedX, adjustedY);
    }
    settingsWindow.once('ready-to-show', () => {
        positionWindow();
        settingsWindow.show();
        settingsWindow.focus();
    });
    recordingWindow.on('move', () => positionWindow());
    recordingWindow.on('hide', () => settingsWindow?.hide());
    settingsWindow.on('blur', () => {
        if (!recordingWindow?.isFocused()) {
            if (onHide) onHide(settingsWindow);
        }
    });
    settingsWindow.on('hide', () => {
        settingsWindow.destroy();
        if (onHide) onHide(settingsWindow);
    });
    return settingsWindow;
}

function hideSettingsWindow({ settingsWindow, recordingWindow }) {
    if (!settingsWindow) return;
    recordingWindow?.webContents.send('settings-state-change', false);
    settingsWindow.webContents.send('before-hide');
    setTimeout(() => {
        if (settingsWindow) {
            settingsWindow.hide();
        }
    }, 150);
}

function closeLoginWindow() {
    if (loginWindow && !loginWindow.isDestroyed()) {
        loginWindow.close();
        loginWindow = null;
    }
}

function closeRecordingWindow() {
    if (recordingWindow && !recordingWindow.isDestroyed()) {
        recordingWindow.hide();
        recordingWindow = null;
    }
}

function createDockBarWindow({ preloadPath }) {
    if (dockBarWindow && !dockBarWindow.isDestroyed()) {
        dockBarWindow.show();
        dockBarWindow.focus();
        return dockBarWindow;
    }
    const { width, height } = screen.getPrimaryDisplay().workAreaSize;
    const barWidth = 100;
    const x = Math.round((width - barWidth) / 2);
    dockBarWindow = new BrowserWindow({
        width: barWidth,
        height: 8,
        x: x,
        y: height - 8,
        resizable: false,
        movable: false,
        minimizable: false,
        maximizable: false,
        closable: true,
        alwaysOnTop: true,
        skipTaskbar: true,
        frame: false,
        transparent: true,
        hasShadow: false,
        webPreferences: {
            preload: preloadPath,
            nodeIntegration: true,
            contextIsolation: false,
        },
        autoHideMenuBar: true,
        title: 'Dock Bar',
        focusable: false,
    });
    dockBarWindow.loadFile(path.join(__dirname, '../../dockBar.html')).then(() => {
        console.log('[windows.js] Loaded dockBar.html');
    }).catch((err) => {
        console.error('[windows.js] Failed to load dockBar.html:', err);
    });
    dockBarWindow.on('closed', () => { dockBarWindow = null; });
    return dockBarWindow;
}

function createMeetingOverlayWindow({ company, template, content }) {
    console.log('[windows.js] createMeetingOverlayWindow called with:', { company, template, content });
    // Anchor overlay above floating bar
    let overlayWidth = 960;
    let overlayHeight = 600;
    let x, y;
    // Prefer global.recordingWindow if available
    let barWindow = global.recordingWindow && !global.recordingWindow.isDestroyed() ? global.recordingWindow : (typeof recordingWindow !== 'undefined' && recordingWindow && !recordingWindow.isDestroyed() ? recordingWindow : null);
    if (barWindow) {
        const barBounds = barWindow.getBounds();
        x = Math.round(barBounds.x + (barBounds.width / 2) - (overlayWidth / 2));
        y = Math.round(barBounds.y - overlayHeight - 8); // 8px margin above bar
    } else {
        // Fallback: center on screen
        const { width: screenWidth, height: screenHeight } = screen.getPrimaryDisplay().workAreaSize;
        x = Math.round(screenWidth / 2 - overlayWidth / 2);
        y = Math.round(screenHeight / 2 - overlayHeight / 2);
    }
    const overlayWindowOptions = {
        width: overlayWidth,
        height: overlayHeight,
        x,
        y,
        resizable: true,
        movable: true,
        minimizable: false,
        maximizable: false,
        closable: true,
        alwaysOnTop: true,
        skipTaskbar: true,
        frame: false, // Frameless for custom chrome
        transparent: false,
        hasShadow: true,
        show: true,
        center: false,
        // Try customButtonsOnHover for macOS
        ...(process.platform === 'darwin' ? { titleBarStyle: 'customButtonsOnHover' } : {}),
        webPreferences: {
            preload: path.join(__dirname, '../../preload.js'),
            contextIsolation: true,
            nodeIntegration: false,
            enableRemoteModule: false,
        },
        autoHideMenuBar: true,
        title: 'Meeting Note',
    };
    console.log('[createMeetingOverlayWindow] BrowserWindow options:', overlayWindowOptions);
    const overlayWindow = new BrowserWindow(overlayWindowOptions);
    // Pass data via query params
    const params = new URLSearchParams({
        company,
        template,
        content
    }).toString();
    const overlayHtmlPath = path.join(__dirname, '../../meetingOverlay.html');
    overlayWindow.loadFile(overlayHtmlPath, { search: `?${params}` });
    overlayWindow.on('closed', () => {});
    overlayWindow.show();
    console.log('[windows.js] overlayWindow.show() called');
    return overlayWindow;
}

ipcMain.handle('minimize-window', (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (win) win.minimize();
});

ipcMain.handle('maximize-window', (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (win) {
        if (win.isMaximized()) {
            win.unmaximize();
        } else {
            win.maximize();
        }
    }
});

module.exports = {
    showLoginWindow,
    toggleSettingsPanel,
    createSettingsWindow,
    hideSettingsWindow,
    closeLoginWindow,
    closeRecordingWindow,
    createDockBarWindow,
    createMeetingOverlayWindow,
};
