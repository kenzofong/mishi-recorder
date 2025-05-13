const { app, Tray, Menu, nativeImage, ipcMain, BrowserWindow, shell, dialog, systemPreferences, screen } = require('electron');
const path = require('path');
const os = require('os');
const Store = require('electron-store');
const { createClient } = require('@supabase/supabase-js');
const fs = require('fs');
const { google } = require('googleapis');
const { OAuth2Client } = require('google-auth-library');
const AudioRecorder = require('./audioRecorder');
const mishiServiceModule = require('./src/main/mishiService');
const sharp = require('sharp'); // Add this at the top with other imports
const {
    createTray,
    createTrayFallback,
    recreateTray,
    updateTrayMenu,
    buildContextMenuTemplate
} = require('./src/main/tray');
// Import config values and validation from src/main/config.js
const {
    SUPABASE_URL,
    SUPABASE_ANON_KEY,
    SUPABASE_SERVICE_ROLE_KEY,
    MISHI_WEB_APP_URL,
    TEMP_RECORDING_FILENAME,
    OAUTH_CALLBACK_WINDOW_OPTIONS,
    validateConfig
} = require('./src/main/config');
const { createAndShowLoginWindow, createSettingsWindow, hideSettingsWindow, createRecordingWindow } = require('./src/main/windows');
const { setupIPCHandlers } = require('./src/main/ipcHandlers');
const { getState, setState, stateEmitter } = require('./src/main/state');
const { withTimeout } = require('./src/main/utils');
const trayManager = require('./src/main/tray');
const windowManager = require('./src/main/windows');
const authService = require('./src/main/auth');
const recordingServiceModule = require('./src/main/recording');
const { authEvents } = require('./src/main/auth');
// Validate config at startup
validateConfig();
// Single instance lock to prevent multiple tray icons
const gotTheLock = app.requestSingleInstanceLock();
if (!gotTheLock) {
    app.quit();
    process.exit(0);
}

// --- Configuration ---
// Load from environment variables (dotenv will load from .env file)

// --- Globals ---
let tray = null;
let audioRecorder = null; // Initialize later with settings
let mishiIntegration = null;
let tempRecordingPath = path.join(app.getPath('userData'), TEMP_RECORDING_FILENAME);
const store = new Store({
    schema: {
        inputDevice: {
            type: 'object',
            properties: {
                type: { type: 'string', enum: ['system', 'mic', 'avfoundation'], default: 'mic' },
                index: { type: 'number', default: 0 },
                name: { type: 'string', default: 'Default Microphone' }
            },
            default: { type: 'mic', index: 0, name: 'Default Microphone' }
        }
    }
});

// Create Supabase storage adapter using electron-store
const electronStoreAdapter = {
    getItem: (key) => {
        return store.get(key);
    },
    setItem: (key, value) => {
        store.set(key, value);
    },
    removeItem: (key) => {
        store.delete(key);
    }
};

let supabase = null;

// Google OAuth2 configuration
const oauth2Client = new OAuth2Client({
    clientId: process.env.GOOGLE_CLIENT_ID,
    clientSecret: process.env.GOOGLE_CLIENT_SECRET,
    // Use a custom protocol handler for desktop apps
    redirectUri: 'https://localhost'  // We'll handle the redirect in the auth window
});

// Track app ready state
let isAppReady = false;

// Add recordingWindow to globals
let recordingWindow = null;

// Add settingsWindow to globals
let settingsWindow = null;

// Add at the top with other state variables
let isStoppingRecording = false;
let stopRecordingTimeout = null;
let isIPCSetup = false;

// Add initialization lock
let isInitializing = false;
let lastInitializedUserId = null;
let hasCompletedInitialSetup = false;
let hasCheckedInitialSession = false;
let loginWindowShown = false;
let loginWindowTimeout = null;

// --- Initialization ---

