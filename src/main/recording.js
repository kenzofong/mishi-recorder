const path = require('path');
const fs = require('fs');
const AudioRecorder = require('../../audioRecorder');

let store, mishiService, supabase, getState, setState, TEMP_RECORDING_FILENAME;
let audioRecorder = null;
let tempRecordingPath = null;
let audioVisualizationInterval = null;
let isStoppingRecording = false;
let stopRecordingTimeout = null;

function initRecordingService({ store: s, mishiService: m, supabase: sb, getState: gs, setState: ss, TEMP_RECORDING_FILENAME: tempFile }) {
    store = s;
    mishiService = m;
    supabase = sb;
    getState = gs;
    setState = ss;
    TEMP_RECORDING_FILENAME = tempFile;
    const baseDir = store.path ? path.dirname(store.path) : require('electron').app.getPath('userData');
    tempRecordingPath = path.join(baseDir, TEMP_RECORDING_FILENAME);
    initializeAudioRecorder();
}

function initializeAudioRecorder() {
    try {
        const settings = {
            inputDevice: store.get('inputDevice') || { type: 'mic', index: 0, name: 'Default Microphone' }
        };
        console.log('[initializeAudioRecorder] Initializing with settings:', settings);
        if (audioRecorder) {
            try {
                audioRecorder.removeAllListeners();
                if (audioRecorder.isCurrentlyRecording()) {
                    audioRecorder.stopRecording().catch(() => {});
                }
            } catch (err) {
                console.error('[initializeAudioRecorder] Error cleaning up old recorder:', err);
            }
        }
        audioRecorder = new AudioRecorder(settings);
        audioRecorder.on('audioData', (data) => {
            // Visualization handled here, UI should subscribe if needed
        });
        audioRecorder.on('error', (error) => {
            setState({ statusMessage: `Audio error: ${error.message}` });
            console.error('[initializeAudioRecorder] AudioRecorder error:', error);
        });
        console.log('[initializeAudioRecorder] AudioRecorder initialized:', !!audioRecorder);
    } catch (error) {
        setState({ statusMessage: `Failed to initialize audio recorder: ${error.message}` });
        console.error('[initializeAudioRecorder] Failed to initialize audio recorder:', error);
    }
}

async function startRecording() {
    initializeAudioRecorder();

    const state = getState();
    if (!state.isLoggedIn) throw new Error('Please log in first');
    if (state.isRecording) {
        throw new Error('Recording is already in progress');
    }
    const today = new Date();
    const title = `Meeting ${String(today.getMonth() + 1).padStart(2, '0')}/${String(today.getDate()).padStart(2, '0')}/${today.getFullYear()}`;
    if (!tempRecordingPath) {
        const baseDir = store.path ? path.dirname(store.path) : require('electron').app.getPath('userData');
        tempRecordingPath = path.join(baseDir, TEMP_RECORDING_FILENAME);
    }
    const meeting = await mishiService.startRecordingSession(title, state.user.id);
    if (!meeting) throw new Error('Failed to create meeting session');
    await audioRecorder.startRecording(tempRecordingPath);
    setState({ isRecording: true, statusMessage: 'Recording...', currentMeeting: meeting });
}

function cleanupTempFile(filePath, reason) {
    if (!filePath) return;
    if (fs.existsSync(filePath)) {
        fs.unlink(filePath, () => {});
    }
}

function cleanupRecording() {
    if (audioRecorder) {
        try {
            audioRecorder.stopRecording().catch(() => {});
        } catch {}
    }
    setState({ isRecording: false, statusMessage: 'Idle', transcriptionStatus: null });
    if (tempRecordingPath) cleanupTempFile(tempRecordingPath, 'Force cleanup');
}

