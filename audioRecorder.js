const ffmpeg = require('fluent-ffmpeg');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const { EventEmitter } = require('events');

class AudioRecorder extends EventEmitter {
    static cachedDevices = null;
    static lastDeviceListUpdate = 0;
    static CACHE_TTL = 5000; // 5 seconds TTL for cache

    constructor(settings) {
        super();
        this.isRecording = false;
        this.process = null;
        this.audioBuffer = new Float32Array(1024);
        this.settings = {
            inputDevice: settings.inputDevice || { type: 'system', index: 0 }
        };
        this.levelDetector = new LevelDetector();
        this.outputFilePath = null;

        // Check FFmpeg availability and validate device
        this.initialize().catch(error => {
            console.error('AudioRecorder initialization failed:', error);
            this.emit('error', error);
        });
    }

    async initialize() {
        // Check FFmpeg first
        await this.checkFFmpeg();
        
        // Use cached devices if available
        const devices = AudioRecorder.cachedDevices || await AudioRecorder.listMicrophones();
        const device = this.settings.inputDevice;
        
        if (device.type === 'mic') {
            const validDevice = devices.find(d => d.index === device.index);
            if (!validDevice) {
                throw new Error(`Invalid input device index: ${device.index}`);
            }
        }
        
        // If we get here, initialization was successful
        this.emit('ready');
    }

    async checkFFmpeg() {
        return new Promise((resolve, reject) => {
            const process = spawn('ffmpeg', ['-version']);
            
            let output = '';
            process.stdout.on('data', (data) => {
                output += data.toString();
            });

            process.stderr.on('data', (data) => {
                console.error('FFmpeg check stderr:', data.toString());
            });

            process.on('error', (error) => {
                if (error.code === 'ENOENT') {
                    reject(new Error('FFmpeg is not installed. Please install FFmpeg to use audio recording.'));
                } else {
                    reject(error);
                }
            });

            process.on('close', (code) => {
                if (code === 0) {
                    console.log('FFmpeg version:', output.split('\n')[0]);
                    resolve();
                } else {
                    reject(new Error(`FFmpeg check failed with code ${code}`));
                }
            });
        });
    }

    /**
     * Start recording from the macOS microphone
     * @param {string} outputFilePath - Full path where the audio file should be saved
     * @returns {Promise<void>} Resolves when recording starts, rejects on error
     */
    async startRecording(outputFilePath) {
        if (this.isRecording) {
            return Promise.reject(new Error('Recording already in progress'));
        }

        if (!outputFilePath) {
            return Promise.reject(new Error('Output file path is required'));
        }

        this.outputFilePath = outputFilePath;

        if (process.platform !== 'darwin') {
            return Promise.reject(new Error('This recorder currently only supports macOS'));
        }

        const inputDevice = this.settings.inputDevice;

        // Build FFmpeg command for visualization
                const args = [
            '-f', 'avfoundation',
            '-i', inputDevice.type === 'system' ? ':0' : `:${inputDevice.index}`,
            '-acodec', 'pcm_s16le',
            '-ar', '16000',
            '-ac', '1',
            '-f', 's16le',
            'pipe:1'
        ];

        console.log('Starting FFmpeg visualization process with args:', args.join(' '));

        // Start FFmpeg process for visualization
        this.process = spawn('ffmpeg', args);

        // Handle process errors
        this.process.on('error', (error) => {
            console.error('FFmpeg visualization process error:', error);
            this.emit('error', error);
        });

        // Log stderr for debugging
        this.process.stderr.on('data', (data) => {
            console.log('FFmpeg visualization stderr:', data.toString());
        });

        // Handle audio data for visualization
        this.process.stdout.on('data', (data) => {
            // Convert buffer to Float32Array for visualization
            const samples = new Float32Array(data.length / 2);
            for (let i = 0; i < samples.length; i++) {
                samples[i] = data.readInt16LE(i * 2) / 32768.0;
            }
            
            // Calculate audio level
            const level = this.levelDetector.processChunk(samples);
            
            // Update audio buffer for waveform
            this.updateAudioBuffer(samples);
            
            // Emit audio visualization data
            this.emit('audioData', {
                level,
                waveform: Array.from(this.audioBuffer)
            });
        });

        // Start recording to file with same settings
        const outputArgs = [
            '-y',  // Force overwrite
            '-f', 'avfoundation',
            '-i', inputDevice.type === 'system' ? ':0' : `:${inputDevice.index}`,
            '-acodec', 'pcm_s16le',
            '-ar', '16000',
            '-ac', '1',
            '-f', 'wav',
                    outputFilePath
        ];

        console.log('Starting FFmpeg recording process with args:', outputArgs.join(' '));

        // Start recording process
        this.outputProcess = spawn('ffmpeg', outputArgs);

        // Handle recording process errors
        this.outputProcess.on('error', (error) => {
            console.error('FFmpeg recording process error:', error);
            this.emit('error', error);
        });

        // Log stderr for debugging
        this.outputProcess.stderr.on('data', (data) => {
            console.log('FFmpeg recording stderr:', data.toString());
        });

        this.isRecording = true;
        return new Promise((resolve, reject) => {
            // Wait for first data or error
            const timeout = setTimeout(() => {
                reject(new Error('FFmpeg process failed to start recording within 5 seconds'));
            }, 5000);

            const onData = () => {
                clearTimeout(timeout);
                this.process.stdout.removeListener('data', onData);
                resolve();
            };

            const onError = (error) => {
                clearTimeout(timeout);
                this.process.removeListener('error', onError);
                reject(error);
            };

            this.process.stdout.once('data', onData);
            this.process.once('error', onError);
        });
    }

