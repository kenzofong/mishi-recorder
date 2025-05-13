const { createClient } = require('@supabase/supabase-js');
const FormData = require('form-data');
const { Readable } = require('stream');
const { v4: uuidv4 } = require('uuid');

class MishiIntegration {
    constructor(config) {
        // Create a client with the service role key for direct database access
        this.supabaseAdmin = createClient(config.supabaseUrl, config.supabaseKey, {
            auth: {
                autoRefreshToken: false,
                persistSession: false
            }
        });

        // Create a client with anon key for user-context operations
        this.supabaseUser = createClient(config.supabaseUrl, config.anonKey, {
            auth: {
                autoRefreshToken: true,
                persistSession: true,
                detectSessionInUrl: false
            }
        });

        this.webAppUrl = config.webAppUrl;
        this.currentMeetingId = null;
        this.workspaceId = null;
        this.userAccessToken = null;

        // Add channels map to track active subscriptions
        this.channels = new Map();
    }

    async initialize(userId, accessToken, refreshToken) {
        if (!userId) {
            throw new Error('User ID is required to initialize Mishi integration');
        }

        if (!accessToken) {
            throw new Error('Access token is required to initialize Mishi integration');
        }

        // Set the session for the user client with refresh token if available
        await this.supabaseUser.auth.setSession({
            access_token: accessToken,
            refresh_token: refreshToken || '' // Use provided refresh token or empty string
        });

        this.userAccessToken = accessToken;
        console.log('Initializing workspace for user:', userId);

        try {
            // Direct query to get workspace membership using admin client
            const { data: workspaceMember, error: memberError } = await this.supabaseAdmin
                .from('workspace_members')
                .select(`
                    id,
                    workspace_id,
                    role,
                    workspaces (
                        id,
                        name
                    )
                `)
                .eq('user_id', userId)
                .is('invited', false)
                .single();

            if (memberError) {
                console.error('Error fetching workspace member:', memberError);
                throw memberError;
            }

            if (!workspaceMember) {
                console.log('No workspace found, creating default workspace for user');
                return await this.createDefaultWorkspace(userId);
            }

            this.workspaceId = workspaceMember.workspace_id;
            console.log(`Initialized with workspace: ${workspaceMember.workspaces?.name || 'Unknown'} (${this.workspaceId}) - Role: ${workspaceMember.role}`);
            return this.workspaceId;
        } catch (error) {
            console.error('Workspace initialization error:', error);
            throw error;
        }
    }

    async createDefaultWorkspace(userId) {
        try {
            // Create a new workspace using admin client
            const { data: workspace, error: workspaceError } = await this.supabaseAdmin
                .from('workspaces')
                .insert({
                    name: 'My Workspace',
                    created_by: userId
                })
                .select()
                .single();

            if (workspaceError) throw workspaceError;

            // Add user as workspace owner using admin client
            const { error: memberError } = await this.supabaseAdmin
                .from('workspace_members')
                .insert({
                    workspace_id: workspace.id,
                    user_id: userId,
                    role: 'owner',
                    invited: false
                });

            if (memberError) throw memberError;

            this.workspaceId = workspace.id;
            console.log(`Created default workspace: ${workspace.name} (${workspace.id})`);
            return workspace.id;
        } catch (error) {
            console.error('Error creating default workspace:', error);
            throw new Error(`Failed to create default workspace: ${error.message}`);
        }
    }

    async startRecordingSession(title, userId) {
        if (!this.workspaceId) {
            throw new Error('Workspace ID not set. Call initialize() first.');
        }

        if (!userId) {
            throw new Error('User ID is required to create a meeting.');
        }

        // Create meeting using admin client
        const { data: meeting, error } = await this.supabaseAdmin
            .from('meetings')
            .insert({
                title,
                workspace_id: this.workspaceId,
                created_by: userId,
                created_at: new Date().toISOString(),
                transcription_status: 'awaiting_recording'
            })
            .select()
            .single();

        if (error) throw error;
        this.currentMeetingId = meeting.id;
        return meeting;
    }

    async transcribeAudio(audioBlob, meetingId, additionalFeatures = []) {
        if (!meetingId) {
            throw new Error('Meeting ID is required for transcription.');
        }

        console.log('[transcribeAudio] Starting audio transcription for meeting:', meetingId);

        try {
            const features = ['sentiment_analysis', 'entity_detection', ...additionalFeatures];
            const audioBuffer = Buffer.isBuffer(audioBlob) ? audioBlob : Buffer.from(audioBlob);
            if (!audioBuffer || audioBuffer.length === 0) throw new Error('Audio data is empty');
            const audioData = audioBuffer.toString('base64');
            const payload = { audioData, meetingId, languageCode: 'en_us', features: [...new Set(features)] };
            let updateAttempts = 0, maxAttempts = 3, updateSuccess = false;
            while (updateAttempts < maxAttempts && !updateSuccess) {
                try {
                    const { error: updateError } = await this.supabaseAdmin
                        .from('meetings')
                        .update({ transcription_status: 'processing', updated_at: new Date().toISOString() })
                        .eq('id', meetingId);
                    if (updateError) {
                        updateAttempts++;
                        if (updateAttempts < maxAttempts) await new Promise(resolve => setTimeout(resolve, 1000 * updateAttempts));
                    } else {
                        updateSuccess = true;
                    }
                } catch (error) {
                    updateAttempts++;
                    if (updateAttempts < maxAttempts) await new Promise(resolve => setTimeout(resolve, 1000 * updateAttempts));
                }
            }
            if (!updateSuccess) throw new Error('Failed to update meeting status after multiple attempts');
            const { data: responseData, error: functionError } = await this.supabaseUser
                .functions.invoke('transcribe-audio', { body: payload });
            if (functionError) throw new Error(`Edge Function error: ${functionError.message}`);
            if (!responseData) throw new Error('No response data from Edge Function');
            return responseData;
        } catch (error) {
            try {
                await this.supabaseAdmin.from('meetings').update({ transcription_status: 'error' }).eq('id', meetingId);
            } catch (updateError) {}
            throw error;
        }
    }

