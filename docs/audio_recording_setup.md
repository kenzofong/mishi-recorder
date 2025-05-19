# Audio Recording Setup in Mishi Recorder

This document outlines the architecture and flow of the audio recording functionality within the Mishi Recorder desktop application.

## Overview

The audio recording system is designed to capture audio from specified input devices (system audio or microphone) using FFmpeg, manage the recording lifecycle, and integrate with other application services for tasks like transcription.

## Key Components and Responsibilities

1.  **`audioRecorder.js` (Core FFmpeg Interaction)**
    *   Directly interfaces with `ffmpeg` using `child_process.spawn`.
    *   **Platform Specificity**: Currently tailored for macOS (`darwin`). It will throw an error if run on other platforms.
    *   **Dependency**: Requires `ffmpeg` to be installed on the system and accessible via the command line PATH. The application checks for FFmpeg on initialization.
    *   **Features**:
        *   Lists available audio input devices using `ffmpeg`.
        *   Caches the list of devices for a short period to improve performance.
        *   Manages `ffmpeg` processes for two main purposes when recording starts:
            *   **Live Audio Visualization:** One `ffmpeg` process outputs raw PCM audio data (16-bit signed little-endian, 16kHz, mono) to its standard output. This stream is captured by the application to generate real-time audio level and waveform data.
            *   **File Recording:** A second `ffmpeg` process, using similar input settings, saves the audio directly to a `.wav` file.
        *   Emits events using Node.js `EventEmitter`:
            *   `ready`: When the recorder has successfully initialized (FFmpeg checked, device validated).
            *   `error`: If any error occurs (e.g., FFmpeg not found, recording process error).
            *   `audioData`: Periodically during recording, containing `{ level, waveform }` calculated from the visualization stream.
        *   Includes an internal `LevelDetector` class for calculating audio levels from the raw audio samples.

2.  **`src/main/recording.js` (Recording Service & Logic)**
    *   Acts as a service layer that abstracts and manages the `AudioRecorder` instance and the overall recording workflow.
    *   **Instantiation of `AudioRecorder`**: The `AudioRecorder` class is instantiated within the `initializeAudioRecorder()` function in this module. This function is called during the application's service initialization (`initRecordingService`) and also defensively before starting a new recording or when changing the audio input device.
    *   **Settings Management**:
        *   Retrieves audio input device settings (which microphone to use or system audio) from `electron-store`.
        *   Provides an `updateAudioDevice()` function to allow changing the input device. This involves:
            *   Stopping any active recording by the old `AudioRecorder` instance.
            *   Saving the new device settings to `electron-store`.
            *   Creating and initializing a new `AudioRecorder` instance with the updated settings, ensuring it becomes `ready`.
    *   **Recording Lifecycle Management**:
        *   `startRecording()`:
            *   Ensures the `AudioRecorder` is initialized.
            *   Interacts with `mishiService` (presumably a module for backend communication) to start a "recording session" (e.g., creating a meeting record in the database).
            *   Calls `audioRecorder.startRecording(tempRecordingPath)` to begin the actual audio capture to a temporary file.
            *   Updates the application's global state (e.g., `isRecording: true`).
        *   `stopRecording()`:
            *   Calls `audioRecorder.stopRecording()` to terminate the `ffmpeg` processes.
            *   Waits for the `.wav` file to be fully written.
            *   Reads the audio data from the temporary file.
            *   Sends the audio data to `mishiService` for transcription.
            *   Performs cleanup of the temporary audio file.
    *   **File Handling**: Manages the path (`tempRecordingPath`) for the temporary `.wav` file, typically located in the app's user data directory.

3.  **`main.js` (Electron Main Process Integration)**
    *   **Service Initialization**: Initializes the `recordingServiceModule` (which is `src/main/recording.js`) when the Electron app is ready.
    *   **IPC Handling**: Sets up Inter-Process Communication (IPC) handlers via `setupIPCHandlers()`. These handlers allow renderer processes (UI windows like the tray menu or a dedicated recording UI) to trigger recording actions (e.g., 'start-recording', 'stop-recording', 'update-audio-device'). These IPC calls are then routed to the appropriate functions in the `recordingServiceModule`.
    *   **Audio Visualization Relay**:
        *   The `main.js` file contains logic (e.g., `startAudioVisualization` function) to listen for the `audioData` events emitted by the `audioRecorder` instance (managed by `recordingServiceModule`).
        *   It then forwards the audio `level` and `waveform` data to the `recordingWindow` renderer process via IPC (`recordingWindow.webContents.send('audio-data', data)`), allowing the UI to display real-time audio feedback.
    *   **Global Settings Store**: The `electron-store` instance is initialized in `main.js` and passed as a dependency to services like `recordingServiceModule` that require access to persisted settings.

