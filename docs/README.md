# Mishi Recorder

A minimal Electron desktop application for macOS (cross-platform possible) to record system audio output or microphone input with advanced audio processing, and upload it to Supabase Storage. Interaction is primarily through a system tray / status bar icon.

## Core Features

*   **Tray-Based Interface:** Main interaction via the system tray icon menu.
*   **Flexible Audio Input:**
    * **System Audio Recording:** Captures system audio output.
    * **Microphone Recording:** High-quality microphone input with audio processing.
*   **Advanced Audio Processing:**
    * **Noise Reduction:** Adaptive frequency-domain noise reduction using FFmpeg's `afftdn` filter.
    * **Loudness Normalization:** Professional-grade EBU R128 normalization using `loudnorm`.
    * **Voice Activity Detection:** Optional silence detection and logging.
    * **Dynamic Range Control:** Optional compression for consistent audio levels.
*   **FFmpeg Integration:** Uses FFmpeg for recording, processing, and encoding.
*   **Opus Encoding:** Encodes audio to the efficient Opus format with voice optimization.
*   **Supabase Integration:**
    *   Authentication (Email/Password example provided).
    *   Storage for uploading recordings.
*   **State Management:** Dynamically updates the tray menu based on login and recording status.
*   **Session Persistence:** Uses `electron-store` to remember login sessions.

## Prerequisites

1.  **Node.js and npm/yarn:** Required for running the Electron application and managing dependencies. Download from [nodejs.org](https://nodejs.org/).
2.  **FFmpeg:** Needs to be installed on the system and accessible via the command line PATH.
    *   **macOS (Homebrew):** `brew install ffmpeg`
    *   **Other Platforms:** Download from [ffmpeg.org](https://ffmpeg.org/download.html) and ensure it's added to your system's PATH.
3.  **Audio Input Setup:**
    *   **For System Audio (macOS):** BlackHole virtual audio device recommended
        *   **Homebrew:** `brew install blackhole-2ch`
        *   **Manual:** Download from [Existential Audio](https://existential.audio/blackhole/)
    *   **For Microphone:** No additional software needed, uses system microphones

## Setup and Installation

1.  **Clone the Repository:**
    ```bash
    git clone <your-repository-url>
    cd mishi-recorder
    ```
2.  **Install Dependencies:**
    ```bash
    npm install
    # or
    yarn install
    ```
3.  **Configure Environment Variables:**
    *   Copy the example environment file:
        ```bash
        cp .env.example .env
        ```
    *   Open the newly created `.env` file.
    *   Replace `YOUR_SUPABASE_URL_HERE` and `YOUR_SUPABASE_ANON_KEY_HERE` with your actual Supabase project URL and Anon Key.
    *   **Security Note:** The `.gitignore` file is configured to prevent committing the `.env` file to version control.
    *   Ensure you have a Supabase Storage bucket named `recordings` (or update the `RECORDINGS_BUCKET` constant in `main.js`). Set appropriate Bucket policies (e.g., allow authenticated uploads) and Row Level Security on the `storage.objects` table if needed.

4.  **Configure Audio Input:**
    *   List available audio devices:
        ```javascript
        const recorder = new AudioRecorder();
        const devices = await AudioRecorder.listMicrophones();
        console.log(devices);
        ```
    *   For system audio on macOS, find BlackHole's device index.
    *   For microphone input, note the index of your preferred microphone.

5.  **Add Tray Icon:**
    *   Ensure the `assets` directory exists in the project root.
    *   Place a suitable `iconTemplate.png` (black & transparent recommended for macOS) inside the `assets` directory.

## Audio Processing Configuration

The recorder supports various audio processing options that can be configured when starting a recording:

```javascript
await recorder.startRecording(outputPath, {
    // Basic settings
    opusBitrate: '64k',
    sampleRate: 48000,
    
    // Audio processing filters
    filters: {
        // Noise Reduction
        noiseReduction: {
            enabled: true,
            nr: 10,        // Noise reduction level (0-97)
            nf: -25,       // Noise floor (dB)
            nt: 'w'        // Noise type (w=white, v=vinyl)
        },
        // Loudness Normalization
        loudnessNorm: {
            enabled: true,
            targetLevel: -16,  // LUFS target level
            truePeak: -1.5     // True peak limit (dBTP)
        },
        // Dynamic Range Compression (alternative to loudnorm)
        compression: {
            enabled: false,    // Disabled by default
            threshold: -20,    // Threshold (dB)
            ratio: 3,         // Compression ratio
            attack: 0.1,      // Attack time (seconds)
            release: 0.2      // Release time (seconds)
        },
        // Voice Activity Detection
        vad: {
            enabled: false,    // Disabled by default
            threshold: -30,    // Noise threshold (dB)
            duration: 0.5      // Minimum silence duration (seconds)
        }
    }
});
```

## Running the Application

```bash
npm start
# or
yarn start
```

The application icon should appear in your system tray / status bar.

## Workflow

1.  **Start:** The app initializes, checks for a saved session, and displays the tray menu.
2.  **Login:** Click "Login", enter credentials in the popup window. On success, the menu updates.
3.  **Configure Input:** Select between system audio or microphone input.
4.  **Start Recording:** Click "Start Recording". The status updates, and recording begins with the configured audio processing.
5.  **Stop Recording:** Click "Stop Recording". The recording stops, the file is processed, the status changes to "Uploading".
6.  **Upload:** The processed Opus file is uploaded to your Supabase Storage bucket.
7.  **Status:** Updates to "Idle" on successful upload or "Error" if something fails.
8.  **Logout:** Clears the session, updates the menu.
9.  **Quit:** Stops any recording and exits the application.

## Key Dependencies

*   [Electron](https://www.electronjs.org/): Framework for building cross-platform desktop apps.
*   [@supabase/supabase-js](https://supabase.com/docs/library/js/getting-started): Client library for interacting with Supabase.
*   [fluent-ffmpeg](https://github.com/fluent-ffmpeg/node-fluent-ffmpeg): Node.js wrapper for FFmpeg.
*   [electron-store](https://github.com/sindresorhus/electron-store): Simple data persistence for Electron apps.

## Potential Improvements

*   Bundle FFmpeg using `electron-builder` or `electron-forge`.
*   Implement robust error handling and user feedback (dialogs, logging).
*   Use `electron-keytar` for more secure credential storage.
*   Add UI for audio processing configuration.
*   Add real-time audio level monitoring.
*   Implement audio processing presets for different scenarios.
*   Add visual indicators for recording/uploading state on the tray icon.
*   Implement OAuth login options.
*   Add build scripts for packaging the application. 