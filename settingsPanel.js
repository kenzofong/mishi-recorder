document.addEventListener('DOMContentLoaded', () => {
    const inputSource = document.getElementById('inputSource');
    const noiseReduction = document.getElementById('noiseReduction');
    const loudnessNorm = document.getElementById('loudnessNorm');
    const vad = document.getElementById('vad');
    const presetButtons = document.querySelectorAll('.preset-button');

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
            inputSource.value = settings.inputDevice.type;
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
        updateSettings({
            inputDevice: {
                type: inputSource.value,
                index: 0 // Default to first device
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
}); 