async function stopRecording() {
    if (isStoppingRecording) return;
    isStoppingRecording = true;
    setState({ statusMessage: 'Stopping recording...' });
    if (stopRecordingTimeout) clearTimeout(stopRecordingTimeout);
    stopRecordingTimeout = setTimeout(() => {
        cleanupRecording();
    }, 30000);
    const state = getState();
    if (!state.currentMeeting) throw new Error('No active meeting session');
    if (!audioRecorder) throw new Error('Audio recorder not initialized');
    await audioRecorder.stopRecording();
    setState({ isRecording: false });
    if (!tempRecordingPath) throw new Error('Recording path not set');
    await new Promise((resolve, reject) => {
        let attempts = 0;
        const maxAttempts = 50;
        const checkFile = async () => {
            try {
                const stats = await fs.promises.stat(tempRecordingPath);
                if (stats.size > 0) {
                    await new Promise(res => setTimeout(res, 1000));
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
    const authCheckPromise = supabase.auth.getSession();
    const authTimeout = new Promise((_, reject) => {
        setTimeout(() => reject(new Error('Authentication check timed out after 5 seconds')), 5000);
    });
    const { data: { session }, error: sessionError } = await Promise.race([authCheckPromise, authTimeout]);
    if (sessionError) throw sessionError;
    if (!session) throw new Error('No valid authentication session');
    const { data: { session: refreshedSession }, error: refreshError } = await supabase.auth.refreshSession();
    if (refreshError) throw refreshError;
    if (!refreshedSession) throw new Error('Session refresh failed');
    const audioBlob = await fs.promises.readFile(tempRecordingPath);
    if (stopRecordingTimeout) {
        clearTimeout(stopRecordingTimeout);
        stopRecordingTimeout = null;
    }
    setState({ statusMessage: 'Transcribing...' });
    try {
        const subscription = mishiService.subscribeToTranscriptionStatus(
            state.currentMeeting.id,
            async (status, updatedMeeting) => {
                setState({
                    transcriptionStatus: status,
                    statusMessage: status === 'completed' ? 'Transcription completed' : status === 'error' ? 'Transcription failed' : `Processing transcription (${status})`
                });
                if (updatedMeeting) {
                    setState({ currentMeeting: updatedMeeting });
                }
                if (status === 'completed' || status === 'error') {
                    subscription();
                }
            }
        );
        await mishiService.transcribeAudio(audioBlob, state.currentMeeting.id);
        cleanupTempFile(tempRecordingPath, 'Recording sent for transcription');
    } catch (transcriptionError) {
        setState({ statusMessage: `Error: ${transcriptionError.message}`, transcriptionStatus: 'error' });
        cleanupTempFile(tempRecordingPath, 'Transcription error cleanup');
    }
    isStoppingRecording = false;
}

async function updateAudioDevice(newSettings) {
    let oldRecorder = audioRecorder;
    let newRecorder = null;
    try {
        if (oldRecorder && oldRecorder.isCurrentlyRecording()) {
            await oldRecorder.stopRecording();
        }
        store.set('inputDevice', newSettings);
        audioRecorder = null;
        newRecorder = new AudioRecorder({ inputDevice: newSettings });
        await new Promise((resolve, reject) => {
            const timeout = setTimeout(() => {
                newRecorder.removeAllListeners();
                reject(new Error('Timeout waiting for recorder initialization'));
            }, 10000);
            const cleanup = () => {
                clearTimeout(timeout);
                newRecorder.removeListener('ready', readyHandler);
                newRecorder.removeListener('error', errorHandler);
            };
            const errorHandler = (err) => { cleanup(); reject(err); };
            const readyHandler = () => { cleanup(); resolve(); };
            newRecorder.once('error', errorHandler);
            newRecorder.once('ready', readyHandler);
        });
        audioRecorder = newRecorder;
        audioRecorder.on('audioData', (data) => {});
        audioRecorder.on('error', (error) => {
            setState({ statusMessage: `Audio error: ${error.message}` });
        });
        if (oldRecorder) {
            try { oldRecorder.removeAllListeners(); } catch {}
            oldRecorder = null;
        }
        setTimeout(() => {}, 100);
        return true;
    } catch (error) {
        if (newRecorder) {
            try { newRecorder.removeAllListeners(); } catch {}
        }
        if (oldRecorder && !audioRecorder) {
            audioRecorder = oldRecorder;
            oldRecorder = null;
        }
        setState({ statusMessage: `Failed to update audio device: ${error.message}` });
        return false;
    }
}

function startAudioVisualization() {
    if (audioVisualizationInterval) return;
    audioVisualizationInterval = setInterval(() => {
        if (getState().isRecording && audioRecorder) {
            // Visualization data can be emitted here
        }
    }, 50);
}

function stopAudioVisualization() {
    if (audioVisualizationInterval) {
        clearInterval(audioVisualizationInterval);
        audioVisualizationInterval = null;
    }
}

module.exports = {
    initRecordingService,
    initializeAudioRecorder,
    startRecording,
    stopRecording,
    cleanupTempFile,
    cleanupRecording,
    updateAudioDevice,
    startAudioVisualization,
    stopAudioVisualization,
};
