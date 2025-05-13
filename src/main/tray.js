// Tray icon and menu management for Electron main process
const { Tray, Menu, nativeImage, dialog, shell, app } = require('electron');
const path = require('path');
const fs = require('fs');
const sharp = require('sharp');
const { MISHI_WEB_APP_URL } = require('./config');

let tray = null;
let currentState = null;
let currentStore = null;
let moduleAccess = {};

function buildContextMenuTemplate(state, store, access) {
    const items = [];
    if (!state.isLoggedIn) {
        items.push({
            label: 'Login',
            click: () => access.showLoginWindow && access.showLoginWindow(),
        });
    } else {
        items.push({
            label: 'Show Bar',
            click: () => {
                console.log('[tray.js] Show Bar menu item clicked');
                access.ensureRecordingWindow && access.ensureRecordingWindow();
            },
        });
        if (!state.isRecording) {
            items.push({
                label: 'Start Recording',
                click: () => access.startRecording && access.startRecording(),
            });
        } else {
            items.push({
                label: 'Stop Recording',
                click: () => access.stopRecording && access.stopRecording(),
            });
        }
        items.push({ type: 'separator' });
        items.push({
            label: 'Settings',
            click: () => access.toggleSettingsPanel && access.toggleSettingsPanel(),
        });
        items.push({
            label: 'Logout',
            click: () => access.logout && access.logout(),
        });
    }
    items.push({ type: 'separator' });
    items.push({
        label: 'Quit',
        click: () => app.quit(),
    });
    return items;
}

function initializeTray(initialState, store, access) {
    currentState = initialState;
    currentStore = store;
    moduleAccess = access;
    if (tray) {
        console.log('[tray.js] Destroying existing tray');
        tray.destroy();
        tray = null;
    }
    const iconPath = path.join(__dirname, '../../assets/favicon-32.png');
    console.log('[tray.js] Creating new tray with icon:', iconPath);
    tray = new Tray(nativeImage.createFromPath(iconPath));
    tray.setToolTip('Mishi Recorder');
    console.log('[tray.js] Tray created:', !!tray);
    updateTray(initialState);
}

function updateTray(newState, access) {
    console.log('[tray.js] updateTray called with state:', newState);
    currentState = newState;
    if (access) {
        moduleAccess = access;
    }
    if (!tray) return;
    const contextMenu = Menu.buildFromTemplate(
        buildContextMenuTemplate(currentState, currentStore, moduleAccess)
    );
    tray.setContextMenu(contextMenu);
}

module.exports = {
    initializeTray,
    updateTray,
};
