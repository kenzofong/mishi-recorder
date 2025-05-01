document.addEventListener('DOMContentLoaded', () => {
    const waveformCanvas = document.createElement('canvas');
    const waveformContainer = document.getElementById('waveform');
    const recordButton = document.getElementById('recordButton');
    const caretButton = document.getElementById('caretButton');
    const durationDisplay = document.getElementById('duration');
    const levelIndicator = document.getElementById('levelIndicator');
    
    let isRecording = false;
    let recordingStartTime = null;
    let durationInterval = null;
    
    // Double-tap Option key variables
    const doubleTapThreshold = 300; // milliseconds
    let lastOptionKeyTime = 0;

    // Audio visualization variables
    const smoothingFactor = 0.3;
    let previousPoints = [];
    let maxLevel = 0;
    const levelDecay = 0.98; // Level decay factor
    const minLevel = 0.0001; // Minimum level to show
    const clippingThreshold = 0.95; // Threshold for clipping detection
    let isClipping = false;
    let clippingTimeout = null;
    let animationFrameId = null;

    // Settings state management
    window.electronAPI.onSettingsStateChange((isOpen) => {
        caretButton.classList.toggle('active', isOpen);
    });

    // Caret button click handler
    caretButton.addEventListener('click', () => {
        window.electronAPI.toggleSettings();
    });

    // Setup waveform canvas
    waveformCanvas.width = waveformContainer.clientWidth;
    waveformCanvas.height = waveformContainer.clientHeight;
    waveformContainer.appendChild(waveformCanvas);
    const ctx = waveformCanvas.getContext('2d');

    // Draw initial baseline
    drawBaselineWaveform();

    // Handle window resize
    new ResizeObserver(() => {
        waveformCanvas.width = waveformContainer.clientWidth;
        waveformCanvas.height = waveformContainer.clientHeight;
        if (!isRecording) {
            drawBaselineWaveform();
        }
    }).observe(waveformContainer);

    // Draw baseline waveform when not recording
    function drawBaselineWaveform() {
        ctx.clearRect(0, 0, waveformCanvas.width, waveformCanvas.height);
        
        // Draw center line
        ctx.beginPath();
        ctx.strokeStyle = getComputedStyle(document.documentElement)
            .getPropertyValue('--waveform-stroke').trim();
        ctx.globalAlpha = 0.2;
        ctx.lineWidth = 1;
        ctx.moveTo(0, waveformCanvas.height / 2);
        ctx.lineTo(waveformCanvas.width, waveformCanvas.height / 2);
        ctx.stroke();
        ctx.globalAlpha = 1;
    }

    // Format duration as MM:SS
    function formatDuration(ms) {
        const seconds = Math.floor(ms / 1000);
        const minutes = Math.floor(seconds / 60);
        const remainingSeconds = seconds % 60;
        return `${minutes.toString().padStart(2, '0')}:${remainingSeconds.toString().padStart(2, '0')}`;
    }

    // Start duration timer
    function startDurationTimer() {
        recordingStartTime = Date.now();
        durationInterval = setInterval(() => {
            const duration = Date.now() - recordingStartTime;
            durationDisplay.textContent = formatDuration(duration);
        }, 1000);
        durationDisplay.textContent = '00:00';
    }

    // Stop duration timer
    function stopDurationTimer() {
        if (durationInterval) {
            clearInterval(durationInterval);
            durationInterval = null;
        }
        durationDisplay.textContent = '';
    }

    // Calculate audio level with clipping detection
    function calculateAudioLevel(audioData) {
        let sum = 0;
        let maxSample = 0;
        
        for (let i = 0; i < audioData.length; i++) {
            const sample = Math.abs(audioData[i]);
            sum += sample;
            maxSample = Math.max(maxSample, sample);
        }
        
        const level = sum / audioData.length;
        
        // Check for clipping
        if (maxSample > clippingThreshold) {
            if (!isClipping) {
                isClipping = true;
                levelIndicator.classList.add('clipping');
            }
            // Reset clipping timeout
            if (clippingTimeout) clearTimeout(clippingTimeout);
            clippingTimeout = setTimeout(() => {
                isClipping = false;
                levelIndicator.classList.remove('clipping');
            }, 1000);
        }
        
        // Update max level with decay
        maxLevel = Math.max(maxLevel * levelDecay, level);
        return level;
    }

    // Audio visualization with smooth transitions
    function visualize(audioData) {
        ctx.clearRect(0, 0, waveformCanvas.width, waveformCanvas.height);
        
        // Calculate audio level and update indicator
        const level = calculateAudioLevel(audioData);
        const normalizedLevel = Math.max(level / maxLevel, minLevel);
        levelIndicator.classList.toggle('active', normalizedLevel > 0.01);
        
        // Create gradient with dynamic color based on level
        const gradient = ctx.createLinearGradient(0, 0, 0, waveformCanvas.height);
        const color = getComputedStyle(document.documentElement)
            .getPropertyValue(isClipping ? '--record-button-bg' : '--waveform-stroke').trim();
        
        gradient.addColorStop(0, color + '00');   // Transparent at edges
        gradient.addColorStop(0.5, color + 'FF'); // Solid in middle
        gradient.addColorStop(1, color + '00');   // Transparent at edges
        
        // Draw center line
        ctx.beginPath();
        ctx.strokeStyle = color;
        ctx.globalAlpha = 0.2;
        ctx.lineWidth = 1;
        ctx.moveTo(0, waveformCanvas.height / 2);
        ctx.lineTo(waveformCanvas.width, waveformCanvas.height / 2);
        ctx.stroke();
        ctx.globalAlpha = 1;

        // Draw waveform with dynamic scaling
        const points = [];
        const sliceWidth = waveformCanvas.width / audioData.length;
        const centerY = waveformCanvas.height / 2;
        const scale = Math.min(1, Math.max(0.5, normalizedLevel * 1.5)); // Dynamic scaling
        
        // Draw upper half
        ctx.beginPath();
        ctx.strokeStyle = gradient;
        ctx.lineWidth = 2;
        
        for (let i = 0; i < audioData.length; i++) {
            const v = (audioData[i] / 128.0) * scale;
            const y = (v * waveformCanvas.height / 4) + centerY;
            
            // Enhanced smooth transition
            const prevY = previousPoints[i] || centerY;
            const smoothY = prevY + (y - prevY) * (isClipping ? 0.5 : smoothingFactor);
            points.push(smoothY);
            
            const x = i * sliceWidth;
            if (i === 0) {
                ctx.moveTo(x, smoothY);
            } else {
                ctx.lineTo(x, smoothY);
            }
        }
        ctx.stroke();
        
        // Draw lower half (mirror)
        ctx.beginPath();
        for (let i = 0; i < audioData.length; i++) {
            const x = i * sliceWidth;
            const y = points[i];
            const mirrorY = centerY - (y - centerY);
            
            if (i === 0) {
                ctx.moveTo(x, mirrorY);
            } else {
                ctx.lineTo(x, mirrorY);
            }
        }
        ctx.stroke();

        // Store points for next frame
        previousPoints = points;
    }

    // Record button click handler
    recordButton.addEventListener('click', () => {
        isRecording = !isRecording;
        recordButton.classList.toggle('recording');
        recordButton.title = isRecording ? 'Stop Recording' : 'Start Recording';
        
        if (isRecording) {
            startDurationTimer();
            window.electronAPI.startRecording();
        } else {
            stopDurationTimer();
            window.electronAPI.stopRecording();
            // Reset visualization
            previousPoints = [];
            maxLevel = 0;
            if (animationFrameId) {
                cancelAnimationFrame(animationFrameId);
                animationFrameId = null;
            }
            drawBaselineWaveform();
        }
    });

    // Keyboard shortcuts
    document.addEventListener('keydown', (e) => {
        // Space bar to toggle recording
        if (e.code === 'Space' && !e.repeat) {
            e.preventDefault();
            recordButton.click();
        }
        // Escape to close window if not recording
        if (e.code === 'Escape' && !isRecording) {
            window.electronAPI.closeWindow();
        }
        // Double-tap Option/Alt key to toggle recording window
        if ((e.code === 'AltLeft' || e.code === 'AltRight') && !e.repeat) {
            const now = Date.now();
            if (now - lastOptionKeyTime < doubleTapThreshold) {
                e.preventDefault();
                window.electronAPI.toggleRecordingWindow();
                lastOptionKeyTime = 0; // Reset to prevent triple-tap
            } else {
                lastOptionKeyTime = now;
            }
        }
    });

    // Reset Option key timer when key is released
    document.addEventListener('keyup', (e) => {
        if (e.code === 'AltLeft' || e.code === 'AltRight') {
            // Only reset if it's been too long since the first tap
            if (Date.now() - lastOptionKeyTime > doubleTapThreshold) {
                lastOptionKeyTime = 0;
            }
        }
    });

    // Reset Option key timer when window loses focus
    window.addEventListener('blur', () => {
        lastOptionKeyTime = 0;
    });

    // Listen for audio data updates
    window.electronAPI.onAudioData((audioData) => {
        // Cancel any existing animation frame
        if (animationFrameId) {
            cancelAnimationFrame(animationFrameId);
        }
        
        // Schedule the next visualization frame
        animationFrameId = requestAnimationFrame(() => {
            visualize(new Float32Array(audioData));
        });
    });

    // Listen for recording state changes
    window.electronAPI.onRecordingStateChange((recording) => {
        isRecording = recording;
        recordButton.classList.toggle('recording', isRecording);
        recordButton.title = isRecording ? 'Stop Recording' : 'Start Recording';
        
        if (isRecording) {
            startDurationTimer();
        } else {
            stopDurationTimer();
            // Reset visualization
            previousPoints = [];
            maxLevel = 0;
            if (animationFrameId) {
                cancelAnimationFrame(animationFrameId);
                animationFrameId = null;
            }
            drawBaselineWaveform();
        }
    });

    // Cleanup on window unload
    window.addEventListener('unload', () => {
        if (animationFrameId) {
            cancelAnimationFrame(animationFrameId);
        }
    });
}); 