// --- Electron App Lifecycle ---
app.on('ready', async () => {
    console.log(`---> App Ready event FIRED at ${new Date().toISOString()}`);

    // Restore commented out code
    isAppReady = true;
    console.log("App Ready. Initializing...");
    if (process.platform === 'darwin') {
        app.dock.hide();
    }
    try {
        // Initialize Mishi Integration first
        mishiIntegration = mishiServiceModule.initMishiService({
            supabaseUrl: SUPABASE_URL,
            supabaseKey: SUPABASE_SERVICE_ROLE_KEY,
            anonKey: SUPABASE_ANON_KEY,
            webAppUrl: MISHI_WEB_APP_URL
        });
        console.log("Mishi integration initialized successfully");

        // Initialize authService (Supabase client for auth.js)
        authService.initAuth({
            storeInstance: store,
            mishiServiceInstance: mishiIntegration,
            setStateFn: setState,
        });

        // Initialize Supabase Client
        supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
            auth: {
                storage: electronStoreAdapter,
                autoRefreshToken: true,
                persistSession: true,
                detectSessionInUrl: false,
                flowType: 'pkce'
            },
            realtime: {
                params: {
                    eventsPerSecond: 10
                }
            },
            global: {
                headers: {
                    'X-Client-Info': 'mishi-recorder'
                }
            }
        });
        console.log("Supabase client initialized successfully");

        // Initialize the recording service before creating the tray
        console.log('[main.js] Calling recordingServiceModule.initRecordingService');
        recordingServiceModule.initRecordingService({
            store,
            mishiService: mishiIntegration,
            supabase,
            getState,
            setState,
            TEMP_RECORDING_FILENAME
        });

        // Create tray *after* initial setup and checks
        console.log('[main.js] Calling trayManager.initializeTray');
        await trayManager.initializeTray(getState(), store, {
            startRecording: recordingServiceModule.startRecording,
            stopRecording: recordingServiceModule.stopRecording,
            updateAudioDevice: recordingServiceModule.updateAudioDevice,
            showLoginWindow: () => windowManager.showLoginWindow({
                preloadPath: path.join(__dirname, 'preload.js'),
                loginHtmlPath: path.join(__dirname, 'login.html')
            }),
            toggleSettingsPanel: () => windowManager.toggleSettingsPanel({
                recordingWindow: null, // Should be managed by windowManager
                preloadPath: path.join(__dirname, 'preload.js'),
                settingsHtmlPath: path.join(__dirname, 'settingsPanel.html'),
                screen,
                onHide: () => {}
            }),
            logout: authService.logout,
            ensureRecordingWindow: () => {
                global.recordingWindow = windowManager.ensureRecordingWindow({
                    preloadPath: path.join(__dirname, 'preload.js'),
                    recordingHtmlPath: path.join(__dirname, 'recordingWindow.html'),
                    state: getState(),
                    onClose: () => { global.recordingWindow = null; }
                });
                console.log('[main.js] ensureRecordingWindow: global.recordingWindow =', global.recordingWindow);
                if (global.recordingWindow && !global.recordingWindow.isDestroyed()) {
                    global.recordingWindow.webContents.send('recording-state-change', getState().isRecording);
                }
            }
        });

        // Initialize IPC Listeners
        setupIPCHandlers({
            state: getState(),
            getState,
            store,
            audioRecorder,
            tempRecordingPath,
            setState,
            startRecording: recordingServiceModule.startRecording,
            stopRecording: recordingServiceModule.stopRecording,
            cleanupRecording: recordingServiceModule.cleanupRecording,
            recordingWindow,
            settingsWindow,
            createAndShowLoginWindow,
            createSettingsWindow,
            hideSettingsWindow,
            createRecordingWindow: recordingServiceModule.createRecordingWindow,
            updateAudioDevice: recordingServiceModule.updateAudioDevice,
            isStoppingRecording,
            mishiIntegration,
            supabase,
            authService,
        });

        // Set up auth state change listener
        supabase.auth.onAuthStateChange(async (event, session) => {
            // Restore inner logic (or ensure it wasn't commented out)
            console.log('Auth state changed:', {
                event,
                userId: session?.user?.id,
                hasAccessToken: !!session?.access_token,
                timestamp: new Date().toISOString()
            });
            // ... (rest of the auth state logic) ...
        });

        // Skip initial session check if we've already completed setup
        if (!hasCompletedInitialSetup) {
            // Restore inner logic
            const { data: { session }, error } = await supabase.auth.getSession();
            if (error) {
                console.error("Error retrieving session:", error.message);
                setState({ statusMessage: 'Error: Session check failed' });
            } else if (session) {
                console.log("Found existing session");
                setState({
                    isLoggedIn: true,
                    user: session.user,
                    statusMessage: 'Idle'
                });
            } else {
                console.log("No active session found");
                setState({ 
                    isLoggedIn: false, 
                    user: null, 
                    statusMessage: 'Idle'
                });
            }
        }

        setupThemeChangeListener();

        // Create tray *after* other initial setup
        console.log('[Ready Handler End] Attempting tray creation...');
        await trayManager.initializeTray(getState(), store, {
            startRecording: recordingServiceModule.startRecording,
            stopRecording: recordingServiceModule.stopRecording,
            updateAudioDevice: recordingServiceModule.updateAudioDevice,
            showLoginWindow: () => windowManager.showLoginWindow({
                preloadPath: path.join(__dirname, 'preload.js'),
                loginHtmlPath: path.join(__dirname, 'login.html')
            }),
            toggleSettingsPanel: () => windowManager.toggleSettingsPanel({
                recordingWindow: null, // Should be managed by windowManager
                preloadPath: path.join(__dirname, 'preload.js'),
                settingsHtmlPath: path.join(__dirname, 'settingsPanel.html'),
                screen,
                onHide: () => {}
            }),
            logout: authService.logout
        }); 

    } catch (error) {
        console.error("Critical initialization error:", error);
        dialog.showErrorBox(
            'Initialization Error',
            `Failed to initialize application: ${error.message}`
        );
        app.quit();
    }
    // End of restored code
});

