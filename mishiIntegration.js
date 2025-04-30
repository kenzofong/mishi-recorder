const { createClient } = require('@supabase/supabase-js');
const FormData = require('form-data');
const { Readable } = require('stream');
const { v4: uuidv4 } = require('uuid');

class MishiIntegration {
    constructor(config) {
        // Create a client with the service role key for direct database access
        this.supabase = createClient(config.supabaseUrl, config.supabaseKey, {
            auth: {
                autoRefreshToken: false,
                persistSession: false
            }
        });
        this.webAppUrl = config.webAppUrl;
        this.currentMeetingId = null;
        this.workspaceId = null;
        this.userAccessToken = null;
    }

    async initialize(userId, accessToken) {
        if (!userId) {
            throw new Error('User ID is required to initialize Mishi integration');
        }

        if (!accessToken) {
            throw new Error('Access token is required to initialize Mishi integration');
        }

        this.userAccessToken = accessToken;
        console.log('Initializing workspace for user:', userId);

        try {
            // Direct query to get workspace membership
            const { data: workspaceMember, error: memberError } = await this.supabase
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
            // Create a new workspace
            const { data: workspace, error: workspaceError } = await this.supabase
                .from('workspaces')
                .insert({
                    name: 'My Workspace',
                    created_by: userId
                })
                .select()
                .single();

            if (workspaceError) throw workspaceError;

            // Add user as workspace owner
            const { error: memberError } = await this.supabase
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

        // Create meeting first
        const { data: meeting, error } = await this.supabase
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

    async transcribeAudio(audioBlob) {
        if (!this.currentMeetingId) {
            throw new Error('No active meeting. Call startRecordingSession first.');
        }

        if (!this.userAccessToken) {
            throw new Error('User access token not set. Call initialize() first.');
        }

        console.log('Starting audio transcription for meeting:', this.currentMeetingId);

        try {
            // For Node.js Buffer input
            const audioBuffer = Buffer.isBuffer(audioBlob) ? audioBlob : Buffer.from(audioBlob);
            
            // Validate audio data
            if (!audioBuffer || audioBuffer.length === 0) {
                throw new Error('Audio data is empty');
            }

            console.log('Audio buffer size:', audioBuffer.length);

            // Update meeting status
            await this.supabase
                .from('meetings')
                .update({ transcription_status: 'processing' })
                .eq('id', this.currentMeetingId);

            // Convert audio buffer to base64
            const audioData = audioBuffer.toString('base64');

            // Prepare the request payload
            const payload = {
                meetingId: this.currentMeetingId,
                audioData,
                audioFormat: {
                    codec: 'pcm_s16le',
                    sampleRate: 16000,
                    channels: 1,
                    container: 'wav',
                    mimeType: 'audio/wav'
                },
                languageCode: 'en_us',
                features: ['sentiment_analysis', 'auto_highlights', 'iab_categories']
            };

            // Get the Edge Function URL from the Supabase client
            const edgeFunctionUrl = `${this.supabase.functions.url}/transcribe-audio`;
            
            console.log('Sending request to Edge Function...');
            
            // Make the request with JSON payload
            const response = await fetch(edgeFunctionUrl, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${this.userAccessToken}`,
                    'apikey': this.supabase.supabaseKey
                },
                body: JSON.stringify(payload)
            });

            // Get the response text first
            const responseText = await response.text();
            console.log('Edge Function raw response:', responseText);

            // Try to parse the response as JSON
            let responseData;
            try {
                responseData = JSON.parse(responseText);
            } catch (e) {
                console.error('Failed to parse response as JSON:', e);
                responseData = { error: responseText };
            }

            if (!response.ok) {
                const errorDetails = responseData.error || responseData.message || responseText;
                console.error('Edge Function error:', {
                    status: response.status,
                    statusText: response.statusText,
                    details: errorDetails,
                    headers: Object.fromEntries(response.headers)
                });

                // Update meeting status to error with details
                await this.supabase
                    .from('meetings')
                    .update({ 
                        transcription_status: 'error',
                        notes: `Transcription failed: ${errorDetails}`
                    })
                    .eq('id', this.currentMeetingId);

                throw new Error(`Edge Function error (${response.status}): ${errorDetails}`);
            }

            console.log('Transcription completed successfully:', responseData);
            
            // Update meeting with transcription results
            const { error: updateError } = await this.supabase
                .from('meetings')
                .update({
                    transcription: JSON.stringify({
                        text: responseData.text,
                        utterances: responseData.utterances
                    }),
                    sentiment_analysis: JSON.stringify(responseData.sentimentAnalysis),
                    topics: JSON.stringify(responseData.topics),
                    key_phrases: JSON.stringify(responseData.keyPhrases),
                    transcription_status: 'completed',
                    updated_at: new Date().toISOString()
                })
                .eq('id', this.currentMeetingId);

            if (updateError) {
                console.error('Failed to update meeting with transcription:', updateError);
                throw updateError;
            }

            return responseData;
        } catch (error) {
            console.error('Transcription error:', error);
            
            // Update meeting status to error if not already done
            await this.supabase
                .from('meetings')
                .update({ 
                    transcription_status: 'error',
                    notes: `Transcription failed: ${error.message}`
                })
                .eq('id', this.currentMeetingId);
            
            throw error;
        }
    }

    async openInWebApp(userId) {
        if (!this.currentMeetingId) {
            throw new Error('No active meeting.');
        }

        // Generate a one-time access token
        const { data: token, error: tokenError } = await this.supabase
            .rpc('generate_meeting_access_token', {
                p_meeting_id: this.currentMeetingId,
                p_user_id: userId
            });

        if (tokenError) throw tokenError;

        // Construct URL with token
        return `${this.webAppUrl}/meeting/${this.currentMeetingId}?access_token=${token}`;
    }

    subscribeToTranscriptionStatus(callback) {
        if (!this.currentMeetingId) {
            throw new Error('No active meeting to subscribe to.');
        }

        return this.supabase
            .channel(`meeting-${this.currentMeetingId}`)
            .on(
                'postgres_changes',
                {
                    event: 'UPDATE',
                    schema: 'public',
                    table: 'meetings',
                    filter: `id=eq.${this.currentMeetingId}`
                },
                (payload) => callback(payload.new.transcription_status)
            )
            .subscribe();
    }

    async blobToBase64(buffer) {
        try {
            // In Node.js, we receive a Buffer directly from fs.readFile
            if (Buffer.isBuffer(buffer)) {
                return buffer.toString('base64');
            }

            // If it's not a Buffer (e.g., a Blob), convert it
            const arrayBuffer = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
            return Buffer.from(arrayBuffer).toString('base64');
        } catch (error) {
            console.error('Error converting audio to base64:', error);
            throw new Error(`Failed to convert audio to base64: ${error.message}`);
        }
    }
}

module.exports = MishiIntegration; 