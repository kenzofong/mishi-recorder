# Mishi Recorder

A desktop application for recording and automatically transcribing meetings using Supabase and AssemblyAI integration.

## Features

- 🎙️ High-quality audio recording
- 📝 Real-time transcription
- 🔄 Automatic sync with Mishi web app
- 🔒 Secure authentication
- 💾 Local recording backup
- 📊 Meeting analytics (sentiment analysis, key phrases, topics)

## Prerequisites

- Node.js (v16 or higher)
- npm or yarn
- Supabase account and project
- AssemblyAI API key

## Installation

1. Clone the repository:
```bash
git clone https://github.com/kenzofong/mishi-recorder.git
cd mishi-recorder
```

2. Install dependencies:
```bash
npm install
```

3. Create a `.env` file based on `.env.example`:
```bash
cp .env.example .env
```

4. Configure your environment variables in `.env`:
```
SUPABASE_URL=your_supabase_project_url
SUPABASE_KEY=your_supabase_anon_key
ASSEMBLYAI_API_KEY=your_assemblyai_api_key
```

## Development

Start the application in development mode:

```bash
npm start
```

## Building

Build the application for production:

```bash
npm run build
```

## Architecture

The application uses:
- Electron for the desktop application framework
- Supabase for backend and real-time updates
- AssemblyAI for audio transcription
- WebAudio API for recording

Key components:
- `main.js`: Electron main process
- `audioRecorder.js`: Audio recording functionality
- `mishiIntegration.js`: Supabase integration and meeting management
- `preload.js`: Electron preload script

## Database Schema

The application interacts with the following Supabase tables:
- `meetings`: Stores meeting metadata and transcriptions
- `workspace_members`: Manages user workspace access
- `companies`: Organization management

For detailed schema information, see `docs/database.md`.

## Contributing

1. Fork the repository
2. Create your feature branch (`git checkout -b feature/amazing-feature`)
3. Commit your changes (`git commit -m 'Add some amazing feature'`)
4. Push to the branch (`git push origin feature/amazing-feature`)
5. Open a Pull Request

## License

This project is proprietary software. All rights reserved.

## Support

For support, please contact the development team or refer to the documentation in the `docs` directory. 