// --- Tray Setup ---

if (process.platform === 'darwin') {
    // On macOS, recreate tray when activating the app
    app.on('activate', () => {
        if (!tray) {
            console.log("No tray detected on activate, recreating...");
            trayManager.initializeTray(getState(), store, {
                startRecording: recordingServiceModule.startRecording,
                stopRecording: recordingServiceModule.stopRecording,
                updateAudioDevice: recordingServiceModule.updateAudioDevice,
                showLoginWindow: () => windowManager.showLoginWindow({
             preloadPath: path.join(__dirname, 'preload.js'),
             loginHtmlPath: path.join(__dirname, 'login.html')
                }),
                toggleSettingsPanel: () => windowManager.toggleSettingsPanel({
                    recordingWindow: null, // Should be managed by windowManager
                    preloadPath: path.join(__dirname, 'preload.js'),
                    settingsHtmlPath: path.join(__dirname, 'settingsPanel.html'),
                    screen,
                    onHide: () => {}
                }),
                logout: authService.logout
            });
        }
    });
}

// --- State Management ---

// Listen for login state changes to handle UI transitions
stateEmitter.on('change', ({ oldState, newState }) => {
    console.log('[stateEmitter] State changed:', { oldState, newState });
    // Delay showing login window after initial session check to avoid flashing
    if (hasCheckedInitialSession && !newState.isLoggedIn && !loginWindowShown && !loginWindowTimeout) {
        loginWindowTimeout = setTimeout(() => {
            if (!getState().isLoggedIn && !loginWindowShown) {
                if (windowManager && windowManager.showLoginWindow) {
                    console.log('[stateEmitter] Not logged in after session check (delayed), showing login window.');
                    windowManager.showLoginWindow({
             preloadPath: path.join(__dirname, 'preload.js'),
             loginHtmlPath: path.join(__dirname, 'login.html')
         });
                    loginWindowShown = true;
                }
            }
            loginWindowTimeout = null;
        }, 150); // 150ms delay
    }
    if (newState.isLoggedIn && !oldState.isLoggedIn) {
        console.log('[stateEmitter] Detected isLoggedIn=true, closing login window.');
        if (windowManager && windowManager.closeLoginWindow) {
            console.log('[stateEmitter] Calling windowManager.closeLoginWindow()');
            windowManager.closeLoginWindow();
        }
        loginWindowShown = false; // Reset for next logout/login cycle
        if (loginWindowTimeout) {
            clearTimeout(loginWindowTimeout);
            loginWindowTimeout = null;
        }
        // Show the dock bar when logged in
        if (windowManager && windowManager.createDockBarWindow) {
            windowManager.createDockBarWindow({
                preloadPath: path.join(__dirname, 'preload.js')
            });
        }
    }
    // Hide the dock bar when logging out
    if (!newState.isLoggedIn && oldState.isLoggedIn) {
        if (global.dockBarWindow && !global.dockBarWindow.isDestroyed()) {
            global.dockBarWindow.close();
            global.dockBarWindow = null;
        }
    }
    // Show recording window only when recording starts
    if (!oldState.isRecording && newState.isRecording) {
        console.log('[stateEmitter] Recording started, showing recording window.');
        if (windowManager && windowManager.ensureRecordingWindow) {
            global.recordingWindow = windowManager.ensureRecordingWindow({
                preloadPath: path.join(__dirname, 'preload.js'),
                recordingHtmlPath: path.join(__dirname, 'recordingWindow.html'),
                state: newState,
                onClose: () => { global.recordingWindow = null; }
            });
            // Always send the current recording state after creating the window
            if (global.recordingWindow && !global.recordingWindow.isDestroyed()) {
                global.recordingWindow.webContents.send('recording-state-change', getState().isRecording);
            }
        }
        // Send recording-state-change to the recording window (redundant, but safe)
        if (global.recordingWindow && !global.recordingWindow.isDestroyed()) {
            console.log('[main.js] Sending recording-state-change: true');
            global.recordingWindow.webContents.send('recording-state-change', true);
        }
    }
    // Hide recording window when recording stops
    if (oldState.isRecording && !newState.isRecording) {
        console.log('[stateEmitter] Recording stopped, hiding recording window.');
        if (windowManager && windowManager.closeRecordingWindow) {
            windowManager.closeRecordingWindow();
        }
        // Send recording-state-change to the recording window
        if (global.recordingWindow && !global.recordingWindow.isDestroyed()) {
            console.log('[main.js] Sending recording-state-change: false');
            global.recordingWindow.webContents.send('recording-state-change', false);
        }
    }
    // Always update the tray menu on state change
    if (trayManager && trayManager.updateTray) {
        console.log('[stateEmitter] Calling trayManager.updateTray() with state:', newState);
        trayManager.updateTray(newState, {
            startRecording: recordingServiceModule.startRecording,
            stopRecording: recordingServiceModule.stopRecording,
            updateAudioDevice: recordingServiceModule.updateAudioDevice,
            showLoginWindow: () => windowManager.showLoginWindow({
                preloadPath: path.join(__dirname, 'preload.js'),
                loginHtmlPath: path.join(__dirname, 'login.html')
            }),
            toggleSettingsPanel: () => windowManager.toggleSettingsPanel({
                recordingWindow: null, // Should be managed by windowManager
                preloadPath: path.join(__dirname, 'preload.js'),
                settingsHtmlPath: path.join(__dirname, 'settingsPanel.html'),
                screen,
                onHide: () => {}
            }),
            logout: authService.logout,
            ensureRecordingWindow: () => {
                global.recordingWindow = windowManager.ensureRecordingWindow({
                    preloadPath: path.join(__dirname, 'preload.js'),
                    recordingHtmlPath: path.join(__dirname, 'recordingWindow.html'),
                    state: getState(),
                    onClose: () => { global.recordingWindow = null; }
                });
                console.log('[main.js] ensureRecordingWindow: global.recordingWindow =', global.recordingWindow);
                if (global.recordingWindow && !global.recordingWindow.isDestroyed()) {
                    global.recordingWindow.webContents.send('recording-state-change', getState().isRecording);
                }
            }
        });
    }
});