### System Audio Recording (macOS Specifics)

While the application supports system audio recording, its implementation on macOS using `ffmpeg` with `avfoundation` has specific considerations:

*   **Dependency on Virtual Audio Devices**: To reliably capture the system's mixed audio output (what you hear through speakers/headphones), a virtual audio loopback device is typically required. The project `README.md` recommends "BlackHole" for this.
    *   **Reasoning**: macOS, for security and privacy reasons, does not natively expose the complete system audio output as a standard selectable input device that `ffmpeg` (via `avfoundation`) can directly target. Virtual audio devices like BlackHole create a software-based "loopback," routing system output to a virtual input that `ffmpeg` can then select.
*   **Device Selection**:
    *   When `inputDevice.type` is set to `'system'` in `audioRecorder.js`, `ffmpeg` uses `':0'` as the input. This typically refers to the *default system input device*. If a virtual loopback device like BlackHole is installed *and* set as the default system input, this method might capture system audio.
    *   A more explicit and often more reliable method is to select the virtual audio device (e.g., "BlackHole 2ch") by its specific index after it has been installed. The application allows for selecting devices by index.
*   **Alternatives for "Built-in" System Audio Capture**:
    *   Implementing system audio capture without requiring the user to install a separate utility like BlackHole is complex on macOS.
    *   Approaches like bundling a custom virtual audio driver or re-architecting the capture mechanism to use Apple's ScreenCaptureKit framework (which can capture system audio alongside screen content) are possible but represent significant development effort and introduce different sets of user permissions or system integration challenges. The current architecture relies on `ffmpeg` and its `avfoundation` module, which benefits from the use of such external virtual audio devices for this specific use case.

## Audio Recording Flow

1.  **Initialization**:
    *   On application startup (`app.on('ready')`), `main.js` initializes the `recordingServiceModule`.
    *   Within `recordingServiceModule`, `initializeAudioRecorder()` is called. It reads the persisted input device settings from `electron-store` (or uses defaults) and creates an `AudioRecorder` instance.

2.  **Starting a Recording**:
    *   A user action in a renderer process (e.g., clicking a "Start Recording" button) triggers an IPC message to the main process.
    *   The corresponding IPC handler in `main.js` invokes `recordingServiceModule.startRecording()`.
    *   `recordingServiceModule` ensures the `AudioRecorder` is initialized (re-initializing if necessary), communicates with `mishiService` to log the recording session, and then calls `audioRecorder.startRecording(tempFilePath)`.
    *   `audioRecorder.js` spawns the two `ffmpeg` processes: one for writing to `tempFilePath` and another for providing the visualization data stream.

3.  **During Recording (Visualization)**:
    *   The `ffmpeg` visualization process in `audioRecorder.js` streams raw audio data.
    *   `audioRecorder.js` processes this stream, calculates level/waveform, and emits `audioData` events.
    *   Logic in `main.js` (or potentially `src/main/recording.js` which also has some visualization placeholders) listens for these events and sends the visualization data to the `recordingWindow` via IPC.
    *   The `recordingWindow` UI displays the audio level and/or waveform.

4.  **Stopping a Recording**:
    *   A user action triggers an IPC message to stop the recording.
    *   The IPC handler in `main.js` calls `recordingServiceModule.stopRecording()`.
    *   `recordingServiceModule` calls `audioRecorder.stopRecording()`, which signals the `ffmpeg` processes to terminate.
    *   Once the file is written and `ffmpeg` exits, `recordingServiceModule` reads the `.wav` file, sends its content to `mishiService` for transcription, and then cleans up the temporary file.

## Settings Persistence

*   Audio input device preferences (e.g., selected microphone index and type) are stored using `electron-store`.
*   The schema for these settings is defined in `main.js`, but the `src/main/recording.js` module is primarily responsible for reading these settings when initializing `AudioRecorder` and writing them when the device is updated.

## Output Format (Initial Capture)

*   The initial audio recordings are captured and saved as uncompressed `.wav` files.
*   The format used by `ffmpeg` is PCM signed 16-bit little-endian, 16kHz sampling rate, single channel (mono).
*   Further processing, such as conversion to Opus format (as mentioned in the project's main `README.md`) or application of advanced audio filters, likely occurs after this initial WAV capture, potentially orchestrated by `mishiService` or another part of the system before final storage or use. The code analyzed primarily focuses on this initial `.wav` capture stage. 