    async openInWebApp(userId) {
        if (!this.currentMeetingId) throw new Error('No active meeting.');
        const { data: token, error: tokenError } = await this.supabaseAdmin
            .rpc('generate_meeting_access_token', { p_meeting_id: this.currentMeetingId, p_user_id: userId });
        if (tokenError) throw tokenError;
        return `${this.webAppUrl}/meeting/${this.currentMeetingId}?access_token=${token}`;
    }

    async blobToBase64(buffer) {
        try {
            if (Buffer.isBuffer(buffer)) return buffer.toString('base64');
            const arrayBuffer = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
            return Buffer.from(arrayBuffer).toString('base64');
        } catch (error) {
            throw new Error(`Failed to convert audio to base64: ${error.message}`);
        }
    }

    async fetchUpdatedMeeting(meetingId) {
        try {
            const { data, error } = await this.supabaseAdmin
                .from('meetings')
                .select(`*,workspace:workspaces(id,name)`)
                .eq('id', meetingId)
                .single();
            if (error) throw error;
            if (!data) throw new Error('Meeting not found');
            return data;
        } catch (error) {
            throw error;
        }
    }

    async cleanup(channelId = null) {
        try {
            if (channelId) {
                const channel = this.channels.get(channelId);
                if (channel) {
                    await channel.unsubscribe();
                    this.channels.delete(channelId);
                }
            } else {
                for (const [id, channel] of this.channels.entries()) {
                    try { await channel.unsubscribe(); } catch (error) {}
                    this.channels.delete(id);
                }
            }
        } catch (error) {
            throw error;
        }
    }

    subscribeToTranscriptionStatus(meetingId, callback) {
        if (!meetingId) throw new Error('Meeting ID is required for status subscription');
        const channelId = `meeting-${meetingId}`;
        if (this.channels.has(channelId)) return () => this.cleanup(channelId);
        const channel = this.supabaseUser
            .channel(channelId, { config: { broadcast: { self: true }, presence: { key: '' } } })
            .on('postgres_changes', { event: '*', schema: 'public', table: 'meetings', filter: `id=eq.${meetingId}` }, async (payload) => {
                if (payload.eventType === 'UPDATE' && payload.new) {
                    callback(payload.new.transcription_status, payload.new);
                }
            })
            .on('state_change', ({ from, to }) => {})
            .on('error', (error) => { callback('error', null); });
        this.channels.set(channelId, channel);
        channel.subscribe(async (status) => {
            if (status === 'SUBSCRIBED') {
                try {
                    const { data: meeting, error } = await this.supabaseAdmin
                        .from('meetings')
                        .select('*')
                        .eq('id', meetingId)
                        .single();
                    if (error) throw error;
                    if (meeting) callback(meeting.transcription_status, meeting);
                } catch (error) {}
            }
        });
        return () => { this.cleanup(channelId); };
    }
}

const config = require('./config');

let mishiInstance = null;

function initMishiService() {
    mishiInstance = new MishiIntegration({
        supabaseUrl: config.SUPABASE_URL,
        supabaseKey: config.SUPABASE_SERVICE_ROLE_KEY,
        anonKey: config.SUPABASE_ANON_KEY,
        webAppUrl: config.MISHI_WEB_APP_URL,
    });
    return mishiInstance;
}

function ensureInitialized() {
    if (!mishiInstance) {
        throw new Error('Mishi service not initialized. Call initMishiService() first.');
    }
}

module.exports = {
    initMishiService,
    initialize: async (...args) => {
        ensureInitialized();
        return mishiInstance.initialize(...args);
    },
    cleanup: async (...args) => {
        ensureInitialized();
        return mishiInstance.cleanup(...args);
    },
    startRecordingSession: async (...args) => {
        ensureInitialized();
        return mishiInstance.startRecordingSession(...args);
    },
    transcribeAudio: async (...args) => {
        ensureInitialized();
        return mishiInstance.transcribeAudio(...args);
    },
    subscribeToTranscriptionStatus: (...args) => {
        ensureInitialized();
        return mishiInstance.subscribeToTranscriptionStatus(...args);
    },
    openInWebApp: async (...args) => {
        ensureInitialized();
        return mishiInstance.openInWebApp(...args);
    },
};
