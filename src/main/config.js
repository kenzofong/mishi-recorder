// Configuration and environment variable loading for Electron main process
const path = require('path');
const fs = require('fs');
require('dotenv').config(); // Load .env if present

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const MISHI_WEB_APP_URL = process.env.MISHI_WEB_APP_URL;
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;
const TEMP_RECORDING_FILENAME = process.env.TEMP_RECORDING_FILENAME || 'temp_recording.opus';

const OAUTH_CALLBACK_WINDOW_OPTIONS = {
    width: 500,
    height: 700,
    show: true,
    webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
        preload: path.join(__dirname, '../../preload.js'),
    },
    autoHideMenuBar: true,
    resizable: false,
    title: 'Login with Google',
};

// Validate required environment variables
function validateConfig() {
    const missing = [];
    if (!SUPABASE_URL) missing.push('SUPABASE_URL');
    if (!SUPABASE_ANON_KEY) missing.push('SUPABASE_ANON_KEY');
    if (!SUPABASE_SERVICE_ROLE_KEY) missing.push('SUPABASE_SERVICE_ROLE_KEY');
    if (!MISHI_WEB_APP_URL) missing.push('MISHI_WEB_APP_URL');
    if (!GOOGLE_CLIENT_ID) missing.push('GOOGLE_CLIENT_ID');
    if (!GOOGLE_CLIENT_SECRET) missing.push('GOOGLE_CLIENT_SECRET');
    if (missing.length > 0) {
        throw new Error(`Missing required environment variables: ${missing.join(', ')}`);
    }
}

module.exports = {
    SUPABASE_URL,
    SUPABASE_ANON_KEY,
    SUPABASE_SERVICE_ROLE_KEY,
    MISHI_WEB_APP_URL,
    GOOGLE_CLIENT_ID,
    GOOGLE_CLIENT_SECRET,
    TEMP_RECORDING_FILENAME,
    OAUTH_CALLBACK_WINDOW_OPTIONS,
    validateConfig
};