// --- Core Functionality (Placeholders) ---

// --- Electron App Lifecycle ---

app.on('ready', async () => {
    console.log(`---> App Ready event FIRED at ${new Date().toISOString()}`);

    // Restore commented out code
    isAppReady = true;
    console.log("App Ready. Initializing...");
    if (process.platform === 'darwin') {
        app.dock.hide();
    }
    try {
        // Initialize Mishi Integration first
        mishiIntegration = mishiServiceModule.initMishiService({
            supabaseUrl: SUPABASE_URL,
            supabaseKey: SUPABASE_SERVICE_ROLE_KEY,
            anonKey: SUPABASE_ANON_KEY,
            webAppUrl: MISHI_WEB_APP_URL
        });
        console.log("Mishi integration initialized successfully");

        // Initialize authService (Supabase client for auth.js)
        authService.initAuth({
            storeInstance: store,
            mishiServiceInstance: mishiIntegration,
            setStateFn: setState,
        });

        // Initialize Supabase Client
        supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
            auth: {
                storage: electronStoreAdapter,
                autoRefreshToken: true,
                persistSession: true,
                detectSessionInUrl: false,
                flowType: 'pkce'
            },
            realtime: {
                params: {
                    eventsPerSecond: 10
                }
            },
            global: {
                headers: {
                    'X-Client-Info': 'mishi-recorder'
                }
            }
        });
        console.log("Supabase client initialized successfully");

        // Initialize the recording service before creating the tray
        console.log('[main.js] Calling recordingServiceModule.initRecordingService');
        recordingServiceModule.initRecordingService({
            store,
            mishiService: mishiIntegration,
            supabase,
            getState,
            setState,
            TEMP_RECORDING_FILENAME
        });

        // Create tray *after* initial setup and checks
        console.log('[main.js] Calling trayManager.initializeTray');
        await trayManager.initializeTray(getState(), store, {
            startRecording: recordingServiceModule.startRecording,
            stopRecording: recordingServiceModule.stopRecording,
            updateAudioDevice: recordingServiceModule.updateAudioDevice,
            showLoginWindow: () => windowManager.showLoginWindow({
                preloadPath: path.join(__dirname, 'preload.js'),
                loginHtmlPath: path.join(__dirname, 'login.html')
            }),
            toggleSettingsPanel: () => windowManager.toggleSettingsPanel({
                recordingWindow: null, // Should be managed by windowManager
                preloadPath: path.join(__dirname, 'preload.js'),
                settingsHtmlPath: path.join(__dirname, 'settingsPanel.html'),
                screen,
                onHide: () => {}
            }),
            logout: authService.logout,
            ensureRecordingWindow: () => {
                global.recordingWindow = windowManager.ensureRecordingWindow({
                    preloadPath: path.join(__dirname, 'preload.js'),
                    recordingHtmlPath: path.join(__dirname, 'recordingWindow.html'),
                    state: getState(),
                    onClose: () => { global.recordingWindow = null; }
                });
                console.log('[main.js] ensureRecordingWindow: global.recordingWindow =', global.recordingWindow);
                if (global.recordingWindow && !global.recordingWindow.isDestroyed()) {
                    global.recordingWindow.webContents.send('recording-state-change', getState().isRecording);
                }
            }
        });

        // Initialize IPC Listeners
        setupIPCHandlers({
            state: getState(),
            getState,
            store,
            audioRecorder,
            tempRecordingPath,
            setState,
            startRecording: recordingServiceModule.startRecording,
            stopRecording: recordingServiceModule.stopRecording,
            cleanupRecording: recordingServiceModule.cleanupRecording,
            recordingWindow,
            settingsWindow,
            createAndShowLoginWindow,
            createSettingsWindow,
            hideSettingsWindow,
            createRecordingWindow: recordingServiceModule.createRecordingWindow,
            updateAudioDevice: recordingServiceModule.updateAudioDevice,
            isStoppingRecording,
            mishiIntegration,
            supabase,
            authService,
        });

        // Set up auth state change listener
        supabase.auth.onAuthStateChange(async (event, session) => {
            // Restore inner logic (or ensure it wasn't commented out)
            console.log('Auth state changed:', {
                event,
                userId: session?.user?.id,
                hasAccessToken: !!session?.access_token,
                timestamp: new Date().toISOString()
            });
            // ... (rest of the auth state logic) ...
        });

        // Skip initial session check if we've already completed setup
        if (!hasCompletedInitialSetup) {
            // Restore inner logic
            const { data: { session }, error } = await supabase.auth.getSession();
            if (error) {
                console.error("Error retrieving session:", error.message);
                setState({ statusMessage: 'Error: Session check failed' });
            } else if (session) {
                console.log("Found existing session");
                setState({
                    isLoggedIn: true,
                    user: session.user,
                    statusMessage: 'Idle'
                });
            } else {
                console.log("No active session found");
                setState({ 
                    isLoggedIn: false, 
                    user: null, 
                    statusMessage: 'Idle'
                });
            }
        }

        setupThemeChangeListener();

        // Create tray *after* other initial setup
        console.log('[Ready Handler End] Attempting tray creation...');
        await trayManager.initializeTray(getState(), store, {
            startRecording: recordingServiceModule.startRecording,
            stopRecording: recordingServiceModule.stopRecording,
            updateAudioDevice: recordingServiceModule.updateAudioDevice,
            showLoginWindow: () => windowManager.showLoginWindow({
                preloadPath: path.join(__dirname, 'preload.js'),
                loginHtmlPath: path.join(__dirname, 'login.html')
            }),
            toggleSettingsPanel: () => windowManager.toggleSettingsPanel({
                recordingWindow: null, // Should be managed by windowManager
                preloadPath: path.join(__dirname, 'preload.js'),
                settingsHtmlPath: path.join(__dirname, 'settingsPanel.html'),
                screen,
                onHide: () => {}
            }),
            logout: authService.logout
        }); 

    } catch (error) {
        console.error("Critical initialization error:", error);
        dialog.showErrorBox(
            'Initialization Error',
            `Failed to initialize application: ${error.message}`
        );
        app.quit();
    }
    // End of restored code
});