    /**
     * Stop the current recording
     * @returns {Promise<string>} Resolves with the output file path before clearing it
     */
    async stopRecording() {
        if (!this.isRecording) {
            return Promise.reject(new Error('No active recording to stop'));
        }

        if (!this.outputFilePath) {
            return Promise.reject(new Error('No output file path set'));
        }

        const outputPath = this.outputFilePath;
        console.log('Stopping recording, output path:', outputPath);

        // Stop both processes and wait for them to exit
        await Promise.all([
            new Promise((resolve, reject) => {
                if (this.process) {
                    console.log('Stopping visualization process...');
                    this.process.on('exit', () => {
                        console.log('Visualization process exited');
                        resolve();
                    });
                    this.process.kill('SIGTERM');
                } else {
                    resolve();
                }
            }),
            new Promise((resolve, reject) => {
                if (this.outputProcess) {
                    console.log('Stopping recording process...');
                    this.outputProcess.on('exit', () => {
                        console.log('Recording process exited');
                        resolve();
                    });
                    this.outputProcess.kill('SIGTERM');
                } else {
                    resolve();
                }
            })
        ]);

        // Clear the processes
        this.process = null;
        this.outputProcess = null;
                    this.isRecording = false;

        // Wait for the file to be fully written
        await new Promise((resolve, reject) => {
            const timeout = setTimeout(() => {
                reject(new Error('Timeout waiting for file to be written'));
            }, 5000);

            const checkFile = async () => {
                try {
                    const stats = await fs.promises.stat(outputPath);
                    if (stats.size > 0) {
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
    }

    /**
     * List available audio input devices on macOS
     * @returns {Promise<Array<{index: number, name: string}>>} Resolves with array of available microphones
     */
    static async listMicrophones() {
        if (process.platform !== 'darwin') {
            return Promise.reject(new Error('Device listing is currently only supported on macOS'));
        }

        // Return cached devices if within TTL
        const now = Date.now();
        if (AudioRecorder.cachedDevices && (now - AudioRecorder.lastDeviceListUpdate) < AudioRecorder.CACHE_TTL) {
            console.log('Using cached device list');
            return AudioRecorder.cachedDevices;
        }

        console.log('Fetching fresh device list...');
        return new Promise((resolve, reject) => {
            const process = spawn('ffmpeg', ['-f', 'avfoundation', '-list_devices', 'true', '-i', '']);
            
            let output = '';
            let errorOutput = '';

            process.stdout.on('data', (data) => {
                output += data.toString();
            });

            process.stderr.on('data', (data) => {
                errorOutput += data.toString();
            });

            process.on('error', (error) => {
                reject(new Error(`Failed to list audio devices: ${error.message}`));
            });

            process.on('close', (code) => {
                try {
                    const fullOutput = output + errorOutput;
                    const devices = [];
                    const lines = fullOutput.split('\n');
                    let isAudioSection = false;

                    for (const line of lines) {
                        if (line.includes('AVFoundation audio devices')) {
                            isAudioSection = true;
                            continue;
                        }

                        if (isAudioSection && line.includes('AVFoundation video devices')) {
                            break;
                        }

                        if (isAudioSection && line.includes(']')) {
                            const match = line.match(/\[(\d+)\]\s+([^\[]+?)(?:\s*\[.*\])?$/);
                            if (match) {
                                const index = parseInt(match[1], 10);
                                const name = match[2].trim();
                                
                                if (name && 
                                    !name.toLowerCase().includes('display') && 
                                    !name.toLowerCase().includes('screen')) {
                                    devices.push({ index, name });
                                }
                            }
                        }
                    }

                    // Update cache
                    AudioRecorder.cachedDevices = devices;
                    AudioRecorder.lastDeviceListUpdate = now;
                    
                    resolve(devices);
                } catch (error) {
                    console.error('Error parsing FFmpeg output:', error);
                    reject(error);
                }
            });
        });
    }

    static listMicrophonesSync() {
        try {
            // Return cached devices if within TTL
            const now = Date.now();
            if (AudioRecorder.cachedDevices && (now - AudioRecorder.lastDeviceListUpdate) < AudioRecorder.CACHE_TTL) {
                console.log('Using cached device list for sync call');
                return AudioRecorder.cachedDevices;
            }

            console.log('Fetching fresh device list synchronously...');
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
                        const index = parseInt(match[1]);
                        const name = match[2].trim();
                        if (name && 
                            !name.toLowerCase().includes('display') && 
                            !name.toLowerCase().includes('screen')) {
                            devices.push({ index, name });
                        }
                    }
                }
            });

            // Update cache
            AudioRecorder.cachedDevices = devices;
            AudioRecorder.lastDeviceListUpdate = now;
            
            return devices;
        } catch (error) {
            console.error('Error listing microphones:', error);
            // Return cached devices if available, empty array otherwise
            return AudioRecorder.cachedDevices || [];
        }
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
        return this.settings.outputFilePath;
    }

    // Get current audio data for visualization
    getAudioData() {
        return Array.from(this.audioBuffer);
    }

    // Utility function to downsample audio data
    downsample(data, targetLength) {
        const step = data.length / targetLength;
        const result = new Float32Array(targetLength);
        
        for (let i = 0; i < targetLength; i++) {
            const pos = Math.floor(i * step);
            result[i] = data[pos];
        }
        
        return result;
    }

    updateAudioBuffer(newSamples) {
        // Shift existing samples left
        this.audioBuffer.copyWithin(0, newSamples.length);
        
        // Add new samples at the end
        this.audioBuffer.set(
            newSamples.subarray(0, Math.min(newSamples.length, this.audioBuffer.length)),
            this.audioBuffer.length - Math.min(newSamples.length, this.audioBuffer.length)
        );
    }

    updateSettings(newSettings) {
        this.settings = newSettings;
        
        // If recording, restart with new settings
        if (this.isRecording) {
            const wasRecording = this.isRecording;
            this.stopRecording().then(() => {
                if (wasRecording) {
                    this.startRecording();
                }
            });
        }
    }
}

// Helper class for audio level detection
class LevelDetector {
    constructor() {
        this.smoothingFactor = 0.95;
        this.currentLevel = -Infinity;
    }

    processChunk(samples) {
        // Calculate RMS of the chunk
        const sum = samples.reduce((acc, sample) => acc + (sample * sample), 0);
        const rms = Math.sqrt(sum / samples.length);
        
        // Convert to dB
        const db = 20 * Math.log10(Math.max(rms, 1e-10));
        
        // Smooth the level
        if (this.currentLevel === -Infinity) {
            this.currentLevel = db;
        } else {
            this.currentLevel = this.smoothingFactor * this.currentLevel +
                              (1 - this.smoothingFactor) * db;
        }
        
        return this.currentLevel;
    }
}

module.exports = AudioRecorder; 