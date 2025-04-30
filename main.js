const { app, Tray, Menu, nativeImage, ipcMain, BrowserWindow, shell, dialog } = require('electron');
const path = require('path');
require('dotenv').config(); // Load .env file variables into process.env
const Store = require('electron-store');
const { createClient } = require('@supabase/supabase-js');
const fs = require('fs');
const { google } = require('googleapis');
const { OAuth2Client } = require('google-auth-library');
const AudioRecorder = require('./audioRecorder');
const MishiIntegration = require('./mishiIntegration');

// --- Configuration ---
// Load from environment variables (dotenv will load from .env file)
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const MISHI_WEB_APP_URL = process.env.MISHI_WEB_APP_URL;
const TEMP_RECORDING_FILENAME = 'temp_recording.wav';

// Add this near other constants
const OAUTH_CALLBACK_WINDOW_OPTIONS = {
    width: 1024,
    height: 768,
    webPreferences: {
        nodeIntegration: false,
        contextIsolation: true
    }
};

// --- Globals ---
let tray = null;
let audioRecorder = new AudioRecorder();
let mishiIntegration = null;
let tempRecordingPath = path.join(app.getPath('userData'), TEMP_RECORDING_FILENAME);
const store = new Store(); // Used for storing user session/token

// Add Electron Store adapter for Supabase
const electronStoreAdapter = {
    getItem: (key) => {
        return store.get(key);
    },
    setItem: (key, value) => {
        store.set(key, value);
    },
    removeItem: (key) => {
        store.delete(key);
    },
};

// Add audio settings to electron-store
store.set('audioSettings', store.get('audioSettings', {
    inputDevice: {
        type: 'microphone',  // 'microphone' or 'system'
        index: 0            // Default device index
    },
    processing: {
        noiseReduction: {
            enabled: true,
            nr: 10,
            nf: -25,
            nt: 'w'
        },
        loudnessNorm: {
            enabled: true,
            targetLevel: -16,
            truePeak: -1.5
        },
        compression: {
            enabled: false,
            threshold: -20,
            ratio: 3,
            attack: 0.1,
            release: 0.2
        },
        vad: {
            enabled: false,
            threshold: -30,
            duration: 0.5
        }
    },
    recording: {
        sampleRate: 16000,  // 16kHz as recommended
        format: 'wav'       // WAV format for transcription
    }
}));

let supabase = null;

// Google OAuth2 configuration
const oauth2Client = new OAuth2Client({
    clientId: process.env.GOOGLE_CLIENT_ID,
    clientSecret: process.env.GOOGLE_CLIENT_SECRET,
    // Use a custom protocol handler for desktop apps
    redirectUri: 'https://localhost'  // We'll handle the redirect in the auth window
});

// --- Application State ---
let state = {
    isLoggedIn: false,
    isRecording: false,
    statusMessage: 'Idle', // Idle, Recording, Uploading, Error: <msg>
    user: null,
    currentMeeting: null,
    transcriptionStatus: null
};

// --- Initialization ---

// Add checks for missing environment variables
if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
    console.error("FATAL ERROR: Supabase URL or Anon Key not found in environment variables.");
    console.error("Please ensure you have a .env file with SUPABASE_URL and SUPABASE_ANON_KEY defined.");
    // Optionally: Show a dialog to the user
    // dialog.showErrorBox('Configuration Error', 'Supabase URL or Key missing. Check .env file.');
    app.quit(); // Exit if configuration is missing
    // Throwing error might be better in some cases, but quit is direct here.
}