// --- IPC Handling (Example if using Login Window) ---

/* Removing unused duplicate IPC handler function
function setupIPCListeners() {
    if (isIPCSetup) {
        console.log('IPC handlers already set up, skipping...');
        return;
    }

    try {
        console.log('Setting up IPC handlers...');
        
        // Handle login
        ipcMain.handle('login', async (event, { email, password }) => {
            console.log('[IPC Login] Attempting login for:', email);
            try {
                // Only perform the sign-in. Let onAuthStateChange handle initialization.
                const { data, error } = await supabase.auth.signInWithPassword({
                    email,
                    password
                });

                if (error) {
                    console.error('[IPC Login] Supabase signIn error:', error);
                    // Return error to renderer
                    return { success: false, error: error.message };
                }

                // If sign-in is successful, onAuthStateChange will fire with SIGNED_IN.
                // We don't need to initialize or set state here.
                console.log('[IPC Login] Supabase signIn successful. Waiting for onAuthStateChange.');
                
                // Indicate success to the renderer, maybe close login window
                if (loginWindow && !loginWindow.isDestroyed()) {
                    setTimeout(() => {
                        loginWindow.close();
                        loginWindow = null;
                    }, 500); 
                }
                return { success: true }; // Report success, but don't change main state here.

            } catch (error) {
                // Catch unexpected errors during the IPC handler execution itself
                console.error('[IPC Login] Unexpected handler error:', error);
                return { success: false, error: error.message || 'An unexpected error occurred during login.' };
            }
        });

        // Handle OAuth login
        ipcMain.handle('oauth-login', async (event, { provider }) => {
            console.log("Initiating Google OAuth flow...");
            
            if (!supabase) {
                console.error("Cannot initiate Google login: Supabase client not initialized");
                return { 
                    success: false, 
                    error: "Authentication service not available. Please try again later." 
                };
            }

            try {
                const { data, error } = await supabase.auth.signInWithOAuth({
                    provider,
                    options: {
                        redirectTo: `${MISHI_WEB_APP_URL}/auth/callback`
                    }
                });

                if (error) throw error;
                if (!data?.url) throw new Error("No authentication URL received");

                // Open OAuth window
                const authWindow = new BrowserWindow({
                    ...OAUTH_CALLBACK_WINDOW_OPTIONS,
                    webPreferences: {
                        ...OAUTH_CALLBACK_WINDOW_OPTIONS.webPreferences,
                        nodeIntegration: false,
                        contextIsolation: true
                    }
                });

                console.log("Opening OAuth window...");
                
                // Load the auth URL
                authWindow.loadURL(data.url);

                // Create a promise that resolves when auth is complete
                return new Promise((resolve, reject) => {
                    // Handle navigation events
                    const handleNavigation = async (event, url) => {
                        // Check if this is our redirect URL
                        if (url.startsWith('https://localhost')) {
                            try {
                                const urlObj = new URL(url);
                                // Get the authorization code or tokens from the URL
                                const params = new URLSearchParams(urlObj.search);
                                const hashParams = new URLSearchParams(urlObj.hash.substring(1));

                                if (params.has('error') || hashParams.has('error')) {
                                    throw new Error(params.get('error_description') || hashParams.get('error_description') || 'OAuth error');
                                }

                                // Close the auth window
                                authWindow.close();
                                resolve({ success: true });
                            } catch (error) {
                                authWindow.close();
                                reject(error);
                            }
                        }
                    };

                    // Set up navigation listener
                    authWindow.webContents.on('will-navigate', handleNavigation);
                    authWindow.webContents.on('will-redirect', handleNavigation);

                    // Handle window close before auth completes
                    authWindow.on('closed', () => {
                        resolve({ success: false, error: 'Authentication window was closed before completion' });
                    });
                });

            } catch (error) {
                console.error("OAuth error:", error);
                return { 
                    success: false, 
                    error: error.message || "Failed to authenticate with Google" 
                };
            }
        });

        isIPCSetup = true;
    } catch (error) {
        console.error("Error setting up IPC handlers:", error);
    }
}
*/

