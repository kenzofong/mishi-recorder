const { ipcMain, dialog } = require('electron');

let ipcHandlersRegistered = false;

function setupIPCHandlers({
    state,
    getState,
    store,
    audioRecorder,
    tempRecordingPath,
    setState,
    startRecording,
    stopRecording,
    cleanupRecording,
    recordingWindow,
    settingsWindow,
    createAndShowLoginWindow,
    createSettingsWindow,
    hideSettingsWindow,
    createRecordingWindow,
    updateAudioDevice,
    isStoppingRecording,
    mishiIntegration,
    supabase,
    authService,
    recordingService,
    windowManager
}) {
    if (ipcHandlersRegistered) return;
    ipcHandlersRegistered = true;

    ipcMain.handle('get-settings', () => {
        return store.store;
    });

    ipcMain.handle('update-settings', (_, changes) => {
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
        if (recordingWindow) {
            recordingWindow.webContents.send('settings-change', store.store);
        }
        if (settingsWindow) {
            settingsWindow.webContents.send('settings-change', store.store);
        }
        return store.store;
    });

    ipcMain.on('toggle-settings', () => {
        if (settingsWindow) {
            hideSettingsWindow({ settingsWindow, recordingWindow });
        } else {
            createSettingsWindow({
                recordingWindow,
                preloadPath: path.join(__dirname, '../../preload.js'),
                settingsHtmlPath: path.join(__dirname, '../../settingsPanel.html'),
                screen: require('electron').screen,
                onHide: () => { settingsWindow = null; }
            });
            recordingWindow?.webContents.send('settings-state-change', true);
        }
    });

    ipcMain.on('toggle-recording-window', () => {
        if (recordingWindow && recordingWindow.isVisible()) {
            recordingWindow.hide();
        } else {
            createRecordingWindow({
                preloadPath: path.join(__dirname, '../../preload.js'),
                recordingHtmlPath: path.join(__dirname, '../../recordingWindow.html'),
                state,
                onClose: () => { recordingWindow = null; }
            });
        }
    });

    ipcMain.on('start-recording', async () => {
        try {
            await startRecording();
            setState({ isRecording: true, statusMessage: 'Recording...' });
            recordingWindow?.webContents.send('recording-state-change', true);
        } catch (error) {
            console.error('Failed to start recording:', error);
            dialog.showErrorBox('Recording Error', `Failed to start recording: ${error.message}`);
        }
    });

    ipcMain.on('stop-recording', async () => {
        try {
            if (isStoppingRecording) {
                console.log('Stop recording already in progress, ignoring duplicate request');
                return;
            }
            if (!getState().isRecording) {
                console.log('No active recording to stop');
                recordingWindow?.webContents.send('recording-state-change', false);
                return;
            }
            await stopRecording();
        } catch (error) {
            console.error('Failed to stop recording:', error);
            dialog.showErrorBox('Recording Error', `Failed to stop recording: ${error.message}`);
            cleanupRecording();
        }
    });

    ipcMain.on('open-login-window', () => {
        createAndShowLoginWindow({
            preloadPath: path.join(__dirname, '../../preload.js'),
            loginHtmlPath: path.join(__dirname, '../../login.html')
        });
    });

    ipcMain.on('close-recording-window', () => {
        if (recordingWindow && !state.isRecording) {
            recordingWindow.hide();
        }
    });

    // Login
    ipcMain.handle('login', async (event, { email, password }) => {
        return await authService.login(email, password);
    });

    // OAuth login
    ipcMain.handle('oauth-login', async (event, { provider }) => {
        return await authService.handleOAuthLogin(event, { provider });
    });

    // Logout
    ipcMain.handle('logout', async () => {
        return await authService.logout();
    });

    // Start recording
    ipcMain.handle('start-recording', async () => {
        return await recordingService.startRecording();
    });

    // Stop recording
    ipcMain.handle('stop-recording', async () => {
        return await recordingService.stopRecording();
    });

    // Update audio device
    ipcMain.handle('update-audio-device', async (event, newSettings) => {
        return await recordingService.updateAudioDevice(newSettings);
    });

    // Show login window
    ipcMain.on('open-login-window', () => {
        windowManager.showLoginWindow(store.get('windowOptions') || {});
    });

    // Show/ensure recording window
    ipcMain.on('toggle-recording-window', () => {
        windowManager.ensureRecordingWindow(store.get('windowOptions') || {});
    });

    // Toggle settings panel
    ipcMain.on('toggle-settings', () => {
        windowManager.toggleSettingsPanel(store.get('windowOptions') || {});
    });

    // Hide settings window
    ipcMain.on('hide-settings-window', () => {
        windowManager.hideSettingsWindow(store.get('windowOptions') || {});
    });

    // Get company information including summary
    ipcMain.handle('get-company-info', async (_, companyId) => {
        try {
            console.log('[DEBUG] get-company-info handler called with companyId:', companyId);
            if (!mishiIntegration || !companyId) {
                console.log('[DEBUG] Missing mishiIntegration or companyId');
                return { success: false, error: 'Missing company ID or service not initialized' };
            }
            
            console.log('[DEBUG] Querying Supabase for company with ID:', companyId);
            const { data, error } = await mishiIntegration.supabaseUser
                .from('companies')
                .select('id, name, description, summary, logo_file_id')
                .eq('id', companyId)
                .single();
                
            if (error) {
                console.error('Error fetching company info:', error);
                console.log('[DEBUG] Supabase error:', error);
                return { success: false, error: error.message };
            }
            
            console.log('[DEBUG] Supabase response data:', data);
            
            // For testing: If there's no summary, add a test one (development only)
            if (data && !data.summary && process.env.NODE_ENV === 'development') {
                console.log('[DEBUG] Adding test summary to company data (development mode)');
                data.summary = `${data.name} is a company with great potential. This is a test summary that has been added to verify that the recap functionality is working correctly. The real summary will be pulled from the database when it's available.`;
                // Try to update the company in the database with the test summary
                try {
                    const { error: updateError } = await mishiIntegration.supabaseUser
                        .from('companies')
                        .update({ summary: data.summary })
                        .eq('id', companyId);
                    if (updateError) {
                        console.log('[DEBUG] Failed to update company with test summary:', updateError);
                    } else {
                        console.log('[DEBUG] Successfully updated company with test summary');
                    }
                } catch (updateErr) {
                    console.log('[DEBUG] Exception when updating company:', updateErr);
                }
            }
            
            return { success: true, company: data };
        } catch (err) {
            console.error('Failed to get company info:', err);
            console.log('[DEBUG] Exception in get-company-info:', err);
            return { success: false, error: err.message };
        }
    });

    // Get list of companies
    ipcMain.handle('get-companies', async () => {
        try {
            if (!mishiIntegration) {
                return { success: false, error: 'Mishi service not initialized' };
            }
            
            if (!mishiIntegration.workspaceId) {
                return { success: false, error: 'No active workspace' };
            }
            
            const { data, error } = await mishiIntegration.supabaseUser
                .from('companies')
                .select('id, name')
                .eq('workspace_id', mishiIntegration.workspaceId)
                .order('name');
                
            if (error) {
                console.error('Error fetching companies:', error);
                return { success: false, error: error.message };
            }
            
            return { success: true, companies: data || [] };
        } catch (err) {
            console.error('Failed to get companies:', err);
            return { success: false, error: err.message };
        }
    });

    // Get meeting templates
    ipcMain.handle('get-meeting-templates', async () => {
        try {
            if (!mishiIntegration) {
                return { success: false, error: 'Mishi service not initialized' };
            }
            
            if (!mishiIntegration.workspaceId) {
                return { success: false, error: 'No active workspace' };
            }
            
            const { data, error } = await mishiIntegration.supabaseUser
                .from('meeting_templates')
                .select('id, name, content, color')
                .eq('workspace_id', mishiIntegration.workspaceId)
                .order('name');
                
            if (error) {
                console.error('Error fetching meeting templates:', error);
                return { success: false, error: error.message };
            }
            
            return { success: true, templates: data || [] };
        } catch (err) {
            console.error('Failed to get meeting templates:', err);
            return { success: false, error: err.message };
        }
    });

    // Get previous meetings for a company
    ipcMain.handle('get-previous-meetings', async (_, companyId) => {
        try {
            if (!mishiIntegration) {
                return { success: false, error: 'Mishi service not initialized' };
            }
            
            if (!mishiIntegration.workspaceId || !companyId) {
                return { success: false, error: 'Missing workspace ID or company ID' };
            }
            
            const { data, error } = await mishiIntegration.supabaseUser
                .from('meetings')
                .select('id, title, notes, tldr, created_at')
                .eq('company_id', companyId)
                .eq('workspace_id', mishiIntegration.workspaceId)
                .order('created_at', { ascending: false })
                .limit(5);
                
            if (error) {
                console.error('Error fetching previous meetings:', error);
                return { success: false, error: error.message };
            }
            
            return { success: true, meetings: data || [] };
        } catch (err) {
            console.error('Failed to get previous meetings:', err);
            return { success: false, error: err.message };
        }
    });

    // Create a new meeting and return its ID
    ipcMain.handle('create-meeting', async (_, { title, companyId }) => {
        try {
            if (!mishiIntegration || !mishiIntegration.workspaceId) {
                return { success: false, error: 'Mishi service not initialized or missing workspace' };
            }
            const user = getState().user;
            if (!user || !user.id) {
                return { success: false, error: 'No authenticated user found' };
            }
            // Insert meeting into the database
            const { data, error } = await mishiIntegration.supabaseUser
                .from('meetings')
                .insert({
                    title,
                    workspace_id: mishiIntegration.workspaceId,
                    company_id: companyId,
                    created_by: user.id,
                    created_at: new Date().toISOString(),
                    transcription_status: 'awaiting_recording'
                })
                .select()
                .single();
            if (error) {
                return { success: false, error: error.message };
            }
            return { success: true, meeting: data };
        } catch (err) {
            return { success: false, error: err.message };
        }
    });

    // Fetch meeting_prep for a meeting
    ipcMain.handle('get-meeting-prep', async (_, meetingId) => {
        try {
            if (!mishiIntegration || !mishiIntegration.workspaceId) {
                return { success: false, error: 'Mishi service not initialized or missing workspace' };
            }
            const { data, error } = await mishiIntegration.supabaseUser
                .from('meetings')
                .select('id, meeting_prep')
                .eq('id', meetingId)
                .eq('workspace_id', mishiIntegration.workspaceId)
                .single();
            if (error) {
                return { success: false, error: error.message };
            }
            let parsed = null;
            if (data && data.meeting_prep) {
                let content = data.meeting_prep.trim();
                // Remove code block markers if present
                if (content.startsWith('```') && content.endsWith('```')) {
                    content = content.replace(/^```[a-zA-Z]*\n?/, '').replace(/```$/, '').trim();
                }
                try {
                    parsed = JSON.parse(content);
                } catch (e) {
                    parsed = null;
                }
            }
            return { success: true, prep: parsed };
        } catch (err) {
            return { success: false, error: err.message };
        }
    });

    // Generate meeting prep using the edge function and save it to the meeting
    ipcMain.handle('generate-meeting-prep', async (_, meetingId) => {
        try {
            if (!mishiIntegration || !mishiIntegration.workspaceId) {
                return { success: false, error: 'Mishi service not initialized or missing workspace' };
            }
            // Call the edge function
            const { data, error } = await mishiIntegration.supabaseUser.functions.invoke('generate-meeting-prep', { body: { meetingId } });
            if (error) {
                return { success: false, error: error.message };
            }
            // The edge function returns { content: string }
            let content = data?.content;
            let parsed = null;
            if (content) {
                // Save to the meeting
                await mishiIntegration.supabaseUser
                    .from('meetings')
                    .update({ meeting_prep: content })
                    .eq('id', meetingId);
                // Parse for return
                try {
                    if (content.startsWith('```') && content.endsWith('```')) {
                        content = content.replace(/^```[a-zA-Z]*\n?/, '').replace(/```$/, '').trim();
                    }
                    parsed = JSON.parse(content);
                } catch (e) {
                    parsed = null;
                }
            }
            return { success: true, prep: parsed };
        } catch (err) {
            return { success: false, error: err.message };
        }
    });

    // Open meeting or document in web app
    ipcMain.handle('open-in-web-app', async (_, { type, id }) => {
        try {
            if (!mishiIntegration || !mishiIntegration.webAppUrl) {
                return { success: false, error: 'Mishi service not initialized or missing web app URL' };
            }
            
            const { shell } = require('electron');
            let url;
            
            if (type === 'meeting') {
                url = `${mishiIntegration.webAppUrl}/meeting/${id}`;
            } else if (type === 'document') {
                url = `${mishiIntegration.webAppUrl}/document/${id}`;
            } else {
                return { success: false, error: 'Invalid resource type' };
            }
            console.log(`[ipcHandlers] Opening ${type} in browser:`, url);
            await shell.openExternal(url);
            return { success: true };
        } catch (err) {
            console.error(`Failed to open ${type} in web app:`, err);
            return { success: false, error: err.message };
        }
    });

    // Start audio recording (real implementation)
    ipcMain.handle('start-recording-audio', async () => {
        try {
            console.log('[start-recording-audio] Handler called');
            await startRecording();
            console.log('[start-recording-audio] startRecording completed');
            return { success: true };
        } catch (err) {
            console.error('[start-recording-audio] Error:', err);
            return { success: false, error: err.message };
        }
    });

    // Stop audio recording (real implementation)
    ipcMain.handle('stop-recording-audio', async () => {
        try {
            console.log('[stop-recording-audio] Handler called');
            await stopRecording();
            const fs = require('fs');
            console.log('[stop-recording-audio] tempRecordingPath:', tempRecordingPath);
            if (!tempRecordingPath || !fs.existsSync(tempRecordingPath)) {
                console.error('[stop-recording-audio] No audio file found at', tempRecordingPath);
                return { success: false, error: 'No audio file recorded' };
            }
            console.log('[stop-recording-audio] Audio file exists at', tempRecordingPath);
            return { success: true, filePath: tempRecordingPath };
        } catch (err) {
            console.error('[stop-recording-audio] Error:', err);
            return { success: false, error: err.message };
        }
    });

    // Transcribe meeting audio
    ipcMain.handle('transcribe-meeting-audio', async (_, meetingId) => {
        try {
            const fs = require('fs');
            console.log('[transcribe-meeting-audio] Handler called');
            console.log('[transcribe-meeting-audio] tempRecordingPath:', tempRecordingPath);
            if (!tempRecordingPath || !fs.existsSync(tempRecordingPath)) {
                console.error('[transcribe-meeting-audio] No audio file found at', tempRecordingPath);
                return { success: false, error: 'No audio file to transcribe' };
            }
            // Read audio file as buffer
            const audioBuffer = fs.readFileSync(tempRecordingPath);
            // Call Supabase Edge Function for transcription
            const { data, error } = await mishiIntegration.supabaseUser.functions.invoke('transcribe-meeting-audio', {
                body: { meetingId },
                // For real implementation, send audioBuffer as binary
            });
            if (error) {
                return { success: false, error: error.message };
            }
            return { success: true, transcript: data && data.transcript };
        } catch (err) {
            console.error('[transcribe-meeting-audio] Error:', err);
            return { success: false, error: err.message };
        }
    });

    // Enhance meeting content
    ipcMain.handle('enhance-meeting-content', async (_, meetingId) => {
        try {
            // Call Supabase Edge Function for enhancement
            const { data, error } = await mishiIntegration.supabaseUser.functions.invoke('enhance-meeting-content', {
                body: { meetingId },
            });
            if (error) {
                return { success: false, error: error.message };
            }
            return { success: true, content: data && data.content };
        } catch (err) {
            return { success: false, error: err.message };
        }
    });

    // Set current meeting in state (for meeting overlay recording)
    ipcMain.handle('set-current-meeting', async (_, meetingId) => {
        try {
            if (!mishiIntegration || !mishiIntegration.workspaceId) {
                return { success: false, error: 'Mishi service not initialized or missing workspace' };
            }
            const { data, error } = await mishiIntegration.supabaseUser
                .from('meetings')
                .select('*')
                .eq('id', meetingId)
                .eq('workspace_id', mishiIntegration.workspaceId)
                .single();
            if (error) return { success: false, error: error.message };
            setState({ currentMeeting: data });
            return { success: true, meeting: data };
        } catch (err) {
            return { success: false, error: err.message };
        }
    });

    // List available audio input devices (FFmpeg/AVFoundation)
    ipcMain.handle('list-audio-input-devices', async () => {
        const { execSync } = require('child_process');
        const fs = require('fs');

        const ffmpegPaths = [
            'ffmpeg', 
            '/opt/homebrew/bin/ffmpeg',
            '/usr/local/bin/ffmpeg',
            '/usr/bin/ffmpeg'
        ];

        let output = '';
        let ffmpegFoundPath = '';

        for (const p of ffmpegPaths) {
            try {
                if (p !== 'ffmpeg' && !fs.existsSync(p)) continue;
                console.log(`[FFmpeg] Trying path via shell: ${p}`);
                const currentAttemptOutput = execSync(`sh -c '"${p}" -hide_banner -loglevel debug -f avfoundation -list_devices true -i ""' 2>&1`, {
                    encoding: 'utf8',
                    timeout: 7000,
                    shell: true
                });
                output = currentAttemptOutput;
                ffmpegFoundPath = p;
                console.log(`[FFmpeg] Successfully executed with: ${p}. Output:\n${output}`);
                break; 
            } catch (err) {
                const capturedOutput = err.stdout ? err.stdout.toString() : "";
                if (capturedOutput.includes('AVFoundation audio devices:')) {
                    console.warn(`[FFmpeg] Command failed for ${p} but produced device list. Using this output.`);
                    output = capturedOutput;
                    ffmpegFoundPath = p;
                    break;
                } else {
                    let stderrOutput = err.stderr ? err.stderr.toString() : "N/A";
                    let stdoutForLog = capturedOutput ? capturedOutput : "N/A";

                    console.warn(`[FFmpeg] Failed with path ${p}. Status: ${err.status}, Signal: ${err.signal}`);
                    console.warn(`[FFmpeg] Stderr (${p}):\n${stderrOutput}`);
                    console.warn(`[FFmpeg] Stdout (${p}):\n${stdoutForLog}`);
                    if (output === '') {
                       output = `Error executing FFmpeg with ${p}. Stderr: ${stderrOutput}\nStdout: ${stdoutForLog}`;
                    }
                }
            }
        }

        if (!ffmpegFoundPath) {
            console.error('[FFmpeg] Not found or failed to produce device list in all specified paths.');
            return { success: false, error: 'FFmpeg not found or failed to produce device list.', rawOutput: output };
        }

        try {
            const audioDevices = [];
            let inAudioSection = false;
            output.split('\n').forEach(line => {
                if (line.includes('AVFoundation audio devices:')) {
                    inAudioSection = true;
                } else if (inAudioSection && line.match(/\[\d+\] /)) {
                    const match = line.match(/\[(\d+)\] (.+)$/);
                    if (match) {
                        audioDevices.push({ index: parseInt(match[1], 10), name: match[2].trim() });
                    }
                } else if (inAudioSection && (line.trim() === '' || line.includes('AVFoundation video devices:'))) {
                    inAudioSection = false;
                }
            });
            return { success: true, devices: audioDevices, rawOutput: output, ffmpegPath: ffmpegFoundPath };
        } catch (parseError) {
            console.error('[FFmpeg] Error parsing output:', parseError);
            return { success: false, error: 'Error parsing FFmpeg output.', rawOutput: output, ffmpegPath: ffmpegFoundPath };
        }
    });
}

module.exports = { setupIPCHandlers };