// Initialize Supabase Client
try {
    if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
        throw new Error("Supabase URL or Anon Key not found in environment variables");
    }
    
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
    
    // Listen for auth state changes
    supabase.auth.onAuthStateChange(async (event, session) => {
        console.log('Auth state changed:', event, session?.user?.id);
        if (event === 'SIGNED_IN' || event === 'TOKEN_REFRESHED') {
            try {
                await mishiIntegration.initialize(session.user.id, session.access_token);
                setState({ isLoggedIn: true, user: session.user, statusMessage: 'Idle' });
            } catch (error) {
                console.error('Failed to initialize workspace on auth change:', error);
                // Don't set isLoggedIn to true if workspace initialization fails
                setState({ 
                    isLoggedIn: false, 
                    user: null,
                    statusMessage: `Error: ${error.message}` 
                });
                // Force logout on workspace initialization failure
                await supabase.auth.signOut();
            }
        } else if (event === 'SIGNED_OUT') {
            setState({ isLoggedIn: false, user: null, statusMessage: 'Idle' });
        }
    });
    
    console.log("Supabase client initialized successfully");
} catch (error) {
    console.error("Error initializing Supabase:", error.message);
    state.statusMessage = `Error: Supabase init failed - ${error.message}`;
}

// Initialize Mishi Integration
try {
    if (!MISHI_WEB_APP_URL) {
        throw new Error("Web App URL not found in environment variables");
    }
    if (!SUPABASE_SERVICE_ROLE_KEY) {
        throw new Error("Supabase service role key not found in environment variables");
    }
    
    mishiIntegration = new MishiIntegration({
        supabaseUrl: SUPABASE_URL,
        supabaseKey: SUPABASE_SERVICE_ROLE_KEY,  // Use service role key for direct DB access
        webAppUrl: MISHI_WEB_APP_URL
    });
    
    console.log("Mishi integration initialized successfully");
} catch (error) {
    console.error("Error initializing Mishi integration:", error.message);
    state.statusMessage = `Error: Mishi init failed - ${error.message}`;
}

// --- Tray Setup ---

function createTray() {
    console.log("Attempting to create tray...");
    // IMPORTANT: Create an 'assets' directory in your project root
    // and place a suitable icon there. Template images are recommended for macOS.
    // Example: assets/iconTemplate.png (black/white image)
    const iconPath = path.join(__dirname, 'assets', 'iconTemplate.png');
    console.log(`Icon path: ${iconPath}`);
    let icon;
    try {
        icon = nativeImage.createFromPath(iconPath);
        console.log(`Icon loaded successfully? ${!icon.isEmpty()}`);
        icon.setTemplateImage(true); // Crucial for macOS dark/light mode compatibility
    } catch (err) {
        console.error("Error loading tray icon:", err);
        // Use a default Electron icon or handle the error
        icon = nativeImage.createEmpty(); // Placeholder
        console.log("Using empty placeholder icon due to error.");
    }


    tray = new Tray(icon);
    console.log(`Tray object created? ${tray ? 'Yes' : 'No'}`);
    tray.setToolTip('Mishi Recorder');
    console.log("Tooltip set.");
    updateTrayMenu(); // Build initial menu
    console.log("Initial tray menu updated.");
}

function updateTrayMenu() {
    if (!tray) return;
    const contextMenu = Menu.buildFromTemplate(buildContextMenuTemplate());
    tray.setContextMenu(contextMenu);
}

function buildContextMenuTemplate() {
    const settings = store.get('audioSettings');
    const menuTemplate = [
        { label: `Status: ${state.statusMessage}`, enabled: false },
    ];

    if (state.currentMeeting) {
        menuTemplate.push(
            { label: `Meeting: ${state.currentMeeting.title}`, enabled: false },
            { label: `Transcription: ${state.transcriptionStatus || 'Not started'}`, enabled: false }
        );
    }

    menuTemplate.push({ type: 'separator' });

    if (state.isLoggedIn) {
        if (state.isRecording) {
            menuTemplate.push({ label: 'Stop Recording', click: stopRecording });
        } else {
            menuTemplate.push(
                { label: 'Start Recording', click: startRecording, enabled: !state.isRecording && state.statusMessage !== 'Uploading' },
                { type: 'separator' },
                { 
                    label: 'Audio Input',
                    submenu: [
                        { 
                            label: `Current: ${settings.inputDevice.type === 'microphone' ? 'Microphone' : 'System Audio'}`,
                            enabled: false 
                        },
                        { type: 'separator' },
                        { label: 'Select Input...', click: selectAudioInput }
                    ]
                },
                { 
                    label: 'Audio Processing',
                    submenu: [
                        { 
                            label: `Noise Reduction: ${settings.processing.noiseReduction.enabled ? 'On' : 'Off'}`,
                            enabled: false 
                        },
                        { 
                            label: `Normalization: ${settings.processing.loudnessNorm.enabled ? 'On' : 'Off'}`,
                            enabled: false 
                        },
                        { type: 'separator' },
                        { label: 'Configure...', click: configureAudioProcessing }
                    ]
                },
                { type: 'separator' }
            );
        }
        menuTemplate.push({ label: 'Logout', click: logout });
    } else {
        menuTemplate.push({ label: 'Login', click: openLoginWindow }); // Or trigger other auth flow
    }

    menuTemplate.push({ type: 'separator' });
    menuTemplate.push({ label: 'Quit', click: quitApp });

    if (state.currentMeeting && state.transcriptionStatus === 'completed') {
        menuTemplate.push(
            { type: 'separator' },
            { label: 'Open in Web App', click: openMeetingInWebApp }
        );
    }

    return menuTemplate;
}

