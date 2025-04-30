const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

class AudioRecorder {
    constructor() {
        this.recordingProcess = null;
        this.isRecording = false;
        this.currentOutputPath = null;

        // Default audio processing parameters
        this.defaultFilterOptions = {
            // Noise reduction parameters (afftdn filter)
            noiseReduction: {
                enabled: true,
                nr: 10,        // Noise reduction level (0-97, default 10)
                nf: -25,       // Noise floor (dB, default -25)
                nt: 'w',       // Noise type (w=white, v=vinyl, default 'w')
            },
            // Loudness normalization parameters (loudnorm filter)
            loudnessNorm: {
                enabled: true,
                targetLevel: -16,      // LUFS target level (default -16)
                truePeak: -1.5,        // dBTP target (default -1.5)
                windowSize: 0.4,       // Sliding window in seconds (default 0.4)
            },
            // Dynamic range compression parameters (compand filter)
            compression: {
                enabled: false,  // Disabled by default as loudnorm is preferred
                threshold: -20,    // dB threshold
                ratio: 3,         // Compression ratio
                attack: 0.1,      // Attack time in seconds
                release: 0.2,     // Release time in seconds
            },
            // Voice activity detection (silencedetect filter)
            vad: {
                enabled: false,  // Disabled by default
                threshold: -30,  // Noise threshold in dB
                duration: 0.5,   // Minimum silence duration in seconds
            }
        };
    }

    /**
     * Start recording from the macOS microphone with audio processing
     * @param {string} outputFilePath - Full path where the WAV file should be saved
     * @param {Object} [options] - Optional configuration
     * @param {number} [options.deviceIndex] - Specific microphone index (optional, uses default if not specified)
     * @param {number} [options.sampleRate=16000] - Audio sample rate in Hz
     * @param {Object} [options.filters] - Audio processing filter options
     * @param {Object} [options.filters.noiseReduction] - Noise reduction settings
     * @param {boolean} [options.filters.noiseReduction.enabled] - Enable/disable noise reduction
     * @param {number} [options.filters.noiseReduction.nr] - Noise reduction level (0-97)
     * @param {number} [options.filters.noiseReduction.nf] - Noise floor (dB)
     * @param {Object} [options.filters.loudnessNorm] - Loudness normalization settings
     * @param {boolean} [options.filters.loudnessNorm.enabled] - Enable/disable loudness normalization
     * @param {number} [options.filters.loudnessNorm.targetLevel] - Target loudness level (LUFS)
     * @param {number} [options.filters.loudnessNorm.truePeak] - True peak target (dBTP)
     * @returns {Promise<void>} Resolves when recording starts, rejects on error
     */
    startRecording(outputFilePath, options = {}) {
        if (this.isRecording) {
            return Promise.reject(new Error('Recording already in progress'));
        }

        if (process.platform !== 'darwin') {
            return Promise.reject(new Error('This recorder currently only supports macOS'));
        }

        // Merge provided filter options with defaults
        const filterOptions = {
            ...this.defaultFilterOptions,
            ...(options.filters || {}),
            noiseReduction: {
                ...this.defaultFilterOptions.noiseReduction,
                ...(options.filters?.noiseReduction || {})
            },
            loudnessNorm: {
                ...this.defaultFilterOptions.loudnessNorm,
                ...(options.filters?.loudnessNorm || {})
            },
            compression: {
                ...this.defaultFilterOptions.compression,
                ...(options.filters?.compression || {})
            },
            vad: {
                ...this.defaultFilterOptions.vad,
                ...(options.filters?.vad || {})
            }
        };

        return new Promise((resolve, reject) => {
            try {
                this.currentOutputPath = outputFilePath;

                // Delete existing output file if it exists
                if (fs.existsSync(outputFilePath)) {
                    fs.unlinkSync(outputFilePath);
                }

                // Prepare FFmpeg arguments for macOS microphone recording
                const args = [
                    '-f', 'avfoundation',    // Use AVFoundation for capture
                    '-thread_queue_size', '4096'  // Prevent buffer underrun
                ];

                // Configure input device
                const deviceInput = options.deviceIndex !== undefined ? 
                    `none:${options.deviceIndex}` : 'none:0';  // Format: none:audio_idx
                args.push('-i', deviceInput);

                // Build the filter chain
                let filterChain = [];

                // 1. Noise Reduction Filter
                if (filterOptions.noiseReduction.enabled) {
                    filterChain.push(
                        `afftdn=` +
                        `nr=${filterOptions.noiseReduction.nr}:` +
                        `nf=${filterOptions.noiseReduction.nf}:` +
                        `nt=${filterOptions.noiseReduction.nt}`
                    );
                }

                // 2. Loudness Normalization
                if (filterOptions.loudnessNorm.enabled) {
                    filterChain.push(
                        `loudnorm=` +
                        `I=${filterOptions.loudnessNorm.targetLevel}:` +
                        `TP=${filterOptions.loudnessNorm.truePeak}:` +
                        `linear=true:` +
                        `dual_mono=true`
                    );
                }
                // Alternative: Dynamic Range Compression
                else if (filterOptions.compression.enabled) {
                    filterChain.push(
                        `compand=` +
                        `attacks=${filterOptions.compression.attack}:` +
                        `decays=${filterOptions.compression.release}:` +
                        `points=-${Math.abs(filterOptions.compression.threshold)}/` +
                        `-${Math.abs(filterOptions.compression.threshold)}|` +
                        `0/${-Math.abs(filterOptions.compression.threshold/filterOptions.compression.ratio)}`
                    );
                }

                // 3. Optional: Voice Activity Detection (logging only)
                if (filterOptions.vad.enabled) {
                    filterChain.push(
                        `silencedetect=` +
                        `n=${filterOptions.vad.threshold}dB:` +
                        `d=${filterOptions.vad.duration}`
                    );
                }

                // Add the filter chain if any filters are enabled
                if (filterChain.length > 0) {
                    args.push('-af', filterChain.join(','));
                }

                // Add output settings
                args.push(
                    '-ar', String(options.sampleRate || 16000),  // Sample rate (default 16kHz)
                    '-acodec', 'pcm_s16le',    // 16-bit PCM
                    '-ac', '1',                // Mono recording
                    '-f', 'wav',               // WAV format
                    outputFilePath
                );

                // Start FFmpeg process
                this.recordingProcess = spawn('ffmpeg', args);

                // Handle process events
                this.recordingProcess.stderr.on('data', (data) => {
                    const output = data.toString();
                    console.log('FFmpeg:', output);
                    
                    // Check for successful input initialization
                    if (output.includes('Input #0')) {
                        this.isRecording = true;
                        resolve();
                    }

                    // Log silence detection if enabled
                    if (filterOptions.vad.enabled && 
                        (output.includes('silence_start') || output.includes('silence_end'))) {
                        console.log('VAD:', output.trim());
                    }
                });

                this.recordingProcess.on('error', (error) => {
                    console.error('FFmpeg process error:', error);
                    this.isRecording = false;
                    this.recordingProcess = null;
                    reject(error);
                });

                // Set a timeout for initialization
                setTimeout(() => {
                    if (!this.isRecording) {
                        this.recordingProcess?.kill();
                        reject(new Error('Failed to start recording within timeout'));
                    }
                }, 3000);

            } catch (error) {
                console.error('Error setting up FFmpeg:', error);
                this.isRecording = false;
                this.recordingProcess = null;
                reject(error);
            }
        });
    }

