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
            // Set up subscription BEFORE invoking Edge Function
            console.log('[transcribeAudio] Setting up subscription before invoking Edge Function');
            const channelId = `meeting-${meetingId}`;
            
            // Set up status subscription
            const cleanup = this.subscribeToTranscriptionStatus(meetingId, (status, meeting) => {
                console.log('[transcribeAudio] Status update:', {
                    status,
                    hasMeeting: !!meeting,
                    timestamp: new Date().toISOString()
                });
            });

            console.log('[transcribeAudio] Proceeding with Edge Function invocation');

            // Try to refresh the session first
            const { data: refreshData, error: refreshError } = await this.supabaseUser.auth.refreshSession();
            if (refreshError) {
                console.error('[transcribeAudio] Session refresh error:', refreshError);
            } else if (refreshData?.session) {
                console.log('[transcribeAudio] Session refreshed successfully');
            }

            // Now check if we have a valid session
            const { data: { session }, error: sessionError } = await this.supabaseUser.auth.getSession();
            if (sessionError || !session) {
                throw new Error('No valid authentication session');
            }

            // For Node.js Buffer input
            const audioBuffer = Buffer.isBuffer(audioBlob) ? audioBlob : Buffer.from(audioBlob);
            
            // Validate audio data
            if (!audioBuffer || audioBuffer.length === 0) {
                throw new Error('Audio data is empty');
            }

            console.log('[transcribeAudio] Audio buffer size:', audioBuffer.length);

            // Convert audio buffer to base64
            const audioData = audioBuffer.toString('base64');

            // Always include sentiment_analysis and entity_detection, then add any additional features
            const features = ['sentiment_analysis', 'entity_detection', ...additionalFeatures];

            // Prepare the request payload according to spec
            const payload = {
                audioData,
                meetingId,
                languageCode: 'en_us',
                features: [...new Set(features)] // Remove any duplicates
            };

            console.log('[transcribeAudio] Invoking Edge Function with features:', payload.features);
            
            // Update meeting status to processing before invoking Edge Function
            let updateAttempts = 0;
            const maxAttempts = 3;
            let updateSuccess = false;

            while (updateAttempts < maxAttempts && !updateSuccess) {
                try {
                    const { error: updateError } = await this.supabaseAdmin
                        .from('meetings')
                        .update({ 
                            transcription_status: 'processing',
                            updated_at: new Date().toISOString()
                        })
                        .eq('id', meetingId);

                    if (updateError) {
                        console.error(`[transcribeAudio] Error updating meeting status (attempt ${updateAttempts + 1}):`, updateError);
                        updateAttempts++;
                        if (updateAttempts < maxAttempts) {
                            await new Promise(resolve => setTimeout(resolve, 1000 * updateAttempts));
                        }
                    } else {
                        updateSuccess = true;
                        console.log('[transcribeAudio] Successfully updated meeting status to processing');
                    }
                } catch (error) {
                    console.error(`[transcribeAudio] Error updating meeting status (attempt ${updateAttempts + 1}):`, error);
                    updateAttempts++;
                    if (updateAttempts < maxAttempts) {
                        await new Promise(resolve => setTimeout(resolve, 1000 * updateAttempts));
                    }
                }
            }

            if (!updateSuccess) {
                throw new Error('Failed to update meeting status after multiple attempts');
            }
            
            // Invoke the Edge Function using user client for proper auth
            const { data: responseData, error: functionError } = await this.supabaseUser
                .functions.invoke('transcribe-audio', {
                    body: payload
                });

            if (functionError) {
                console.error('[transcribeAudio] Edge Function error:', functionError);
                throw new Error(`Edge Function error: ${functionError.message}`);
            }

            if (!responseData) {
                console.error('[transcribeAudio] No response data from Edge Function');
                throw new Error('No response data from Edge Function');
            }

            // Log the complete response for debugging
            console.log('[transcribeAudio] Complete Edge Function response:', JSON.stringify(responseData, null, 2));

            return responseData;

        } catch (error) {
            console.error('[transcribeAudio] Error:', error);
            
            // Update meeting status to error
            try {
                const { error: updateError } = await this.supabaseAdmin
                    .from('meetings')
                    .update({ transcription_status: 'error' })
                    .eq('id', meetingId);

                if (updateError) {
                    console.error('[transcribeAudio] Error updating error status:', updateError);
                }
            } catch (updateError) {
                console.error('[transcribeAudio] Error updating error status:', updateError);
            }

            throw error;
        }
    }

    async openInWebApp(userId) {
        if (!this.currentMeetingId) {
            throw new Error('No active meeting.');
        }

        // Generate a one-time access token using admin client
        const { data: token, error: tokenError } = await this.supabaseAdmin
            .rpc('generate_meeting_access_token', {
                p_meeting_id: this.currentMeetingId,
                p_user_id: userId
            });

        if (tokenError) throw tokenError;

        // Construct URL with token
        return `${this.webAppUrl}/meeting/${this.currentMeetingId}?access_token=${token}`;
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

    async fetchUpdatedMeeting(meetingId) {
        console.log('[fetchUpdatedMeeting] Fetching meeting:', meetingId);
        try {
            // Use supabaseAdmin to ensure we can fetch all fields
            const { data, error } = await this.supabaseAdmin
                .from('meetings')
                .select(`
                    *,
                    workspace:workspaces(id, name)
                `)
                .eq('id', meetingId)
                .single();
                
            if (error) {
                console.error('[fetchUpdatedMeeting] Database error:', error);
                throw error;
            }
            
            if (!data) {
                console.error('[fetchUpdatedMeeting] No data returned for meeting:', meetingId);
                throw new Error('Meeting not found');
            }

            console.log('[fetchUpdatedMeeting] Successfully fetched meeting:', {
                id: data.id,
                hasTranscription: !!data.transcription,
                transcriptionLength: data.transcription?.length || 0,
                status: data.transcription_status
            });

            return data;
        } catch (error) {
            console.error('[fetchUpdatedMeeting] Error:', error);
            throw error;
        }
    }

    async cleanup(channelId = null) {
        console.log('[Cleanup] Starting cleanup', {
            specificChannel: !!channelId,
            totalChannels: this.channels.size,
            timestamp: new Date().toISOString()
        });

        try {
            if (channelId) {
                // Clean up specific channel
                const channel = this.channels.get(channelId);
                if (channel) {
                    console.log('[Cleanup] Removing specific subscription:', channelId);
                    await channel.unsubscribe();
                    this.channels.delete(channelId);
                    console.log('[Cleanup] Successfully removed subscription:', channelId);
                }
            } else {
                // Clean up all channels
                for (const [id, channel] of this.channels.entries()) {
                    console.log('[Cleanup] Removing subscription:', id);
                    try {
                        await channel.unsubscribe();
                        console.log('[Cleanup] Successfully unsubscribed channel:', id);
                    } catch (error) {
                        console.error('[Cleanup] Error unsubscribing channel:', {
                            channelId: id,
                            error,
                            timestamp: new Date().toISOString()
                        });
                    } finally {
                        this.channels.delete(id);
                    }
                }
            }
            
            console.log('[Cleanup] Cleanup completed', {
                remainingChannels: this.channels.size,
                timestamp: new Date().toISOString()
            });
        } catch (error) {
            console.error('[Cleanup] Error during cleanup:', {
                error,
                timestamp: new Date().toISOString()
            });
            throw error;
        }
    }

    subscribeToTranscriptionStatus(meetingId, callback) {
        console.log('[subscribeToTranscriptionStatus] Setting up status subscription:', {
            meetingId,
            timestamp: new Date().toISOString()
        });

        if (!meetingId) {
            throw new Error('Meeting ID is required for status subscription');
        }

        const channelId = `meeting-${meetingId}`;
        
        // Return existing channel if we already have one
        if (this.channels.has(channelId)) {
            console.log('[subscribeToTranscriptionStatus] Using existing channel subscription');
            return () => this.cleanup(channelId);
        }

        const channel = this.supabaseUser
            .channel(channelId, {
                config: {
                    broadcast: { self: true },
                    presence: { key: '' }
                }
            })
            .on(
                'postgres_changes',
                {
                    event: '*',
                    schema: 'public',
                    table: 'meetings',
                    filter: `id=eq.${meetingId}`
                },
                async (payload) => {
                    console.log('[Status Subscription] Received update:', {
                        eventType: payload.eventType,
                        meetingId: payload.new?.id,
                        oldStatus: payload.old?.transcription_status,
                        newStatus: payload.new?.transcription_status,
                        hasTranscription: !!payload.new?.transcription,
                        timestamp: new Date().toISOString()
                    });

                    if (payload.eventType === 'UPDATE' && payload.new) {
                        // Use the payload data directly instead of fetching
                        callback(payload.new.transcription_status, payload.new);
                    }
                }
            )
            .on('state_change', ({ from, to }) => {
                console.log('[Status Subscription] Channel state changed:', {
                    from,
                    to,
                    channelId,
                    timestamp: new Date().toISOString()
                });
            })
            .on('error', (error) => {
                console.error('[Status Subscription] Channel error:', {
                    error,
                    channelId,
                    timestamp: new Date().toISOString()
                });
                callback('error', null);
            });

        // Store the channel for cleanup
        this.channels.set(channelId, channel);

        // Subscribe to the channel and wait for it to be ready
        channel.subscribe(async (status) => {
            console.log('[Status Subscription] Subscribe callback:', {
                status,
                channelId,
                timestamp: new Date().toISOString()
            });

            // Get initial state from the payload when subscription is ready
            if (status === 'SUBSCRIBED') {
                try {
                    // Get current state directly from the database once
                    const { data: meeting, error } = await this.supabaseAdmin
                        .from('meetings')
                        .select('*')
                        .eq('id', meetingId)
                        .single();

                    if (error) throw error;
                    if (meeting) {
                        callback(meeting.transcription_status, meeting);
                    }
                } catch (error) {
                    console.error('[Status Subscription] Error fetching initial state:', error);
                }
            }
        });

        return () => {
            // Return cleanup function
            console.log('[Status Subscription] Cleaning up subscription:', channelId);
            this.cleanup(channelId);
        };
    }
}

module.exports = MishiIntegration; 