// --- State Management ---

function setState(newState) {
    state = { ...state, ...newState };
    console.log("State updated:", state); // For debugging
    updateTrayMenu(); // Update the menu whenever state changes
}

// --- Core Functionality (Placeholders) ---

function openLoginWindow() {
    console.log("Requesting login window via IPC...");
    // Instead of opening directly, send a message to potentially create/focus it
    // This assumes setupIPCListeners() is called on app ready
    app.emit('open-login-window'); // Use app event emitter or call setupIPCListeners directly first
    // Alternative: Directly call the window creation logic if IPC isn't strictly needed *here*
    // For simplicity now, let's call the IPC handler logic directly
    if (typeof setupIPCListeners === 'function') {
         // This isn't ideal, refactor needed if complex window mgmt arises
         // Find the handler logic for 'open-login-window' if needed
         console.warn("Directly triggering window opening logic - refactor recommended");
         createAndShowLoginWindow(); // Extracted logic below
    } else {
         setState({ statusMessage: 'Error: IPC not setup' });
    }

}

async function fakeLogin() { // Example for testing UI flow without full auth
    console.log("Attempting fake login...");
    setState({ statusMessage: 'Logging in...' });
    await new Promise(resolve => setTimeout(resolve, 1500)); // Simulate network delay
    setState({ isLoggedIn: true, user: { email: 'test@example.com'}, statusMessage: 'Idle' });
    console.log("Fake login successful");
}


async function login(email, password) {
    console.log(`Attempting login for: ${email}`);
    setState({ statusMessage: 'Logging in...' });
    if (!supabase) {
        setState({ statusMessage: 'Error: Supabase not initialized' });
        return { success: false, error: 'Supabase client unavailable.' };
    }
    try {
        const { data, error } = await supabase.auth.signInWithPassword({ email, password });
        if (error) {
            throw error;
        }

        // Initialize Mishi integration with the user's workspace
        try {
            await mishiIntegration.initialize(data.user.id, data.session.access_token);
            console.log("Mishi integration initialized with workspace after login");
            setState({ isLoggedIn: true, user: data.user, statusMessage: 'Idle' });
            return { success: true };
        } catch (mishiError) {
            console.error("Failed to initialize workspace:", mishiError.message);
            setState({ statusMessage: `Error: Failed to initialize workspace - ${mishiError.message}` });
            return { success: false, error: mishiError.message };
        }
    } catch (error) {
        console.error('Login error:', error.message);
        return { success: false, error: error.message };
    }
}

async function logout() {
    console.log("Logging out...");
    setState({ statusMessage: 'Logging out...' });
     if (!supabase) {
         setState({ statusMessage: 'Error: Supabase not initialized' });
         return;
    }
    try {
        const { error } = await supabase.auth.signOut();
        if (error) throw error;
        console.log("Supabase logout successful");
    } catch (error) {
        console.error("Supabase logout failed:", error.message);
        // Still proceed with client-side logout
    } finally {
        // Clear local state regardless of Supabase success/failure
        setState({ isLoggedIn: false, user: null, isRecording: false, statusMessage: 'Idle' });
        // Optionally clear specific items from electron-store if needed,
        // though Supabase client configured with store should handle session clearing.
    }
}

