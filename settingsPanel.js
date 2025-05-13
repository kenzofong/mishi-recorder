document.addEventListener('DOMContentLoaded', () => {
    const inputSource = document.getElementById('inputSource');
    const noiseReduction = document.getElementById('noiseReduction');
    const loudnessNorm = document.getElementById('loudnessNorm');
    const vad = document.getElementById('vad');
    const presetButtons = document.querySelectorAll('.preset-button');

    // Function to populate the audio input devices dropdown
    function populateAudioInputDevices(devices) {
        if (!inputSource) return;
        const currentVal = inputSource.value; // Store current value to try and reselect

        // Clear existing options (except a potential default or placeholder if any)
        while (inputSource.options.length > 0) {
            inputSource.remove(0);
        }

        // Add a default/placeholder option if desired (optional)
        // const defaultOption = document.createElement('option');
        // defaultOption.value = "";
        // defaultOption.textContent = "Select a device...";
        // inputSource.appendChild(defaultOption);

        devices.forEach(device => {
            const option = document.createElement('option');
            // We'll use the format "type:index" as value, e.g., "avfoundation:1"
            // This assumes the main process can handle this format or we adapt it later.
            // For now, let's assume settings store just the 'index' for avfoundation devices.
            option.value = device.index; // Or `avfoundation:${device.index}` if we want to be more specific
            option.textContent = device.name;
            inputSource.appendChild(option);
        });

        // Try to reselect the previous value if it still exists
        if (Array.from(inputSource.options).some(opt => opt.value === currentVal)) {
            inputSource.value = currentVal;
        } else if (devices.length > 0) {
            // Or select the first available device if the old one is gone
            inputSource.value = devices[0].index; 
            // Trigger change to save the new default if necessary
            inputSource.dispatchEvent(new Event('change')); 
        }
    }

    // Handle window close with animation
    window.electronAPI.onBeforeHide(() => {
        document.body.classList.add('hiding');
    });

    // Audio processing presets
    const presets = {
        meeting: {
            noiseReduction: true,
            loudnessNorm: true,
            vad: false,
            processing: {
                noiseReduction: {
                    nr: 10,
                    nf: -25,
                    nt: 'w'
                },
                loudnessNorm: {
                    targetLevel: -16,
                    truePeak: -1.5
                }
            }
        },
        voice: {
            noiseReduction: true,
            loudnessNorm: true,
            vad: true,
            processing: {
                noiseReduction: {
                    nr: 15,
                    nf: -30,
                    nt: 'w'
                },
                loudnessNorm: {
                    targetLevel: -14,
                    truePeak: -1
                },
                vad: {
                    threshold: -30,
                    duration: 0.5
                }
            }
        },
        music: {
            noiseReduction: false,
            loudnessNorm: true,
            vad: false,
            processing: {
                loudnessNorm: {
                    targetLevel: -18,
                    truePeak: -2
                }
            }
        }
    };

    // Load initial settings
    function loadSettings() {
        window.electronAPI.getSettings().then(settings => {
            // Defensive defaults
            if (!settings.processing) settings.processing = {};
            if (!settings.processing.noiseReduction) settings.processing.noiseReduction = { enabled: false };
            if (!settings.processing.loudnessNorm) settings.processing.loudnessNorm = { enabled: false };
            if (!settings.processing.vad) settings.processing.vad = { enabled: false };

            // Ensure inputDevice and its properties exist
            if (!settings.inputDevice) settings.inputDevice = { type: 'avfoundation', index: 0, name: '' }; // Default to first avfoundation if not set
            if (typeof settings.inputDevice.index === 'undefined') settings.inputDevice.index = 0;

            // If the stored type is avfoundation, use its index. Otherwise, old values might not match.
            // The populateAudioInputDevices function will select the first available device if no match is found.
            if (settings.inputDevice.type === 'avfoundation') {
                inputSource.value = settings.inputDevice.index.toString();
            } else {
                // For old types 'system' or 'mic', their value might not directly map to an index.
                // The populateAudioInputDevices function handles selecting a default if current value doesn't exist.
                // We can attempt to set it, but it might not be found if options changed.
                inputSource.value = settings.inputDevice.type; 
            }

            noiseReduction.checked = settings.processing.noiseReduction.enabled;
            loudnessNorm.checked = settings.processing.loudnessNorm.enabled;
            vad.checked = settings.processing.vad.enabled;

            // Update preset button states
            updatePresetButtonStates(settings);
        });
    }

    // Update settings in electron-store
    function updateSettings(changes) {
        window.electronAPI.updateSettings(changes);
    }

    // Handle input source change
    inputSource.addEventListener('change', () => {
        const selectedOption = inputSource.options[inputSource.selectedIndex];
        if (!selectedOption) return; // Should not happen if list is populated

        updateSettings({
            inputDevice: {
                type: 'avfoundation', // Set type to avfoundation for these devices
                index: parseInt(inputSource.value, 10), // This is the device.index
                name: selectedOption.textContent      // Get the name from the selected option
            }
        });
    });

    // Handle individual setting toggles
    noiseReduction.addEventListener('change', () => {
        updateSettings({
            processing: {
                noiseReduction: {
                    enabled: noiseReduction.checked
                }
            }
        });
    });

    loudnessNorm.addEventListener('change', () => {
        updateSettings({
            processing: {
                loudnessNorm: {
                    enabled: loudnessNorm.checked
                }
            }
        });
    });

    vad.addEventListener('change', () => {
        updateSettings({
            processing: {
                vad: {
                    enabled: vad.checked
                }
            }
        });
    });

    // Handle preset selection
    presetButtons.forEach(button => {
        button.addEventListener('click', () => {
            const preset = presets[button.dataset.preset];
            
            // Update UI
            noiseReduction.checked = preset.noiseReduction;
            loudnessNorm.checked = preset.loudnessNorm;
            vad.checked = preset.vad;

            // Update active state
            presetButtons.forEach(btn => btn.classList.remove('active'));
            button.classList.add('active');

            // Update settings
            updateSettings({
                processing: {
                    noiseReduction: {
                        enabled: preset.noiseReduction,
                        ...preset.processing.noiseReduction
                    },
                    loudnessNorm: {
                        enabled: preset.loudnessNorm,
                        ...preset.processing.loudnessNorm
                    },
                    vad: {
                        enabled: preset.vad,
                        ...(preset.processing.vad || {})
                    }
                }
            });
        });
    });

    // Compare settings with presets to determine active preset
    function updatePresetButtonStates(settings) {
        const matchesPreset = (preset) => {
            return preset.noiseReduction === settings.processing.noiseReduction.enabled &&
                   preset.loudnessNorm === settings.processing.loudnessNorm.enabled &&
                   preset.vad === settings.processing.vad.enabled;
        };

        presetButtons.forEach(button => {
            const preset = presets[button.dataset.preset];
            button.classList.toggle('active', matchesPreset(preset));
        });
    }

    // Handle theme changes
    window.electronAPI.onSystemThemeChange((isDark) => {
        // Theme is handled by CSS, but we could add additional theme-specific logic here
    });

    // Load initial settings
    loadSettings();

    // Log FFmpeg device list for debugging
    window.electronAPI.listAudioInputDevices().then(res => {
        if (res.success) {
            console.log('FFmpeg raw device output:\n', res.rawOutput);
            console.log('Parsed devices:', res.devices);
            populateAudioInputDevices(res.devices); // Call the new function here
        } else {
            console.error('Failed to list audio input devices:', res.error);
        }
    });
}); 