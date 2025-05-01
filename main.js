const { app, Tray, Menu, nativeImage, ipcMain, BrowserWindow, shell, dialog, systemPreferences, screen } = require('electron');
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
let audioRecorder = null; // Initialize later with settings
let mishiIntegration = null;
let tempRecordingPath = path.join(app.getPath('userData'), TEMP_RECORDING_FILENAME);
const store = new Store({
    schema: {
        inputDevice: {
            type: 'object',
            properties: {
                type: { type: 'string', enum: ['system', 'mic'], default: 'mic' },
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

// --- Application State ---
let state = {
    isLoggedIn: false,
    isRecording: false,
    statusMessage: 'Starting...',
    user: null,
    transcriptionStatus: null,
    currentMeeting: null,
    workspace: null  // Add workspace info to state
};

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

// --- Initialization ---

// Add checks for missing environment variables
if (!SUPABASE_URL || !SUPABASE_ANON_KEY || !MISHI_WEB_APP_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    console.error("FATAL ERROR: Required environment variables not found.");
    console.error("Please ensure you have a .env file with all required variables defined:");
    console.error("- SUPABASE_URL");
    console.error("- SUPABASE_ANON_KEY");
    console.error("- SUPABASE_SERVICE_ROLE_KEY");
    console.error("- MISHI_WEB_APP_URL");
    app.quit();
}

// --- Electron App Lifecycle ---
app.on('ready', async () => {
    // Set app ready state first
    isAppReady = true;
    console.log("App Ready. Initializing...");

    // Hide the dock icon for a Tray-only application
    if (process.platform === 'darwin') {
        app.dock.hide();
    }

    try {
        // Initialize Mishi Integration first
        mishiIntegration = new MishiIntegration({
            supabaseUrl: SUPABASE_URL,
            supabaseKey: SUPABASE_SERVICE_ROLE_KEY,
            anonKey: SUPABASE_ANON_KEY,
            webAppUrl: MISHI_WEB_APP_URL
        });
        console.log("Mishi integration initialized successfully");

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

        // Create tray before setting up auth listeners
        createTray();
        
        // Initialize AudioRecorder
        initializeAudioRecorder();

        // Initialize IPC Listeners
        setupIPCListeners();

        // Set up auth state change listener
        supabase.auth.onAuthStateChange(async (event, session) => {
            console.log('Auth state changed:', {
                event,
                userId: session?.user?.id,
                hasAccessToken: !!session?.access_token,
                timestamp: new Date().toISOString()
            });

            // Skip if we're already initializing
            if (isInitializing) {
                console.log('Initialization already in progress, skipping...');
                return;
            }

            // Skip redundant token refresh events
            if (event === 'TOKEN_REFRESHED' && lastInitializedUserId === session?.user?.id) {
                console.log('Skipping token refresh for already initialized user');
                return;
            }

            // Skip if we've already completed initial setup and this is a duplicate INITIAL_SESSION
            if (event === 'INITIAL_SESSION' && hasCompletedInitialSetup) {
                console.log('Skipping duplicate initial session, already initialized');
                return;
            }

            if (event === 'SIGNED_IN' || event === 'TOKEN_REFRESHED' || event === 'INITIAL_SESSION') {
                isInitializing = true;
                try {
                    // Get the latest session with timeout
                    console.log('Getting latest session...');
                    const sessionResult = await withTimeout(
                        supabase.auth.getSession(),
                        10000,
                        'Get session'
                    );
                    
                    const currentSession = sessionResult.data?.session;
                    if (!currentSession) {
                        throw new Error('No session available after sign in');
                    }

                    console.log('Initializing with fresh session:', {
                        userId: currentSession.user.id,
                        hasAccessToken: !!currentSession.access_token,
                        hasRefreshToken: !!currentSession.refresh_token,
                        event
                    });

                    // Initialize Mishi with timeout
                    console.log('Initializing Mishi integration...');
                    const workspaceId = await withTimeout(
                        mishiIntegration.initialize(
                            currentSession.user.id, 
                            currentSession.access_token,
                            currentSession.refresh_token
                        ),
                        15000,
                        'Mishi initialization'
                    );

                    // Fetch workspace details with timeout
                    console.log('Fetching workspace details...');
                    const workspaceResult = await withTimeout(
                        supabase
                            .from('workspaces')
                            .select('*')
                            .eq('id', workspaceId)
                            .single(),
                        10000,
                        'Fetch workspace'
                    );

                    if (workspaceResult.error) throw workspaceResult.error;
                    
                    console.log('Initialization complete:', {
                        workspaceName: workspaceResult.data?.name,
                        workspaceId: workspaceResult.data?.id
                    });
                
                    setState({ 
                        isLoggedIn: true, 
                        user: currentSession.user, 
                        statusMessage: 'Idle',
                        transcriptionStatus: null,
                        currentMeeting: null,
                        workspace: workspaceResult.data
                    });

                    // Update initialization tracking
                    lastInitializedUserId = currentSession.user.id;
                    hasCompletedInitialSetup = true;

                } catch (error) {
                    console.error('Failed to initialize workspace on auth change:', {
                        error: error.message,
                        type: error.name,
                        event
                    });

                    // Handle timeout errors specifically
                    const errorMessage = error.message.includes('timed out') 
                        ? 'Connection timed out. Please check your internet connection and try again.'
                        : error.message;

                    setState({ 
                        isLoggedIn: false, 
                        user: null,
                        statusMessage: `Error: ${errorMessage}`,
                        transcriptionStatus: null,
                        currentMeeting: null,
                        workspace: null
                    });

                    // Only force logout if this wasn't a token refresh
                    if (event !== 'TOKEN_REFRESHED') {
                        try {
                            console.log('Forcing sign out after initialization failure...');
                            await withTimeout(
                                supabase.auth.signOut(),
                                5000,
                                'Force sign out'
                            );
                            console.log('Forced sign out completed');
                        } catch (signOutError) {
                            console.error('Error during forced sign out:', signOutError);
                        }
                    }
                } finally {
                    isInitializing = false;
                }
            } else if (event === 'SIGNED_OUT') {
                console.log('User signed out, resetting state');
                lastInitializedUserId = null;
                hasCompletedInitialSetup = false;
                setState({ 
                    isLoggedIn: false, 
                    user: null, 
                    statusMessage: 'Idle',
                    transcriptionStatus: null,
                    currentMeeting: null,
                    workspace: null
                });
            }
        });

        // Skip initial session check if we've already completed setup
        if (!hasCompletedInitialSetup) {
            // Check for existing session
            const { data: { session }, error } = await supabase.auth.getSession();
            if (error) {
                console.error("Error retrieving session:", error.message);
                setState({ statusMessage: 'Error: Session check failed' });
            } else if (session) {
                console.log("Found existing session");
                // Auth state change handler will handle the initialization
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

    } catch (error) {
        console.error("Critical initialization error:", error);
        dialog.showErrorBox(
            'Initialization Error',
            `Failed to initialize application: ${error.message}`
        );
        app.quit();
    }
});

// --- Tray Setup ---

function createTray() {
    if (tray !== null) {
        console.log("Tray already exists, skipping creation");
        return;
    }

    console.log("Creating tray icon...");
    
    // Get the absolute path to the icon
    const iconPath = path.join(__dirname, 'assets', 'iconTemplate.png');
    console.log(`Looking for icon at: ${iconPath}`);
    
    // Verify the icon file exists
    if (!fs.existsSync(iconPath)) {
        console.error(`Icon file not found at ${iconPath}`);
        throw new Error('Tray icon file not found');
    }

    try {
        // Create the icon
        const icon = nativeImage.createFromPath(iconPath);
        
        // Verify the icon was loaded successfully
        if (icon.isEmpty()) {
            console.error("Failed to load icon - nativeImage is empty");
            throw new Error('Failed to load tray icon');
        }

        // Set template image for proper dark/light mode handling on macOS
        if (process.platform === 'darwin') {
            icon.setTemplateImage(true);
        }

        // Create the tray
        tray = new Tray(icon);
        
        // Verify tray was created
        if (!tray) {
            throw new Error('Failed to create tray');
        }

        // Configure tray
        tray.setToolTip('Mishi Recorder');
        
        // Set up initial menu
        updateTrayMenu();
        
        console.log("Tray created successfully");
    } catch (error) {
        console.error("Error creating tray:", error);
        
        // If tray creation failed, try to create a basic tray with a fallback icon
        try {
            console.log("Attempting to create tray with fallback icon...");
            const fallbackIcon = nativeImage.createEmpty();
            tray = new Tray(fallbackIcon);
            tray.setToolTip('Mishi Recorder (Fallback Mode)');
            updateTrayMenu();
            console.log("Created tray with fallback icon");
        } catch (fallbackError) {
            console.error("Critical: Failed to create tray even with fallback:", fallbackError);
            dialog.showErrorBox(
                'Tray Creation Failed',
                'Failed to create application tray icon. The application may not function correctly.'
            );
        }
    }
}

// Add a function to destroy and recreate tray (can be useful for debugging)
function recreateTray() {
    if (tray) {
        console.log("Destroying existing tray...");
        tray.destroy();
        tray = null;
    }
    createTray();
}

// Add tray recreation attempt on certain events
app.on('ready', () => {
    // Existing ready handler code...
    
    // Add a delayed tray creation as fallback
    setTimeout(() => {
        if (!tray) {
            console.log("No tray detected after startup, attempting recreation...");
            createTray();
        }
    }, 1000);
});

if (process.platform === 'darwin') {
    // On macOS, recreate tray when activating the app
    app.on('activate', () => {
        if (!tray) {
            console.log("No tray detected on activate, recreating...");
            createTray();
        }
    });
}

function updateTrayMenu() {
    if (!tray) {
        console.log("Cannot update tray menu - tray not initialized");
        return;
    }

    console.log("Updating tray menu with state:", {
        isLoggedIn: state.isLoggedIn,
        statusMessage: state.statusMessage,
        isRecording: state.isRecording,
        hasCurrentMeeting: !!state.currentMeeting
    });

    const contextMenu = Menu.buildFromTemplate(buildContextMenuTemplate());
    tray.setContextMenu(contextMenu);
}

function buildContextMenuTemplate() {
    console.log("Building menu template with state:", {
        isLoggedIn: state.isLoggedIn,
        statusMessage: state.statusMessage
    });

    const menuTemplate = [];

    if (state.isLoggedIn) {
        // Primary actions
        menuTemplate.push(
            { 
                label: 'Open Web App', 
                click: async () => {
                    try {
                        const url = await mishiIntegration.openInWebApp(state.user.id);
                        shell.openExternal(url);
                    } catch (error) {
                        console.error('Failed to open web app:', error);
                        dialog.showErrorBox('Error', `Failed to open web app: ${error.message}`);
                    }
                }
            },
            { 
                label: 'New Meeting', 
                click: async () => {
                    createRecordingWindow();
                    // Wait for the window to be ready before starting recording
                    if (recordingWindow) {
                        recordingWindow.once('ready-to-show', async () => {
                            await startRecording();
                            recordingWindow?.webContents.send('recording-state-change', true);
                        });
                    }
                }, 
                enabled: !state.isRecording && state.statusMessage !== 'Uploading' 
            },
            { type: 'separator' },
            
            // Settings submenu
            {
                label: 'Settings',
                submenu: [
                    {
                        label: `Current Input: ${store.get('inputDevice').name || 'Default Microphone'}`,
                        enabled: false
                    },
                    { type: 'separator' }
                ]
            }
        );

        // Get available audio devices
        const devices = AudioRecorder.listMicrophonesSync() || [];
        
        // Add system audio option for macOS to the settings submenu
        if (process.platform === 'darwin') {
            menuTemplate[menuTemplate.length - 1].submenu.push({
                label: 'System Audio (requires BlackHole)',
                type: 'radio',
                checked: store.get('inputDevice').type === 'system',
                click: async () => {
                    try {
                        await updateAudioDevice({
                            type: 'system',
                            index: 0,
                            name: 'System Audio'
                        });
                    } catch (error) {
                        console.error('Error selecting system audio:', error);
                        dialog.showErrorBox('Device Selection Error', `Failed to select system audio: ${error.message}`);
                    }
                }
            });
        }

        // Add available microphones to settings submenu
        if (devices.length > 0) {
            devices.forEach(device => {
                menuTemplate[menuTemplate.length - 1].submenu.push({
                    label: device.name,
                    type: 'radio',
                    checked: store.get('inputDevice').type === 'mic' && store.get('inputDevice').index === device.index,
                    click: async () => {
                        try {
                            await updateAudioDevice({
                                type: 'mic',
                                index: device.index,
                                name: device.name
                            });
                        } catch (error) {
                            console.error('Error selecting device:', error);
                            dialog.showErrorBox('Device Selection Error', `Failed to select ${device.name}: ${error.message}`);
                        }
                    }
                });
            });
        } else {
            menuTemplate[menuTemplate.length - 1].submenu.push({
                label: 'No microphones found',
                enabled: false
            });
        }

        // Add separator and logout to settings submenu
        menuTemplate[menuTemplate.length - 1].submenu.push(
            { type: 'separator' },
            { label: 'Log Out', click: logout }
        );

        // Add separator after settings
        menuTemplate.push({ type: 'separator' });

        // User info section
        if (state.user) {
            menuTemplate.push(
                { 
                    label: `${state.user.email}`, 
                    enabled: false,
                    icon: state.user.user_metadata?.avatar_url ? nativeImage.createFromDataURL(state.user.user_metadata.avatar_url).resize({ width: 16, height: 16 }) : null
                }
            );
        }
        if (state.workspace) {
            menuTemplate.push({ 
                label: `Workspace: ${state.workspace.name}`, 
                enabled: false 
            });
        }

        // Final actions
        menuTemplate.push(
            { type: 'separator' },
            { label: 'Quit', click: quitApp }
        );
    } else {
        // Not logged in state
        menuTemplate.push(
            { label: 'Login', click: openLoginWindow },
            { type: 'separator' },
            { label: 'Quit', click: quitApp }
        );
    }

    return menuTemplate;
}

// --- State Management ---

function setState(newState) {
    const oldState = { ...state };
    state = { ...state, ...newState };
    console.log("State changed:", {
        from: {
            isLoggedIn: oldState.isLoggedIn,
            statusMessage: oldState.statusMessage,
            userId: oldState.user?.id
        },
        to: {
            isLoggedIn: state.isLoggedIn,
            statusMessage: state.statusMessage,
            userId: state.user?.id
        }
    });
    
    // Only create/update tray if app is ready
    if (isAppReady) {
        // Ensure tray exists before updating menu
        if (!tray) {
            console.log("Tray not available, creating it...");
            createTray();
        }
        
        updateTrayMenu();
    }
    
    if (state.isRecording) {
        startAudioVisualization();
    } else {
        stopAudioVisualization();
    }
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

        // Get fresh session data immediately after login
        const { data: { session: freshSession }, error: refreshError } = await supabase.auth.getSession();
        if (refreshError) throw refreshError;
        if (!freshSession) throw new Error('No session available after login');

        // Initialize Mishi integration with fresh session
        try {
            const workspaceId = await mishiIntegration.initialize(
                freshSession.user.id, 
                freshSession.access_token,
                freshSession.refresh_token
            );

            // Fetch workspace details
            const { data: workspace, error: workspaceError } = await supabase
                .from('workspaces')
                .select('*')
                .eq('id', workspaceId)
                .single();

            if (workspaceError) throw workspaceError;

            console.log("Mishi integration initialized with workspace after login");
            setState({ 
                isLoggedIn: true, 
                user: freshSession.user, 
                statusMessage: 'Idle',
                workspace: workspace
            });

            // Notify renderer of successful login
            if (loginWindow && !loginWindow.isDestroyed()) {
                loginWindow.webContents.send('login-success');
                // Wait a brief moment before closing to ensure the success message is received
                setTimeout(() => {
                    loginWindow.close();
                    loginWindow = null;
                }, 500);
            }

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
        // Clean up Mishi integration first
        if (mishiIntegration) {
            console.log("Cleaning up Mishi integration...");
            await mishiIntegration.cleanup();
        }

        // Sign out from Supabase with timeout
        console.log("Signing out from Supabase...");
        const signOutPromise = supabase.auth.signOut();
        const timeoutPromise = new Promise((_, reject) => {
            setTimeout(() => reject(new Error('Supabase signOut timed out after 5 seconds')), 5000);
        });

        try {
            const { error } = await Promise.race([signOutPromise, timeoutPromise]);
            if (error) throw error;
            console.log("Supabase logout successful");
        } catch (signOutError) {
            console.error("Supabase signOut error or timeout:", signOutError.message);
            // Continue with cleanup even if signOut times out
        }

        // Clear electron-store
        console.log("Clearing stored session data...");
        store.delete('sb-access-token');
        store.delete('sb-refresh-token');
        
        // Reset Supabase client
        supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
            auth: {
                storage: electronStoreAdapter,
                autoRefreshToken: true,
                persistSession: true,
                detectSessionInUrl: false,
                flowType: 'pkce'
            }
        });

    } catch (error) {
        console.error("Logout failed:", error.message);
        // Still proceed with client-side logout
    } finally {
        // Clear local state regardless of Supabase success/failure
        setState({ 
            isLoggedIn: false, 
            user: null, 
            isRecording: false, 
            statusMessage: 'Idle',
            transcriptionStatus: null,
            currentMeeting: null,
            workspace: null
        });

        // Close any open windows
        BrowserWindow.getAllWindows().forEach(window => {
            if (!window.isDestroyed()) {
                window.close();
            }
        });

        // Update tray menu
        updateTrayMenu();
    }
}

// Initialize AudioRecorder with settings from store
function initializeAudioRecorder() {
    try {
        const settings = {
            inputDevice: store.get('inputDevice') || { type: 'mic', index: 0, name: 'Default Microphone' }
        };
        console.log('Initializing audio recorder with settings:', settings);

        // Clean up existing recorder if it exists
        if (audioRecorder) {
            try {
                audioRecorder.removeAllListeners();
                if (audioRecorder.isCurrentlyRecording()) {
                    audioRecorder.stopRecording().catch(err => {
                        console.error('Error stopping recording during cleanup:', err);
                    });
                }
            } catch (err) {
                console.error('Error cleaning up existing recorder:', err);
            }
        }

        audioRecorder = new AudioRecorder(settings);

        audioRecorder.on('audioData', (data) => {
            try {
                if (recordingWindow && !recordingWindow.isDestroyed()) {
                    recordingWindow.webContents.send('audio-data', data);
                }
            } catch (err) {
                console.error('Error sending audio data to window:', err);
            }
        });

        audioRecorder.on('error', (error) => {
            console.error('Audio recorder error:', error);
            dialog.showErrorBox('Audio Error', `Recording error: ${error.message}`);
        });

        console.log('Audio recorder initialized successfully');
    } catch (error) {
        console.error('Failed to initialize audio recorder:', error);
        dialog.showErrorBox('Initialization Error', `Failed to initialize audio recorder: ${error.message}`);
    }
}

async function startRecording() {
    try {
        if (!state.isLoggedIn) {
            throw new Error('Please log in first');
        }

        // Generate default meeting title with current date
        const today = new Date();
        const month = (today.getMonth() + 1).toString().padStart(2, '0');
        const day = today.getDate().toString().padStart(2, '0');
        const year = today.getFullYear();
        const title = `Meeting ${month}/${day}/${year}`;

        // Ensure temp recording path exists
        if (!tempRecordingPath) {
            tempRecordingPath = path.join(app.getPath('userData'), TEMP_RECORDING_FILENAME);
        }

        // Start a new meeting with the user ID
        const meeting = await mishiIntegration.startRecordingSession(title, state.user.id);
        if (!meeting) {
            throw new Error('Failed to create meeting session');
        }

        // Start recording audio
        await audioRecorder.startRecording(tempRecordingPath);
        
        // Only update state after both operations succeed
        setState({ 
            isRecording: true, 
            statusMessage: 'Recording...', 
            currentMeeting: meeting 
        });
        
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

// Add helper function to delete the temporary file
function cleanupTempFile(filePath, reason) {
    if (!filePath) {
        console.warn('No file path provided for cleanup');
        return;
    }
    
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

// Add cleanup function
function cleanupRecording() {
    console.log('Forcing recording cleanup...');
    
    // Force stop audio recorder
    if (audioRecorder) {
        try {
            audioRecorder.stopRecording().catch(error => {
                // Ignore "No active recording" errors as this is expected in some cases
                if (error.message !== 'No active recording to stop') {
                    console.error('Error force stopping audio recorder:', error);
                }
            });
        } catch (error) {
            // Ignore "No active recording" errors
            if (error.message !== 'No active recording to stop') {
                console.error('Error force stopping audio recorder:', error);
            }
        }
    }

    // Reset state
    setState({ 
        isRecording: false, 
        statusMessage: 'Idle',
        transcriptionStatus: null
    });

    // Update UI
    if (recordingWindow && !recordingWindow.isDestroyed()) {
        recordingWindow.webContents.send('recording-state-change', false);
    }

    // Cleanup temp file
    if (tempRecordingPath) {
        cleanupTempFile(tempRecordingPath, 'Force cleanup');
    }
}

async function stopRecording() {
    // Prevent multiple stop attempts
    if (isStoppingRecording) {
        console.log('Stop recording already in progress...');
        return;
    }

    try {
        isStoppingRecording = true;
        setState({ statusMessage: 'Stopping recording...' });
        
        // Clear any existing timeout
        if (stopRecordingTimeout) {
            clearTimeout(stopRecordingTimeout);
        }

        // Set a timeout to force stop if it takes too long
        stopRecordingTimeout = setTimeout(() => {
            console.warn('Force stopping recording due to timeout...');
            cleanupRecording();
        }, 30000); // 30 second timeout

        // Ensure we have an active meeting
        if (!state.currentMeeting) {
            throw new Error('No active meeting session');
        }

        // Stop the recording
        if (!audioRecorder) {
            throw new Error('Audio recorder not initialized');
        }

        console.log('Stopping audio recording...');
        await audioRecorder.stopRecording();
        setState({ isRecording: false });

        // Ensure we have a valid recording path
        if (!tempRecordingPath) {
            throw new Error('Recording path not set');
        }

        console.log('Waiting for file to be written...');
        // Wait for the file to be fully written
        await new Promise((resolve, reject) => {
            let attempts = 0;
            const maxAttempts = 50; // 5 seconds total (50 * 100ms)
            
            const checkFile = async () => {
                try {
                    console.log('Checking file status...');
                    const stats = await fs.promises.stat(tempRecordingPath);
                    console.log(`File size: ${stats.size} bytes`);
                    
                    if (stats.size > 0) {
                        console.log('File write complete, proceeding with transcription...');
                        // Wait an additional second to ensure FFmpeg has finished writing
                        await new Promise(resolve => setTimeout(resolve, 1000));
                        resolve();
                        return;
                    }
                    
                    attempts++;
                    if (attempts >= maxAttempts) {
                        reject(new Error('Timeout waiting for file to be written after max attempts'));
                        return;
                    }
                    
                    setTimeout(checkFile, 100);
                } catch (error) {
                    console.error('Error checking file:', error);
                    if (error.code === 'ENOENT') {
                        attempts++;
                        if (attempts >= maxAttempts) {
                            reject(new Error('File not found after max attempts'));
                            return;
                        }
                        setTimeout(checkFile, 100);
                    } else {
                        reject(error);
                    }
                }
            };

            checkFile();
        });

        // Check authentication before proceeding with transcription
        console.log('Checking authentication...');
        const authCheckPromise = supabase.auth.getSession();
        const authTimeout = new Promise((_, reject) => {
            setTimeout(() => reject(new Error('Authentication check timed out after 5 seconds')), 5000);
        });

        try {
            const { data: { session }, error: sessionError } = await Promise.race([
                authCheckPromise,
                authTimeout
            ]);

            if (sessionError) {
                throw sessionError;
            }

            if (!session) {
                throw new Error('No valid authentication session');
            }

            // Try to refresh the session if we have one
            console.log('Refreshing authentication session...');
            const { data: { session: refreshedSession }, error: refreshError } = await supabase.auth.refreshSession();
            
            if (refreshError) {
                throw refreshError;
            }

            if (!refreshedSession) {
                throw new Error('Session refresh failed');
            }

            // Read the recording file
            console.log('Reading audio file...');
            const audioBlob = await fs.promises.readFile(tempRecordingPath);
            console.log('Read audio file, size:', audioBlob.length);
            
            // Clear the timeout since we've successfully read the file
            if (stopRecordingTimeout) {
                clearTimeout(stopRecordingTimeout);
                stopRecordingTimeout = null;
            }
            
            setState({ statusMessage: 'Transcribing...' });

            try {
                // Set up subscription BEFORE sending audio
                console.log('Setting up transcription subscription...');
                const subscription = mishiIntegration.subscribeToTranscriptionStatus(
                    state.currentMeeting.id,
                    async (status, updatedMeeting) => {
                        console.log('[Main] Transcription status update:', {
                            status,
                            hasMeetingData: !!updatedMeeting,
                            meetingId: updatedMeeting?.id
                        });
                        
                        setState({
                            transcriptionStatus: status,
                            statusMessage: status === 'completed' 
                                ? 'Transcription completed' 
                                : status === 'error' 
                                ? 'Transcription failed' 
                                : `Processing transcription (${status})`
                        });

                        if (updatedMeeting) {
                            state.currentMeeting = updatedMeeting;
                            
                            // Notify windows of update
                            BrowserWindow.getAllWindows().forEach(window => {
                                if (!window.isDestroyed()) {
                                    window.webContents.send('meeting-updated', {
                                        type: 'meeting-updated',
                                        meeting: updatedMeeting
                                    });
                                }
                            });
                            
                            // Open in web app if completed
                            if (status === 'completed') {
                                try {
                                    const url = await mishiIntegration.openInWebApp(state.user.id);
                                    shell.openExternal(url);
                                } catch (error) {
                                    console.error('[Main] Error opening meeting in web app:', error);
                                }
                            }
                        }

                        // Unsubscribe after completion or error
                        if (status === 'completed' || status === 'error') {
                            subscription();
                        }
                    }
                );

                // Send for transcription
                console.log('Sending audio for transcription...');
                await mishiIntegration.transcribeAudio(audioBlob, state.currentMeeting.id);
                console.log('Audio sent for transcription successfully');

                // Only clean up the temp file after transcription is initiated
                cleanupTempFile(tempRecordingPath, 'Recording sent for transcription');

            } catch (transcriptionError) {
                console.error('Transcription error:', transcriptionError);
                setState({ 
                    statusMessage: `Error: ${transcriptionError.message}`,
                    transcriptionStatus: 'error'
                });
                
                // Only show dialog for non-auth errors (auth errors are handled elsewhere)
                if (!transcriptionError.message.includes('authentication')) {
                    dialog.showErrorBox('Transcription Error', transcriptionError.message);
                }

                // Clean up on transcription error
                cleanupTempFile(tempRecordingPath, 'Transcription error cleanup');
            }

        } catch (error) {
            console.error('Transcription error:', error);
            setState({ 
                statusMessage: `Error: ${error.message}`,
                transcriptionStatus: 'error'
            });
            
            // Only show dialog for non-auth errors
            if (!error.message.includes('authentication')) {
                dialog.showErrorBox('Recording Error', `Failed to stop recording: ${error.message}`);
            }
            
            cleanupRecording();
        }

    } catch (error) {
        console.error('Failed to stop recording:', error);
        setState({ 
            statusMessage: `Error: ${error.message}`,
            transcriptionStatus: 'error'
        });
        
        // Only show dialog for non-auth errors
        if (!error.message.includes('authentication')) {
            dialog.showErrorBox('Recording Error', `Failed to stop recording: ${error.message}`);
        }
        
        cleanupRecording();
    } finally {
        if (stopRecordingTimeout) {
            clearTimeout(stopRecordingTimeout);
            stopRecordingTimeout = null;
        }
        isStoppingRecording = false;
    }
}

function quitApp() {
    console.log("Quit action triggered...");
    if (audioRecorder.isCurrentlyRecording()) {
        console.log("Attempting to stop recording process before quit...");
        audioRecorder.stopRecording()
            .catch(error => console.error("Error stopping recording during quit:", error))
            .finally(() => {
                if (mishiIntegration) {
                    console.log("Cleaning up Mishi integration...");
                    mishiIntegration.cleanup();
                }
                app.quit();
            });
    } else {
        if (mishiIntegration) {
            console.log("Cleaning up Mishi integration...");
            mishiIntegration.cleanup();
        }
        app.quit();
    }
}

// --- Electron App Lifecycle ---

app.on('ready', async () => {
    // Set app ready state
    isAppReady = true;

    // Hide the dock icon for a Tray-only application
    if (process.platform === 'darwin') {
        app.dock.hide();
    }

    console.log("App Ready. Initializing...");

    // Initialize AudioRecorder
    initializeAudioRecorder();

    // Initialize IPC Listeners if a login window will be used
    setupIPCListeners();

    // Create tray first to ensure it exists
    createTray();

    // Attempt to retrieve the session from storage on startup
    if (supabase) {
        try {
            const { data: { session }, error } = await supabase.auth.getSession();
            console.log("Retrieved session on startup:", {
                hasSession: !!session,
                hasAccessToken: session?.access_token,
                hasRefreshToken: session?.refresh_token
            });
            
            if (error) {
                console.error("Error retrieving session:", error.message);
                setState({ statusMessage: 'Error: Session check failed' });
                return;
            }

            if (session) {
                console.log("User session found, setting state.");
                // Get fresh session data
                const { data: { session: freshSession }, error: refreshError } = await supabase.auth.refreshSession();
                if (refreshError) {
                    console.error("Error refreshing session:", refreshError);
                    setState({ statusMessage: 'Error: Session refresh failed' });
                    return;
                }
                if (!freshSession) {
                    console.log("No fresh session available after refresh.");
                    setState({ isLoggedIn: false, user: null, statusMessage: 'Idle' });
                    return;
                }

                // Initialize Mishi integration with fresh session
                try {
                    await mishiIntegration.initialize(
                        freshSession.user.id, 
                        freshSession.access_token,
                        freshSession.refresh_token
                    );
                    console.log("Mishi integration initialized with workspace");
                    setState({ 
                        isLoggedIn: true, 
                        user: freshSession.user, 
                        statusMessage: 'Idle',
                        transcriptionStatus: null,
                        currentMeeting: null
                    });
                } catch (mishiError) {
                    console.error("Failed to initialize workspace:", mishiError);
                    setState({ 
                        isLoggedIn: false,  // Changed to false since workspace init failed
                        user: null,
                        statusMessage: `Error: Workspace initialization failed - ${mishiError.message}`,
                        transcriptionStatus: null,
                        currentMeeting: null
                    });
                }
            } else {
                console.log("No active session found.");
                setState({ 
                    isLoggedIn: false, 
                    user: null, 
                    statusMessage: 'Idle',
                    transcriptionStatus: null,
                    currentMeeting: null
                });
            }
        } catch(err) {
            console.error("Exception during session retrieval:", err);
            setState({ 
                statusMessage: 'Error: Session check failed',
                isLoggedIn: false,
                user: null,
                transcriptionStatus: null,
                currentMeeting: null
            });
        }
    } else {
        console.warn("Supabase client not available for session check.");
        setState({ 
            statusMessage: 'Error: Supabase connection issue',
            isLoggedIn: false,
            user: null,
            transcriptionStatus: null,
            currentMeeting: null
        });
    }

    setupThemeChangeListener();
});

// Quit when all windows are closed (useful if you add BrowserWindows later)
// For a pure Tray app, this might not be necessary unless you have hidden windows.
// app.on('window-all-closed', () => {
//     // On macOS it's common for applications and their menu bar
//     // to stay active until the user quits explicitly with Cmd + Q
//     // However, since this is a Tray app, we might want to quit if all windows ARE closed,
//     // assuming windows are only used for transient tasks like login.
//     // If you *only* ever have the Tray, this event won't fire unless a window was opened and closed.
//     // if (process.platform !== 'darwin') {
//     //     app.quit();
//     // }
//     console.log("Window-all-closed event fired.");
//     // Decide if app should quit here based on your window strategy.
// });

app.on('activate', () => {
    // On macOS it's common to re-create a window in the app when the
    // dock icon is clicked and there are no other windows open.
    // Not critical for a Tray-only app, but good practice to include.
    // Example: if (BrowserWindow.getAllWindows().length === 0) openLoginWindow();
    console.log("Activate event fired.");
});

// --- IPC Handling (Example if using Login Window) ---

function setupIPCListeners() {
    if (isIPCSetup) {
        console.log('IPC handlers already set up, skipping...');
        return;
    }

    try {
        console.log('Setting up IPC handlers...');
        
        // Handle login
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
                    const workspaceId = await mishiIntegration.initialize(
                        data.user.id, 
                        data.session.access_token, 
                        data.session.refresh_token
                    );

                    // Fetch workspace details
                    const { data: workspace, error: workspaceError } = await supabase
                        .from('workspaces')
                        .select('*')
                        .eq('id', workspaceId)
                        .single();

                    if (workspaceError) throw workspaceError;

                    // Update state with user and workspace info
                    setState({ 
                        isLoggedIn: true, 
                        user: data.user,
                        statusMessage: 'Idle',
                        workspace: workspace
                    });

                    // Close login window after successful login
                    if (loginWindow && !loginWindow.isDestroyed()) {
                        setTimeout(() => {
                            loginWindow.close();
                            loginWindow = null;
                        }, 500);
                    }

                    return { success: true };
                } catch (error) {
                    console.error('Workspace initialization error during login:', error);
                    // Force logout on workspace init failure
                    await supabase.auth.signOut();
                    return { success: false, error: `Workspace initialization failed: ${error.message}` };
                }
            } catch (error) {
                console.error('Unexpected login error:', error);
                return { success: false, error: error.message };
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

        // Other IPC handlers...
        ipcMain.on('close-login-window', () => {
            if (loginWindow && !loginWindow.isDestroyed()) {
                loginWindow.close();
            }
        });

        ipcMain.on('stop-recording', async () => {
            try {
                // Check if we're already in the process of stopping
                if (isStoppingRecording) {
                    console.log('Stop recording already in progress, ignoring duplicate request');
                    return;
                }

                // Check if we're actually recording
                if (!state.isRecording) {
                    console.log('No active recording to stop');
                    // Still update UI just in case it's out of sync
                    recordingWindow?.webContents.send('recording-state-change', false);
                    return;
                }

                await stopRecording();
            } catch (error) {
                console.error('Failed to stop recording:', error);
                dialog.showErrorBox('Recording Error', `Failed to stop recording: ${error.message}`);
                // Force cleanup on error
                cleanupRecording();
            }
        });

        // Mark IPC as set up
        isIPCSetup = true;
        console.log('IPC handlers set up successfully');

    } catch (error) {
        console.error('Error setting up IPC handlers:', error);
        dialog.showErrorBox(
            'Initialization Error',
            `Failed to set up application handlers: ${error.message}`
        );
    }
}

// Extracted logic for creating the window
let loginWindow = null;
function createAndShowLoginWindow() {
    try {
        if (loginWindow && !loginWindow.isDestroyed()) {
            loginWindow.focus();
            return;
        }

        loginWindow = new BrowserWindow({
            width: 400,
            height: 600,
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

        loginWindow.loadFile(path.join(__dirname, 'login.html'))
            .catch(error => {
                console.error('Failed to load login window:', error);
                dialog.showErrorBox('Login Error', 'Failed to open login window. Please try again.');
                if (loginWindow && !loginWindow.isDestroyed()) {
                    loginWindow.close();
                }
                loginWindow = null;
            });

        loginWindow.once('ready-to-show', () => {
            loginWindow.show();
        });

        // Handle window close
        loginWindow.on('close', () => {
            // Clean up any remaining IPC handlers
            ipcMain.removeHandler('login');
            loginWindow = null;
        });

    } catch (error) {
        console.error('Error creating login window:', error);
        dialog.showErrorBox('Login Error', 'Failed to create login window. Please try again.');
        loginWindow = null;
    }
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
                await updateTrayMenu();
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
        if (recordingWindow && state.isRecording) {
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
    if (recordingWindow && !state.isRecording) {
        recordingWindow.hide();
    }
});

// Function to hide settings window with animation
function hideSettingsWindow() {
    if (!settingsWindow) return;
    
    // Update caret button state in recording window
    recordingWindow?.webContents.send('settings-state-change', false);
    
    // Trigger hide animation
    settingsWindow.webContents.send('before-hide');
    
    // Wait for animation to complete
    setTimeout(() => {
        if (settingsWindow) {
            settingsWindow.hide();
        }
    }, 150); // Match the animation duration
}

// Add function to create settings window
function createSettingsWindow() {
    // Don't create if recording window doesn't exist
    if (!recordingWindow) return;
    
    if (settingsWindow) {
        settingsWindow.show();
        return;
    }

    settingsWindow = new BrowserWindow({
        width: 300,
        height: 400,
        frame: false,
        transparent: true,
        resizable: false,
        skipTaskbar: true,
        alwaysOnTop: true,
        hasShadow: true,
        webPreferences: {
            preload: path.join(__dirname, 'preload.js'),
            contextIsolation: true,
            nodeIntegration: false,
        },
        show: false,
        type: 'panel',
        vibrancy: 'menu',
        parent: recordingWindow, // Make recording window the parent
    });

    settingsWindow.loadFile('settingsPanel.html');

    // Position window above recording window
    function positionWindow() {
        if (!recordingWindow || recordingWindow.isDestroyed()) {
            settingsWindow?.close();
            return;
        }

        const recordingBounds = recordingWindow.getBounds();
        const settingsBounds = settingsWindow.getBounds();
        
        // Center horizontally relative to recording window
        const x = Math.round(recordingBounds.x + (recordingBounds.width / 2) - (settingsBounds.width / 2));
        
        // Position above recording window with 8px gap (matching the arrow)
        const y = Math.round(recordingBounds.y - settingsBounds.height - 8);

        // Get the display where the recording window is located
        const display = screen.getDisplayNearestPoint({
            x: recordingBounds.x,
            y: recordingBounds.y
        });
        const workArea = display.workArea;

        // Ensure window stays within screen bounds
        const adjustedX = Math.max(workArea.x, Math.min(x, workArea.x + workArea.width - settingsBounds.width));
        const adjustedY = Math.max(workArea.y, Math.min(y, workArea.y + workArea.height - settingsBounds.height));

        settingsWindow.setPosition(adjustedX, adjustedY);
    }

    settingsWindow.once('ready-to-show', () => {
        positionWindow();
        settingsWindow.show();
        settingsWindow.focus();
    });

    // Hide settings when recording window moves
    recordingWindow.on('move', () => {
        positionWindow();
    });

    // Hide settings when recording window is hidden
    recordingWindow.on('hide', () => {
        settingsWindow?.hide();
    });

    settingsWindow.on('blur', () => {
        if (!recordingWindow?.isFocused()) {
            hideSettingsWindow();
        }
    });

    settingsWindow.on('hide', () => {
        if (settingsWindow) {
            settingsWindow.destroy();
        }
        settingsWindow = null;
    });
}

// Add IPC handlers for settings
ipcMain.handle('get-settings', () => {
    return store.store;
});

ipcMain.handle('update-settings', (_, changes) => {
    // Deep merge changes with existing settings
    const mergeChanges = (target, source) => {
        Object.keys(source).forEach(key => {
            if (source[key] && typeof source[key] === 'object') {
                if (!target[key]) Object.assign(target, { [key]: {} });
                mergeChanges(target[key], source[key]);
            } else {
                Object.assign(target, { [key]: source[key] });
            }
        });
    };

    const currentSettings = store.store;
    mergeChanges(currentSettings, changes);
    store.store = currentSettings;

    // Notify all windows about the settings change
    if (recordingWindow) {
        recordingWindow.webContents.send('settings-change', store.store);
    }
    if (settingsWindow) {
        settingsWindow.webContents.send('settings-change', store.store);
    }

    return store.store;
});

// Add IPC handler for toggling settings window
ipcMain.on('toggle-settings', () => {
    if (settingsWindow) {
        hideSettingsWindow();
    } else {
        createSettingsWindow();
        // Update caret button state in recording window
        recordingWindow?.webContents.send('settings-state-change', true);
    }
});

// Remove or update the existing open-settings handler
ipcMain.on('open-settings', () => {
    if (!settingsWindow) {
        createSettingsWindow();
    }
});

// Add IPC handler for toggling recording window
ipcMain.on('toggle-recording-window', () => {
    if (recordingWindow && recordingWindow.isVisible()) {
        recordingWindow.hide();
    } else {
        createRecordingWindow();
    }
});

// Add IPC handlers for recording
ipcMain.on('start-recording', async () => {
    try {
        await audioRecorder.startRecording(tempRecordingPath);
        setState({ isRecording: true, statusMessage: 'Recording...' });
        recordingWindow?.webContents.send('recording-state-change', true);
    } catch (error) {
        console.error('Failed to start recording:', error);
        dialog.showErrorBox('Recording Error', `Failed to start recording: ${error.message}`);
    }
});

ipcMain.on('stop-recording', async () => {
    try {
        // Check if we're already in the process of stopping
        if (isStoppingRecording) {
            console.log('Stop recording already in progress, ignoring duplicate request');
            return;
        }

        // Check if we're actually recording
        if (!state.isRecording) {
            console.log('No active recording to stop');
            // Still update UI just in case it's out of sync
            recordingWindow?.webContents.send('recording-state-change', false);
            return;
        }

        await stopRecording();
    } catch (error) {
        console.error('Failed to stop recording:', error);
        dialog.showErrorBox('Recording Error', `Failed to stop recording: ${error.message}`);
        // Force cleanup on error
        cleanupRecording();
    }
});

// Add IPC handler for opening login window
ipcMain.on('open-login-window', () => {
    if (loginWindow && !loginWindow.isDestroyed()) {
        loginWindow.focus();
        return;
    }
    createAndShowLoginWindow();
});

// Add timeout helper at the top level
function withTimeout(promise, timeoutMs, operation) {
    const timeout = new Promise((_, reject) => {
        setTimeout(() => reject(new Error(`${operation} timed out after ${timeoutMs}ms`)), timeoutMs);
    });
    return Promise.race([promise, timeout]);
} 