async function startRecording() {
    try {
        if (!state.isLoggedIn) {
            throw new Error('Please log in first');
        }

        const title = await promptForMeetingTitle();
        if (!title) {
            console.log('Recording cancelled - no title provided');
            return;
        }

        // Start a new meeting with the user ID
        const meeting = await mishiIntegration.startRecordingSession(title, state.user.id);
        setState({ 
            isRecording: true, 
            statusMessage: 'Recording...', 
            currentMeeting: meeting 
        });

        // Start recording audio
        await audioRecorder.startRecording(tempRecordingPath);
        updateTrayMenu();
    } catch (error) {
        console.error('Failed to start recording:', error);
        setState({ 
            isRecording: false, 
            statusMessage: `Error: ${error.message}`,
            currentMeeting: null 
        });
        updateTrayMenu();
    }
}

async function stopRecording() {
    try {
        setState({ statusMessage: 'Stopping recording...' });
        const recordingPath = await audioRecorder.stopRecording();
        setState({ isRecording: false });

        // Read the recording file
        const audioBlob = await fs.promises.readFile(recordingPath);
        setState({ statusMessage: 'Transcribing...' });

        // Send for transcription
        await mishiIntegration.transcribeAudio(audioBlob);
        setState({ statusMessage: 'Processing transcription' });

        // Cleanup temp file
        cleanupTempFile(recordingPath, 'Recording sent for transcription');

    } catch (error) {
        console.error('Failed to stop recording:', error);
        setState({ statusMessage: `Error: ${error.message}` });
        dialog.showErrorBox('Recording Error', `Failed to stop recording: ${error.message}`);
    }
}

// Helper function to delete the temporary file
function cleanupTempFile(filePath, reason) {
    if (fs.existsSync(filePath)) {
        fs.unlink(filePath, (err) => {
            if (err) {
                console.error(`Error deleting temp file ${filePath}:`, err);
            } else {
                console.log(`Temporary file ${filePath} deleted successfully (${reason}).`);
            }
        });
    } else {
        console.warn(`Attempted to delete temp file ${filePath}, but it did not exist (${reason}).`);
    }
}

function quitApp() {
    console.log("Quit action triggered...");
    if (audioRecorder.isCurrentlyRecording()) {
        console.log("Attempting to stop recording process before quit...");
        audioRecorder.stopRecording()
            .catch(error => console.error("Error stopping recording during quit:", error))
            .finally(() => app.quit());
    } else {
        app.quit();
    }
}

// --- Electron App Lifecycle ---

app.on('ready', async () => {
    // Hide the dock icon for a Tray-only application
    if (process.platform === 'darwin') {
        app.dock.hide();
    }

    console.log("App Ready. Initializing...");

    // Initialize IPC Listeners if a login window will be used
    setupIPCListeners();

    // Attempt to retrieve the session from storage on startup
    if (supabase) {
        try {
            const { data: { session }, error } = await supabase.auth.getSession();
            console.log("Retrieved session on startup:", session);
            if (error) {
                console.error("Error retrieving session:", error.message);
                setState({ statusMessage: 'Error: Session check failed' });
            } else if (session) {
                console.log("User session found, setting state.");
                // Initialize Mishi integration with the user's workspace
                try {
                    await mishiIntegration.initialize(session.user.id, session.access_token);
                    console.log("Mishi integration initialized with workspace");
                    setState({ isLoggedIn: true, user: session.user, statusMessage: 'Idle' });
                } catch (mishiError) {
                    console.error("Failed to initialize workspace:", mishiError);
                    // Don't set isLoggedIn to false here - the user is still authenticated
                    setState({ 
                        isLoggedIn: true, 
                        user: session.user,
                        statusMessage: `Error: Workspace initialization failed - ${mishiError.message}` 
                    });
                }
            } else {
                console.log("No active session found.");
                setState({ isLoggedIn: false, user: null, statusMessage: 'Idle' });
            }
        } catch(err) {
            console.error("Exception during session retrieval:", err);
            setState({ statusMessage: 'Error: Session check failed' });
        }
    } else {
        console.warn("Supabase client not available for session check.");
        setState({ statusMessage: 'Error: Supabase connection issue' });
    }

    createTray();
});