    /**
     * Stop the current recording
     * @returns {Promise<string>} Resolves with the output file path before clearing it
     */
    async stopRecording() {
        if (!this.isRecording || !this.recordingProcess) {
            return Promise.reject(new Error('No active recording to stop'));
        }

        const outputPath = this.currentOutputPath; // Store the path before clearing it

        return new Promise((resolve, reject) => {
            try {
                // Set up exit handler
                this.recordingProcess.on('exit', (code) => {
                    this.isRecording = false;
                    this.recordingProcess = null;
                    this.currentOutputPath = null;
                    
                    if (code === 0 || code === 255) { // 255 is often returned on SIGTERM
                        resolve(outputPath); // Return the stored path
                    } else {
                        reject(new Error(`FFmpeg exited with code ${code}`));
                    }
                });

                // Send SIGTERM to FFmpeg for graceful shutdown
                this.recordingProcess.kill('SIGTERM');

            } catch (error) {
                console.error('Error stopping FFmpeg:', error);
                this.isRecording = false;
                this.recordingProcess = null;
                reject(error);
            }
        });
    }

    /**
     * List available audio input devices on macOS
     * @returns {Promise<Array<{index: number, name: string}>>} Resolves with array of available microphones
     */
    static async listMicrophones() {
        if (process.platform !== 'darwin') {
            return Promise.reject(new Error('Device listing is currently only supported on macOS'));
        }

        return new Promise((resolve, reject) => {
            const ffmpeg = spawn('ffmpeg', ['-f', 'avfoundation', '-list_devices', 'true', '-i', '""']);
            let output = '';

            ffmpeg.stderr.on('data', (data) => {
                output += data.toString();
            });

            ffmpeg.on('error', (error) => {
                reject(error);
            });

            ffmpeg.on('exit', () => {
                try {
                    const devices = [];
                    const lines = output.split('\n');
                    let isAudioSection = false;

                    for (const line of lines) {
                        if (line.includes('AVFoundation audio devices:')) {
                            isAudioSection = true;
                            continue;
                        }
                        if (isAudioSection && line.match(/\[\d+\]/)) {
                            const match = line.match(/\[(\d+)\]\s+(.*?)$/);
                            if (match) {
                                devices.push({
                                    index: parseInt(match[1], 10),
                                    name: match[2].trim()
                                });
                            }
                        }
                    }
                    resolve(devices);
                } catch (error) {
                    reject(new Error('Failed to parse device list: ' + error.message));
                }
            });
        });
    }

    /**
     * Check if currently recording
     * @returns {boolean} True if recording is in progress
     */
    isCurrentlyRecording() {
        return this.isRecording;
    }

    /**
     * Get the current output file path
     * @returns {string|null} Current output file path or null if not recording
     */
    getCurrentOutputPath() {
        return this.currentOutputPath;
    }
}

module.exports = AudioRecorder; 