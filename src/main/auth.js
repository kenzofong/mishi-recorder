// Authentication and Supabase client setup
const { createClient } = require('@supabase/supabase-js');
const { OAuth2Client } = require('google-auth-library');
const { ipcMain } = require('electron');
const Store = require('electron-store');
const { SUPABASE_URL, SUPABASE_ANON_KEY, MISHI_WEB_APP_URL } = require('./config');
const EventEmitter = require('events');

let supabase = null;
let store = null;
let mishiService = null;
let setState = null;

// Electron-store adapter for Supabase
let electronStoreAdapter = null;

const authEvents = new EventEmitter();

function initAuth({ storeInstance, mishiServiceInstance, setStateFn }) {
    store = storeInstance;
    mishiService = mishiServiceInstance;
    setState = setStateFn;

    electronStoreAdapter = {
        getItem: (key) => {
            const value = store.get(key);
            console.log('[electronStoreAdapter] getItem:', key, value);
            return value;
        },
        setItem: (key, value) => {
            console.log('[electronStoreAdapter] setItem:', key, value);
            store.set(key, value);
        },
        removeItem: (key) => {
            console.log('[electronStoreAdapter] removeItem:', key);
            store.delete(key);
        },
    };

    supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
        auth: {
            storage: electronStoreAdapter,
            autoRefreshToken: true,
            persistSession: true,
            detectSessionInUrl: false,
            flowType: 'pkce',
        },
        realtime: {
            params: { eventsPerSecond: 10 },
        },
        global: {
            headers: { 'X-Client-Info': 'mishi-recorder' },
        },
    });

    // Auth state change listener
    supabase.auth.onAuthStateChange(async (event, session) => {
        if (event === 'INITIAL_SESSION') {
            authEvents.emit('initialSessionChecked');
        }
        try {
            if ((event === 'SIGNED_IN' || event === 'INITIAL_SESSION') && session) {
                // Initialize workspace with Mishi
                const workspaceId = await mishiService.initialize(
                    session.user.id,
                    session.access_token,
                    session.refresh_token
                );
                // Fetch workspace details
                const { data: workspace, error: workspaceError } = await supabase
                    .from('workspaces')
                    .select('*')
                    .eq('id', workspaceId)
                    .single();
                if (workspaceError) throw workspaceError;
                setState({
                    isLoggedIn: true,
                    user: session.user,
                    statusMessage: 'Idle',
                    workspace,
                });
            } else if (event === 'SIGNED_OUT') {
                setState({
                    isLoggedIn: false,
                    user: null,
                    statusMessage: 'Idle',
                    workspace: null,
                });
            }
        } catch (err) {
            setState({ statusMessage: `Auth error: ${err.message}` });
        }
    });
}

// Login function
async function login(email, password) {
    if (!supabase) throw new Error('Supabase not initialized');
    setState({ statusMessage: 'Logging in...' });
    const { data, error } = await supabase.auth.signInWithPassword({ email, password });
    if (error) {
        setState({ statusMessage: `Login error: ${error.message}` });
        return { success: false, error: error.message };
    }
    // onAuthStateChange will handle state update
    return { success: true };
}

// Logout function
async function logout() {
    if (!supabase) throw new Error('Supabase not initialized');
    setState({ statusMessage: 'Logging out...' });
    try {
        await mishiService.cleanup();
    } catch {}
    try {
        await supabase.auth.signOut();
    } catch (error) {
        setState({ statusMessage: `Logout error: ${error.message}` });
    }
    // onAuthStateChange will handle state update
}

// Set up auth state change listener
function setupAuthStateListener(onStateChange) {
    // Returns the unsubscribe function
    return supabase.auth.onAuthStateChange(onStateChange);
}

async function checkInitialSession() {
    if (!supabase) throw new Error('Supabase not initialized');
    const { data: { session }, error } = await supabase.auth.getSession();
    if (error) {
        setState({ statusMessage: 'Error: Session check failed' });
    } else if (session) {
        // Already signed in, handled by onAuthStateChange
    } else {
        setState({ isLoggedIn: false, user: null, statusMessage: 'Idle' });
    }
}

// Handler for OAuth login (to be registered by ipcHandlers)
async function handleOAuthLogin(event, { provider }) {
    if (!supabase) return { success: false, error: 'Supabase not initialized' };
    try {
        const { data, error } = await supabase.auth.signInWithOAuth({
            provider,
            options: { redirectTo: `${MISHI_WEB_APP_URL}/auth/callback` },
        });
        if (error) throw error;
        if (!data?.url) throw new Error('No authentication URL received');
        return { success: true, url: data.url };
    } catch (error) {
        return { success: false, error: error.message };
    }
}

module.exports = {
    initAuth,
    supabase: () => supabase,
    login,
    logout,
    setupAuthStateListener,
    checkInitialSession,
    handleOAuthLogin,
    authEvents,
};