// Quit when all windows are closed (useful if you add BrowserWindows later)
// For a pure Tray app, this might not be necessary unless you have hidden windows.
app.on('window-all-closed', () => {
    // On macOS it's common for applications and their menu bar
    // to stay active until the user quits explicitly with Cmd + Q
    // However, since this is a Tray app, we might want to quit if all windows ARE closed,
    // assuming windows are only used for transient tasks like login.
    // If you *only* ever have the Tray, this event won't fire unless a window was opened and closed.
    // if (process.platform !== 'darwin') {
    //     app.quit();
    // }
    console.log("Window-all-closed event fired.");
    // Decide if app should quit here based on your window strategy.
});

app.on('activate', () => {
    // On macOS it's common to re-create a window in the app when the
    // dock icon is clicked and there are no other windows open.
    // Not critical for a Tray-only app, but good practice to include.
    // Example: if (BrowserWindow.getAllWindows().length === 0) openLoginWindow();
    console.log("Activate event fired.");
});

// --- IPC Handling (Example if using Login Window) ---

function setupIPCListeners() {
    ipcMain.handle('login', async (event, { email, password }) => {
        console.log('Login attempt for:', email);
        try {
            const { data, error } = await supabase.auth.signInWithPassword({
                email,
                password
            });

            if (error) {
                console.error('Login error:', error);
                return { success: false, error: error.message };
            }

            // Wait for workspace initialization
            try {
                await mishiIntegration.initialize(data.user.id, data.session.access_token);
                return { success: true };
            } catch (error) {
                console.error('Workspace initialization error during login:', error);
                // Force logout
                await supabase.auth.signOut();
                return { success: false, error: `Workspace initialization failed: ${error.message}` };
            }
        } catch (error) {
            console.error('Unexpected login error:', error);
            return { success: false, error: error.message };
        }
    });

    // Listener to open the login window (if not already open)
    let loginWindow = null;
    ipcMain.on('open-login-window', () => {
        if (loginWindow && !loginWindow.isDestroyed()) {
            loginWindow.focus();
            return;
        }
        loginWindow = new BrowserWindow({
            width: 400,
            height: 500,
            webPreferences: {
                // IMPORTANT: Use a preload script for secure IPC
                preload: path.join(__dirname, 'preload.js'),
                contextIsolation: true,
                nodeIntegration: false,
            },
            show: false, // Don't show until ready
            resizable: false,
            maximizable: false,
            fullscreenable: false,
        });

        loginWindow.loadFile('login.html');

        loginWindow.once('ready-to-show', () => {
            loginWindow.show();
        });

        loginWindow.on('closed', () => {
            loginWindow = null;
        });
    });

     // Listener maybe to close the login window upon successful login from main process
    ipcMain.on('close-login-window', () => {
        if (loginWindow && !loginWindow.isDestroyed()) {
            loginWindow.close();
        }
    });

    // Handle Google sign in request
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
                        } catch (err) {
                            console.error('Error processing OAuth response:', err);
                            authWindow.close();
                            reject(err);
                        }
                    }
                };

                authWindow.webContents.on('will-navigate', handleNavigation);
                authWindow.webContents.on('will-redirect', handleNavigation);

                // Handle window closing
                authWindow.on('closed', () => {
                    resolve({ success: false, error: 'Authentication window was closed' });
                });
            });

        } catch (error) {
            console.error('OAuth initiation error:', error);
            return { 
                success: false, 
                error: error.message || "Failed to initialize Google login" 
            };
        }
    });
}