async function updateAudioDevice(newSettings) {
    let oldRecorder = null;
    let newRecorder = null;
    
    try {
        console.log('Updating audio device with settings:', newSettings);
        
        // Store reference to old recorder
        oldRecorder = audioRecorder;
        
        // Stop any active recording first
        if (oldRecorder && oldRecorder.isCurrentlyRecording()) {
            await oldRecorder.stopRecording();
        }

        // Update settings in store
        store.set('inputDevice', newSettings);

        // Clear the reference before creating new one
        audioRecorder = null;

        // Create new instance
        console.log('Creating new audio recorder instance...');
        newRecorder = new AudioRecorder({ inputDevice: newSettings });

        // Test the new recorder
        console.log('Testing new recorder...');
        try {
            await new Promise((resolve, reject) => {
                const timeout = setTimeout(() => {
                    newRecorder.removeAllListeners();
                    reject(new Error('Timeout waiting for recorder initialization'));
                }, 10000); // Increased timeout to 10 seconds

                const cleanup = () => {
                    clearTimeout(timeout);
                    newRecorder.removeListener('ready', readyHandler);
                    newRecorder.removeListener('error', errorHandler);
                };

                const errorHandler = (err) => {
                    cleanup();
                    reject(err);
                };

                const readyHandler = () => {
                    cleanup();
                    resolve();
                };

                newRecorder.once('error', errorHandler);
                newRecorder.once('ready', readyHandler);
            });
        } catch (error) {
            console.error('Recorder test failed:', error);
            if (newRecorder) {
                try {
                    newRecorder.removeAllListeners();
                } catch (cleanupError) {
                    console.error('Error cleaning up failed recorder:', cleanupError);
                }
            }
            throw error;
        }

        // If we get here, the new recorder is working
        console.log('New recorder initialized successfully');
        audioRecorder = newRecorder;

        // Set up event listeners for new recorder
        audioRecorder.on('audioData', (data) => {
            if (recordingWindow && !recordingWindow.isDestroyed()) {
                try {
                    recordingWindow.webContents.send('audio-data', data);
                } catch (err) {
                    console.error('Error sending audio data to window:', err);
                }
            }
        });

        audioRecorder.on('error', (error) => {
            console.error('Audio recorder error:', error);
            dialog.showErrorBox('Audio Error', `Recording error: ${error.message}`);
        });

        // Clean up old recorder after new one is working
        if (oldRecorder) {
            console.log('Cleaning up old recorder...');
            try {
                oldRecorder.removeAllListeners();
            } catch (err) {
                console.error('Error cleaning up old recorder:', err);
            }
            oldRecorder = null;
        }

        // Schedule menu update with retry
        let retryCount = 0;
        const maxRetries = 3;
        const updateMenuWithRetry = async () => {
            try {
                if (!tray || tray.isDestroyed()) {
                    throw new Error('Tray is not available');
                }
                await trayManager.initializeTray(getState(), store, {
                    startRecording: recordingServiceModule.startRecording,
                    stopRecording: recordingServiceModule.stopRecording,
                    updateAudioDevice: recordingServiceModule.updateAudioDevice,
                    showLoginWindow: () => windowManager.showLoginWindow({
                        preloadPath: path.join(__dirname, 'preload.js'),
                        loginHtmlPath: path.join(__dirname, 'login.html')
                    }),
                    toggleSettingsPanel: () => windowManager.toggleSettingsPanel({
                        recordingWindow: null, // Should be managed by windowManager
                        preloadPath: path.join(__dirname, 'preload.js'),
                        settingsHtmlPath: path.join(__dirname, 'settingsPanel.html'),
                        screen,
                        onHide: () => {}
                    }),
                    logout: authService.logout
                });
                console.log('Menu updated successfully');
            } catch (err) {
                console.error(`Error updating menu (attempt ${retryCount + 1}):`, err);
                if (retryCount < maxRetries) {
                    retryCount++;
                    setTimeout(updateMenuWithRetry, 500 * retryCount);
                }
            }
        };

        // Delay the first menu update attempt
        setTimeout(updateMenuWithRetry, 100);

        console.log('Audio device updated successfully:', newSettings.name);
        return true;
    } catch (error) {
        console.error('Failed to update audio device:', error);
        
        // Clean up failed new recorder if it exists
        if (newRecorder) {
            try {
                newRecorder.removeAllListeners();
            } catch (err) {
                console.error('Error cleaning up new recorder:', err);
            }
        }
        
        // Try to restore old recorder if available
        if (oldRecorder && !audioRecorder) {
            console.log('Restoring old recorder...');
            audioRecorder = oldRecorder;
            oldRecorder = null;
        }
        
        dialog.showErrorBox('Device Error', `Failed to update audio device: ${error.message}`);
        return false;
    }
}

