const AudioRecorder = require('./audioRecorder');
const path = require('path');

async function testRecording() {
    try {
        // First, list available microphones
        console.log('Available microphones:');
        const mics = await AudioRecorder.listMicrophones();
        console.log(mics);

        // Create recorder instance
        const recorder = new AudioRecorder();
        const outputPath = path.join(__dirname, 'test_recording.opus');

        console.log('\nStarting microphone recording with audio processing...');
        console.log('Using noise reduction and loudness normalization...');
        console.log('Recording will stop after 10 seconds...');
        
        // Start recording with audio processing
        await recorder.startRecording(outputPath, {
            opusBitrate: '64k',
            sampleRate: 48000,
            filters: {
                // Enable and configure noise reduction
                noiseReduction: {
                    enabled: true,
                    nr: 12,        // Slightly stronger noise reduction
                    nf: -25,       // Noise floor
                    nt: 'w'        // White noise profile
                },
                // Enable and configure loudness normalization
                loudnessNorm: {
                    enabled: true,
                    targetLevel: -16,  // Standard loudness target
                    truePeak: -1.5     // Prevent clipping
                },
                // Enable VAD for demonstration
                vad: {
                    enabled: true,
                    threshold: -30,
                    duration: 0.5
                }
            }
        });

        // Record for 10 seconds
        await new Promise(resolve => setTimeout(resolve, 10000));

        console.log('\nStopping recording...');
        await recorder.stopRecording();
        
        console.log(`\nRecording completed! Check ${outputPath}`);
        
        // Print file info
        const stats = require('fs').statSync(outputPath);
        console.log(`File size: ${(stats.size / 1024).toFixed(2)} KB`);
        
        process.exit(0);
    } catch (error) {
        console.error('Test failed:', error);
        process.exit(1);
    }
}

// Run the test
console.log('Testing microphone recording with audio processing...');
console.log('This test will demonstrate:');
console.log('1. Noise reduction using FFmpeg\'s afftdn filter');
console.log('2. Loudness normalization using FFmpeg\'s loudnorm filter');
console.log('3. Voice activity detection using silencedetect filter');
console.log('\nNote: The effectiveness of audio processing depends on:');
console.log('- Environmental conditions (background noise, etc.)');
console.log('- Microphone quality and placement');
console.log('- Parameter tuning for your specific setup\n');

testRecording(); 