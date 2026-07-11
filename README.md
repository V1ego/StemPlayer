# ilya - AI Stem Player

AI-powered audio stem separator and player. Load any song, and AI automatically separates it into 4 tracks: Vocals, Drums, Bass, and Other. Control each track independently with volume, mute, and solo. Features generative art visualization driven by real-time audio analysis.

## Features

- **AI Stem Separation** — Powered by Demucs, splits any audio into 4 isolated stems
- **Independent Track Control** — 5-step volume control, mute, and solo for each stem
- **Generative Art Visualizer** — Real-time visualization driven by audio analysis (p5.js)
- **NetEase Cloud Music** — QR code login, browse playlists, batch separation
- **File Upload** — Drag & drop or click to upload (MP3, WAV, M4A, FLAC, OGG, AAC, NCM)
- **Built-in Demos** — Two synthesised multi-stem demos (Nocturne, Punch 808)
- **Keyboard Shortcuts** — Space for play/pause, Escape to close overlay
- **Portable** — Single executable, no installation required

## Tech Stack

- **Frontend:** Vanilla JS, Web Audio API, p5.js
- **Backend:** Python Flask, Demucs (PyTorch)
- **Desktop:** Electron
- **Music API:** NeteaseCloudMusicApi (Node.js proxy)

## Development

### Prerequisites

- Python 3.11+
- Node.js 18+
- FFmpeg (shared libraries)

### Setup

```bash
# Install Python dependencies
python -m venv .venv
.venv\Scripts\activate   # Windows
pip install -r resources/app/requirements.txt

# Install Node.js dependencies
cd resources/app
npm install

# Run in development
python resources/app/run.py
```

Open http://127.0.0.1:5000 in your browser.

### Build

```bash
cd resources/app
npm run build        # Portable .exe
npm run build:portable
```

## Project Structure

```
StemPlayer/
├── ilya.exe                    # Packaged Electron app
├── resources/
│   ├── app/
│   │   ├── electron/main.js    # Electron main process
│   │   ├── app/                # Python Flask backend
│   │   │   ├── server.py       # Routes & API
│   │   │   ├── jobs.py         # Job queue (Demucs)
│   │   │   ├── ncm.py          # NCM file decryption
│   │   │   └── config.py       # Configuration
│   │   ├── static/             # Frontend assets
│   │   │   ├── index.html
│   │   │   ├── css/style.css
│   │   │   └── js/
│   │   │       ├── app.js          # Main entry / state machine
│   │   │       ├── audio-engine.js # Web Audio engine
│   │   │       ├── viz.js          # Generative art visualizer
│   │   │       ├── ui.js           # DOM controller
│   │   │       ├── netease.js      # NetEase integration
│   │   │       ├── demo-synth.js   # Demo synthesizer
│   │   │       └── utils.js        # Helpers
│   │   ├── run.py              # Entry point
│   │   └── netease_proxy.js    # NetEase API proxy
│   └── .ffmpeg/                # FFmpeg shared libraries
├── .gitignore
├── LICENSE
└── README.md
```

## License

MIT