// Add a synchronous method to AudioRecorder to list microphones
AudioRecorder.listMicrophonesSync = function() {
    try {
        const { spawnSync } = require('child_process');
        const result = spawnSync('ffmpeg', ['-f', 'avfoundation', '-list_devices', 'true', '-i', '']);
        
        const output = result.stderr.toString();
        const devices = [];
        let isAudioSection = false;
        
        output.split('\n').forEach(line => {
            if (line.includes('AVFoundation audio devices:')) {
                isAudioSection = true;
                return;
            }
            
            if (isAudioSection) {
                const match = line.match(/\[(\d+)\]\s+(.+)/);
                if (match) {
                    devices.push({
                        index: parseInt(match[1]),
                        name: match[2].trim()
                    });
                }
            }
        });
        
        return devices;
    } catch (error) {
        console.error('Error listing microphones:', error);
        return [];
    }
};

// Add audio visualization
let audioVisualizationInterval = null;

function startAudioVisualization() {
    if (audioVisualizationInterval) return;
    
    audioVisualizationInterval = setInterval(() => {
        if (recordingWindow && getState().isRecording) {
            const audioData = audioRecorder.getAudioData();
            recordingWindow.webContents.send('audio-data', audioData);
        }
    }, 50); // Update every 50ms
}

function stopAudioVisualization() {
    if (audioVisualizationInterval) {
        clearInterval(audioVisualizationInterval);
        audioVisualizationInterval = null;
    }
}

// Clean up on app quit
app.on('before-quit', () => {
    stopAudioVisualization();
});

// Add theme change listener
function setupThemeChangeListener() {
    if (process.platform === 'darwin') {
        systemPreferences.subscribeNotification(
            'AppleInterfaceThemeChangedNotification',
            () => {
                const isDark = systemPreferences.isDarkMode();
                if (recordingWindow) {
                    recordingWindow.webContents.send('system-theme-change', isDark);
                }
            }
        );
    }
}

// Add IPC handler for closing the recording window
ipcMain.on('close-recording-window', () => {
    if (recordingWindow && !getState().isRecording) {
        recordingWindow.hide();
    }
});

// Add IPC handler for toggling settings window
ipcMain.on('toggle-settings', () => {
    if (settingsWindow) {
        hideSettingsWindow({ settingsWindow, recordingWindow });
    } else {
        createSettingsWindow({
            recordingWindow,
            preloadPath: path.join(__dirname, 'preload.js'),
            settingsHtmlPath: path.join(__dirname, 'settingsPanel.html'),
            screen,
            onHide: () => { settingsWindow = null; }
        });
        // Update caret button state in recording window
        recordingWindow?.webContents.send('settings-state-change', true);
    }
});

