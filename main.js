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
                type: { type: 'string', enum: ['system', 'mic'], default: 'system' },
                index: { type: 'number', default: 0 }
            },
            default: { type: 'system', index: 0 }
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
    statusMessage: 'Initializing...', // Changed initial status
    user: null,
    currentMeeting: null,
    transcriptionStatus: null
};

// Add recordingWindow to globals
let recordingWindow = null;

// Add settingsWindow to globals
let settingsWindow = null;

// --- Initialization ---

// Add checks for missing environment variables
if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
    console.error("FATAL ERROR: Supabase URL or Anon Key not found in environment variables.");
    console.error("Please ensure you have a .env file with SUPABASE_URL and SUPABASE_ANON_KEY defined.");
    app.quit();
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
        console.log('Auth state changed:', {
            event,
            userId: session?.user?.id,
            hasAccessToken: !!session?.access_token,
            timestamp: new Date().toISOString()
        });

        if (event === 'SIGNED_IN' || event === 'TOKEN_REFRESHED' || event === 'INITIAL_SESSION') {
            try {
                // Get the latest session to ensure we have fresh tokens
                const { data: { session: currentSession }, error: sessionError } = await supabase.auth.getSession();
                if (sessionError) throw sessionError;
                if (!currentSession) throw new Error('No session available after sign in');

                console.log('Initializing with fresh session:', {
                    userId: currentSession.user.id,
                    hasAccessToken: !!currentSession.access_token,
                    hasRefreshToken: !!currentSession.refresh_token,
                    event
                });

                await mishiIntegration.initialize(
                    currentSession.user.id, 
                    currentSession.access_token,
                    currentSession.refresh_token
                );
                console.log('Mishi integration initialized successfully');
                
                setState({ 
                    isLoggedIn: true, 
                    user: currentSession.user, 
                    statusMessage: 'Idle',
                    transcriptionStatus: null,
                    currentMeeting: null
                });
            } catch (error) {
                console.error('Failed to initialize workspace on auth change:', error);
                // Don't set isLoggedIn to true if workspace initialization fails
                setState({ 
                    isLoggedIn: false, 
                    user: null,
                    statusMessage: `Error: ${error.message}`,
                    transcriptionStatus: null,
                    currentMeeting: null
                });
                // Force logout on workspace initialization failure
                try {
                    await supabase.auth.signOut();
                    console.log('Forced sign out after initialization failure');
                } catch (signOutError) {
                    console.error('Error during forced sign out:', signOutError);
                }
            }
        } else if (event === 'SIGNED_OUT') {
            console.log('User signed out, resetting state');
            setState({ 
                isLoggedIn: false, 
                user: null, 
                statusMessage: 'Idle',
                transcriptionStatus: null,
                currentMeeting: null
            });
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
    if (!SUPABASE_ANON_KEY) {
        throw new Error("Supabase anon key not found in environment variables");
    }
    
    mishiIntegration = new MishiIntegration({
        supabaseUrl: SUPABASE_URL,
        supabaseKey: SUPABASE_SERVICE_ROLE_KEY,  // Service role key for admin operations
        anonKey: SUPABASE_ANON_KEY,             // Anon key for user operations
        webAppUrl: MISHI_WEB_APP_URL
    });
    
    console.log("Mishi integration initialized successfully");
} catch (error) {
    console.error("Error initializing Mishi integration:", error.message);
    state.statusMessage = `Error: Mishi init failed - ${error.message}`;
}

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
        
        // Add click handler
        tray.on('click', () => {
            if (recordingWindow && recordingWindow.isVisible()) {
                recordingWindow.hide();
            } else {
                createRecordingWindow();
            }
        });

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

    const inputDevice = store.get('inputDevice');
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
                            label: `Current: ${inputDevice.type === 'mic' ? 'Microphone' : 'System Audio'}`,
                            enabled: false 
                        },
                        { type: 'separator' },
                        { label: 'Select Input...', click: selectAudioInput }
                    ]
                },
                { type: 'separator' }
            );
        }
        menuTemplate.push({ label: 'Logout', click: logout });
    } else {
        menuTemplate.push({ label: 'Login', click: openLoginWindow });
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
    
    // Ensure tray exists before updating menu
    if (!tray) {
        console.log("Tray not available, creating it...");
        createTray();
    }
    
    updateTrayMenu();
    
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
            await mishiIntegration.initialize(
                freshSession.user.id, 
                freshSession.access_token,
                freshSession.refresh_token
            );
            console.log("Mishi integration initialized with workspace after login");
            setState({ isLoggedIn: true, user: freshSession.user, statusMessage: 'Idle' });
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

// Initialize AudioRecorder with settings from store
function initializeAudioRecorder() {
    const settings = {
        inputDevice: store.get('inputDevice') || { type: 'system', index: 0 }
    };

    audioRecorder = new AudioRecorder(settings);

    audioRecorder.on('audioData', (data) => {
        if (recordingWindow && !recordingWindow.isDestroyed()) {
            recordingWindow.webContents.send('audio-data', data);
        }
    });
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

async function stopRecording() {
    try {
        setState({ statusMessage: 'Stopping recording...' });
        
        // Ensure we have an active meeting
        if (!state.currentMeeting) {
            throw new Error('No active meeting session');
        }

        // Stop the recording
        await audioRecorder.stopRecording();
        setState({ isRecording: false });

        // Ensure we have a valid recording path
        if (!tempRecordingPath) {
            throw new Error('Recording path not set');
        }

        // Wait for the file to be fully written
        await new Promise((resolve, reject) => {
            const timeout = setTimeout(() => {
                reject(new Error('Timeout waiting for file to be written'));
            }, 5000);

            const checkFile = async () => {
                try {
                    const stats = await fs.promises.stat(tempRecordingPath);
                    if (stats.size > 0) {
                        // Wait an additional second to ensure FFmpeg has finished writing
                        await new Promise(resolve => setTimeout(resolve, 1000));
                        clearTimeout(timeout);
                        resolve();
                    } else {
                        setTimeout(checkFile, 100);
                    }
                } catch (error) {
                    if (error.code === 'ENOENT') {
                        setTimeout(checkFile, 100);
                    } else {
                        clearTimeout(timeout);
                        reject(error);
                    }
                }
            };

            checkFile();
        });

        // Read the recording file
        const audioBlob = await fs.promises.readFile(tempRecordingPath);
        console.log('Read audio file, size:', audioBlob.length);
        setState({ statusMessage: 'Transcribing...' });

        try {
            // Set up subscription BEFORE sending audio
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

                    // If we have updated meeting data, update state and notify windows
                    if (updatedMeeting) {
                        console.log('[Main] Updating meeting data:', {
                            id: updatedMeeting.id,
                            hasTranscription: !!updatedMeeting.transcription,
                            transcriptionLength: updatedMeeting.transcription?.length || 0
                        });

                        state.currentMeeting = updatedMeeting;
                        
                        // Get all windows that need to be notified
                        const windows = BrowserWindow.getAllWindows();
                        console.log('[Main] Broadcasting update to windows:', windows.length);
                        
                        // Emit meeting update event to all windows
                        windows.forEach(window => {
                            if (!window.isDestroyed()) {
                                console.log('[Main] Sending update to window:', window.getTitle());
                                window.webContents.send('meeting-updated', {
                                    type: 'meeting-updated',
                                    meeting: updatedMeeting
                                });
                            }
                        });
                        
                        // Open the meeting in the web app
                        try {
                            console.log('[Main] Opening meeting in web app');
                            const url = await mishiIntegration.openInWebApp(state.user.id);
                            shell.openExternal(url);
                        } catch (error) {
                            console.error('[Main] Error opening meeting in web app:', error);
                            dialog.showErrorBox('Error', 'Failed to open meeting in web app');
                        }
                    }

                    // Unsubscribe after completion or error
                    if (status === 'completed' || status === 'error') {
                        console.log('[Main] Unsubscribing from updates');
                        subscription();  // Call the cleanup function
                    }
                }
            );

            // Send for transcription with meeting ID
            const response = await mishiIntegration.transcribeAudio(audioBlob, state.currentMeeting.id);

        } catch (transcriptionError) {
            console.error('Transcription error:', transcriptionError);
            setState({ 
                statusMessage: `Error: ${transcriptionError.message}`,
                transcriptionStatus: 'error'
            });
            dialog.showErrorBox('Transcription Error', transcriptionError.message);
        } finally {
            // Cleanup temp file regardless of transcription success/failure
            cleanupTempFile(tempRecordingPath, 'Recording sent for transcription');
        }

    } catch (error) {
        console.error('Failed to stop recording:', error);
        setState({ 
            statusMessage: `Error: ${error.message}`,
            transcriptionStatus: 'error'
        });
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
                await mishiIntegration.initialize(data.user.id, data.session.access_token, data.session.refresh_token);
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
                store.set('inputDevice', {
                    type: 'mic',
                    index: device.index
                });
                updateTrayMenu();
            }
        }));

        // Add system audio option for macOS
        if (process.platform === 'darwin') {
            options.unshift({
                label: 'System Audio (requires BlackHole)',
                click: () => {
                    store.set('inputDevice', {
                        type: 'system',
                        index: 0
                    });
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

// Add function to create recording window
function createRecordingWindow() {
    if (recordingWindow) {
        recordingWindow.show();
        return;
    }

    recordingWindow = new BrowserWindow({
        width: 300,
        height: 72,
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
        type: process.platform === 'darwin' ? 'panel' : 'toolbar',
        titleBarStyle: 'hidden',
        vibrancy: 'menu',
        visualEffectState: 'active'
    });

    recordingWindow.loadFile('recordingWindow.html');

    // Position window at bottom center of screen
    function positionWindow() {
        // Get the display containing the cursor
        const cursorPoint = screen.getCursorScreenPoint();
        const display = screen.getDisplayNearestPoint(cursorPoint);
        const workArea = display.workArea;
        const windowBounds = recordingWindow.getBounds();

        // Calculate position (centered horizontally, fixed distance from bottom)
        const x = Math.round(workArea.x + (workArea.width / 2) - (windowBounds.width / 2));
        const y = Math.round(workArea.y + workArea.height - windowBounds.height - 20); // 20px from bottom

        // Ensure window stays within screen bounds horizontally
        const adjustedX = Math.max(workArea.x, Math.min(x, workArea.x + workArea.width - windowBounds.width));
        
        recordingWindow.setPosition(adjustedX, y);
    }

    recordingWindow.on('ready-to-show', () => {
        positionWindow();
        recordingWindow.show();
        recordingWindow.focus();
    });

    // Reposition window when screen metrics change
    const handleDisplayChange = () => {
        if (recordingWindow && !recordingWindow.isDestroyed()) {
            positionWindow();
        }
    };
    screen.on('display-metrics-changed', handleDisplayChange);
    screen.on('display-added', handleDisplayChange);
    screen.on('display-removed', handleDisplayChange);

    // Clean up event listeners when window is closed
    recordingWindow.on('closed', () => {
        screen.removeListener('display-metrics-changed', handleDisplayChange);
        screen.removeListener('display-added', handleDisplayChange);
        screen.removeListener('display-removed', handleDisplayChange);
        recordingWindow = null;
    });
}

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
        await stopRecording();
        recordingWindow?.webContents.send('recording-state-change', false);
    } catch (error) {
        console.error('Failed to stop recording:', error);
        dialog.showErrorBox('Recording Error', `Failed to stop recording: ${error.message}`);
    }
}); 