// Extracted logic for creating the window
let loginWindow = null;
function createAndShowLoginWindow() {
    if (loginWindow && !loginWindow.isDestroyed()) {
        loginWindow.focus();
        return;
    }
    loginWindow = new BrowserWindow({
        width: 400,
        height: 600, // Slightly taller to accommodate the Google button
        webPreferences: {
            preload: path.join(__dirname, 'preload.js'),
            contextIsolation: true,
            nodeIntegration: false,
        },
        show: false,
        resizable: false,
        maximizable: false,
        fullscreenable: false,
        title: "Login - Mishi Recorder",
    });

    loginWindow.loadFile(path.join(__dirname, 'login.html'));

    loginWindow.once('ready-to-show', () => {
        loginWindow.show();
    });

    // Listen for successful login to close window
    ipcMain.once('login-success', () => {
        if (loginWindow && !loginWindow.isDestroyed()) {
            loginWindow.close();
        }
    });

    loginWindow.on('closed', () => {
        loginWindow = null;
        // Remove the login-success listener if window is closed without success
        ipcMain.removeAllListeners('login-success');
    });
}

// --- Utility Functions ---
// (Add any helper functions here)


// --- Error Handling ---
process.on('uncaughtException', (error) => {
    console.error('Uncaught Exception:', error);
    // Log this error appropriately
    // Optionally: inform the user via dialog, update Tray status
    setState({ statusMessage: `Error: Critical error occurred` });
    // Consider whether to quit the app on critical errors
});

process.on('unhandledRejection', (reason, promise) => {
    console.error('Unhandled Rejection at:', promise, 'reason:', reason);
    // Log this error
    setState({ statusMessage: `Error: Unhandled promise rejection` });
});


console.log("Main process script loaded.");

// --- Audio Device Management ---
async function selectAudioInput() {
    try {
        const devices = await AudioRecorder.listMicrophones();
        const options = devices.map(device => ({
            label: device.name,
            click: () => {
                const settings = store.get('audioSettings');
                settings.inputDevice = {
                    type: 'microphone',
                    index: device.index
                };
                store.set('audioSettings', settings);
                updateTrayMenu();
            }
        }));

        // Add system audio option for macOS
        if (process.platform === 'darwin') {
            options.unshift({
                label: 'System Audio (requires BlackHole)',
                click: () => {
                    const settings = store.get('audioSettings');
                    settings.inputDevice = {
                        type: 'system',
                        index: 0  // BlackHole index should be configured
                    };
                    store.set('audioSettings', settings);
                    updateTrayMenu();
                }
            });
        }

        const inputMenu = Menu.buildFromTemplate(options);
        inputMenu.popup();
    } catch (error) {
        dialog.showErrorBox('Error', `Failed to list audio devices: ${error.message}`);
    }
}

async function configureAudioProcessing() {
    const settings = store.get('audioSettings');
    const template = [
        {
            label: 'Noise Reduction',
            type: 'checkbox',
            checked: settings.processing.noiseReduction.enabled,
            click: (item) => {
                settings.processing.noiseReduction.enabled = item.checked;
                store.set('audioSettings', settings);
            }
        },
        {
            label: 'Loudness Normalization',
            type: 'checkbox',
            checked: settings.processing.loudnessNorm.enabled,
            click: (item) => {
                settings.processing.loudnessNorm.enabled = item.checked;
                store.set('audioSettings', settings);
            }
        },
        {
            label: 'Voice Activity Detection',
            type: 'checkbox',
            checked: settings.processing.vad.enabled,
            click: (item) => {
                settings.processing.vad.enabled = item.checked;
                store.set('audioSettings', settings);
            }
        }
    ];

    const processingMenu = Menu.buildFromTemplate(template);
    processingMenu.popup();
}

// Add function to prompt for meeting title
async function promptForMeetingTitle() {
    return new Promise((resolve) => {
        const win = new BrowserWindow({
            width: 400,
            height: 200,
            webPreferences: {
                nodeIntegration: true,
                contextIsolation: false
            }
        });

        win.loadFile('meetingTitle.html');

        ipcMain.once('meeting-title-submit', (event, title) => {
            win.close();
            resolve(title);
        });
    });
}

// Add function to open meeting in web app
async function openMeetingInWebApp() {
    try {
        if (!state.currentMeeting) {
            throw new Error('No active meeting');
        }

        const url = await mishiIntegration.openInWebApp(state.user.id);
        shell.openExternal(url);

    } catch (error) {
        console.error('Failed to open meeting:', error);
        dialog.showErrorBox('Error', `Failed to open meeting: ${error.message}`);
    }
} 