// Add IPC handler for toggling recording window
ipcMain.on('toggle-recording-window', () => {
    if (recordingWindow && recordingWindow.isVisible()) {
        recordingWindow.hide();
    } else {
        recordingServiceModule.createRecordingWindow({
            preloadPath: path.join(__dirname, 'preload.js'),
            recordingHtmlPath: path.join(__dirname, 'recordingWindow.html'),
            state: getState(),
            onClose: () => { recordingWindow = null; }
        });
    }
});

// Add IPC handler for opening login window
ipcMain.on('open-login-window', () => {
    if (loginWindow && !loginWindow.isDestroyed()) {
        loginWindow.focus();
        return;
    }
    createAndShowLoginWindow({
        preloadPath: path.join(__dirname, 'preload.js'),
        loginHtmlPath: path.join(__dirname, 'login.html')
    });
});

app.on('window-all-closed', (event) => {
    // Prevent quitting the app when all windows are closed (for tray-only behavior)
    event.preventDefault();
    // Do not call app.quit() here; keep the app running in the tray
});

authEvents.on('initialSessionChecked', () => {
    hasCheckedInitialSession = true;
});

// Remove previous dockbar-hover and dockbar-leave handlers
// Add dockbar-click handler
ipcMain.on('dockbar-click', () => {
    // Open/focus the floating bar (recording window) first
    function openMeetingOverlayAfterBar() {
        if (global.meetingOverlayWindow && !global.meetingOverlayWindow.isDestroyed()) {
            global.meetingOverlayWindow.focus();
            return;
        }
        if (windowManager && windowManager.createMeetingOverlayWindow) {
            global.meetingOverlayWindow = windowManager.createMeetingOverlayWindow({ company: '', template: '', content: '' });
            if (global.meetingOverlayWindow) {
                global.meetingOverlayWindow.on('closed', () => {
                    global.meetingOverlayWindow = null;
                });
            }
        }
    }

    if (windowManager && windowManager.ensureRecordingWindow) {
        global.recordingWindow = windowManager.ensureRecordingWindow({
            preloadPath: path.join(__dirname, 'preload.js'),
            recordingHtmlPath: path.join(__dirname, 'recordingWindow.html'),
            state: getState(),
            onClose: () => { global.recordingWindow = null; }
        });
        if (global.recordingWindow && !global.recordingWindow.isDestroyed()) {
            global.recordingWindow.show();
            global.recordingWindow.focus();
            global.recordingWindow.webContents.send('recording-state-change', getState().isRecording);
            // Wait for the bar to be ready before opening overlay
            if (global.recordingWindow.isVisible()) {
                openMeetingOverlayAfterBar();
            } else {
                global.recordingWindow.once('show', openMeetingOverlayAfterBar);
            }
        }
    } else {
        // Fallback: just open overlay
        openMeetingOverlayAfterBar();
    }
});

// --- IPC: Fetch companies and meeting templates for meeting dialog ---
/* Commenting out duplicate IPC handlers that are now properly implemented in ipcHandlers.js
ipcMain.handle('get-companies', async (event) => {
    try {
        const state = getState();
        if (!state.user || !state.user.id || !state.workspace || !state.workspace.id) {
            return { success: false, error: 'No user or workspace found' };
        }
        const { data, error } = await supabase
            .from('companies')
            .select('id, name')
            .eq('workspace_id', state.workspace.id)
            .order('name', { ascending: true });
        if (error) return { success: false, error: error.message };
        return { success: true, companies: data };
    } catch (err) {
        return { success: false, error: err.message };
    }
});

ipcMain.handle('get-meeting-templates', async (event) => {
    try {
        const state = getState();
        console.log('[get-meeting-templates] state.user:', state.user);
        console.log('[get-meeting-templates] state.workspace:', state.workspace);
        if (!state.user || !state.user.id || !state.workspace || !state.workspace.id) {
            return { success: false, error: 'No user or workspace found' };
        }
        const { data, error } = await supabase
            .from('meeting_templates')
            .select('id, name, content')
            .eq('workspace_id', state.workspace.id)
            .order('name', { ascending: true });
        console.log('[get-meeting-templates] data:', data, 'error:', error);
        if (error) return { success: false, error: error.message };
        return { success: true, templates: data };
    } catch (err) {
        return { success: false, error: err.message };
    }
});
*/

// Add new IPC handler for 'open-meeting-overlay'
ipcMain.on('open-meeting-overlay', (event, { company, template, content }) => {
    const state = getState();
    if (!state.user || !state.workspace) {
        // Send an error back to the renderer if not logged in or no workspace
        event.sender.send('open-meeting-overlay-error', {
            error: 'You must be logged in and have a workspace to start a meeting.'
        });
        return;
    }
    console.log('[IPC] open-meeting-overlay called with:', { company, template, content });
    if (windowManager && windowManager.createMeetingOverlayWindow) {
        windowManager.createMeetingOverlayWindow({ company, template, content });
    }
});