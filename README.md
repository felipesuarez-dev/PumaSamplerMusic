<div align="center">

<img src="src/public/logo.png" alt="PumaSamplerMusic" width="180" />

# PumaSamplerMusic

**Turn YouTube videos into a keyboard sampler.** Download a video, pick any slice of time, and assign it to a key. Press the key — hear the audio and see the video play.

[![Docker][docker-badge]][docker-link]
[![Node.js][node-badge]][node-link]
[![License][license-badge]](LICENSE)
[![PumaSoft][pumasoft-badge]][pumasoft-link]

[Download / Run](#quick-start) · [How it works](#how-it-works) · [Features](#features) · [Architecture](#architecture) · [Development](#development)

</div>

---

## Problem

Creating samplers from online videos is usually a multi-tool workflow: download with one app, cut with another, load into a DAW, map to MIDI. You just want a quick way to grab a kick from a drum video, a vocal stab from a live set, or a bass hit from a tutorial and play it from your keyboard.

PumaSamplerMusic solves that in one browser window: paste a YouTube URL, mark a slice, assign a key, play.

## Solution

- **Full video download** — `yt-dlp` downloads the complete video; `ffmpeg` extracts the audio track.
- **Up to 27 assignable pads** — each pad can bind to any keyboard key (or combination like `shift+a`).
- **Time-slice editor** — waveform display with drag handles, plus transport controls (play, mark in, mark out) to set the exact segment while the video is playing.
- **Polyphonic playback** — Web Audio API plays audio buffers at low latency; multiple pads can overlap.
- **Session persistence** — save/load your pad layout as a JSON file.
- **Runs in Docker** — single container, one port, no local Node.js or Python required.

## Quick Start

```bash
cd /opt/pumasamplermusic
./manage.sh start
```

Open http://localhost:4070

## How it works

1. **Add a video** — paste a YouTube URL in the **Video Library** tab and click **Add Video**.
2. **Wait for the download** — the backend downloads the full video and extracts the audio.
3. **Edit a pad** — click one of the pads. Pick the video, assign a key, and set the time segment.
4. **Use the transport** — click **Play Preview** to watch the video, then **Set In** and **Set Out** to mark the slice. Or drag the waveform handles directly.
5. **Play** — press the assigned key. The audio plays through Web Audio API and the video appears in the visualizer.
6. **Save your session** — give it a name and load it later.

## Features

| Area | What it does |
|---|---|
| **Video Library** | Add YouTube URLs, see download progress, remove cached videos, view title + duration |
| **Pad Grid** | Click to edit, press assigned key to trigger, activity LED when a pad is playing |
| **Pad Editor** | Label, key, volume, color, trigger mode (one-shot / gate), loop, waveform segment editor |
| **Transport** | Play preview, mark in, mark out, stop; playhead synced to the video position |
| **Session Manager** | Save/load/delete session JSON files |
| **Global Stop** | STOP button or **Escape** key silences all pads and pauses the video |
| **Docker** | One command to build, run, backup, and update |

## Architecture

```mermaid
flowchart TD
    subgraph Browser["Browser · Vanilla JS ES modules"]
        UI[UI Layer] --> Pads[pad grid (up to 27) + keyboard]
        UI --> Editor[Pad editor + transport]
        Pads --> AudioEngine[Web Audio Engine]
        Editor --> Waveform[Waveform canvas]
        Editor --> VideoPreview[Hidden preview video]
        AudioEngine --> MainGain[Master gain]
        MainGain --> Speakers[Speakers]
    end

    UI -->|HTTP + WebSocket| API
    AudioEngine -->|fetch| Files
    VideoPreview -->|src| Files

    subgraph Docker["Docker Container · Node.js 22"]
        API[Express API]
        WS[WebSocket server]
        Downloader[yt-dlp downloader]
        Ffmpeg[ffmpeg audio extractor]
        Store[Video store + session store]
        API --> Downloader
        API --> Store
        Downloader --> Ffmpeg
    end

    subgraph Data["Persistent Data"]
        Videos["./data/videos — video + audio files"]
        Sessions["./data/sessions — JSON sessions"]
    end

    Files --> Videos
    Store --> Videos
    Store --> Sessions

    API -.->|download progress| WS
    WS -.->|video:ready| Browser
```

Rule: the frontend only downloads audio buffers via HTTP; the backend handles all YouTube traffic, video download, and audio extraction. Sessions are plain JSON files.

## Tech Stack

| Frontend | Backend | DevOps |
|---|---|---|
| Vanilla JS ES modules | Node.js 22 | Docker + docker-compose |
| Web Audio API | Express | `manage.sh` wrapper |
| HTML5 `<video>` | `ws` library | HEALTHCHECK |
| Canvas waveform | yt-dlp | bind-mount `./data` |
| CSS Grid + custom properties | ffmpeg | node user (uid 1000) |

## Development

```bash
# Start container in background
./manage.sh start

# View logs
./manage.sh logs

# Stop
./manage.sh stop

# Rebuild image
./manage.sh update

# Backup data + config
./manage.sh backup
```

## Configuration

Edit `docker-compose.yml`:

| Variable | Default | Meaning |
|---|---|---|
| `MAX_CACHE_GB` | 10 | Max disk space for cached videos |
| `MAX_CONCURRENT_DOWNLOADS` | 2 | Parallel downloads |
| `TZ` | America/Santiago | Timezone |
| `PORT` | 4070 | Internal + external port |

## Data Layout

```
./data/videos/   — downloaded videos (.mp4) + extracted audio (.opus)
./data/sessions/ — saved session JSON files
```

## Notes

- Only YouTube URLs are accepted (`youtube.com/watch?v=...` and `youtu.be/...`).
- First playback of a video may have a short load time while the browser decodes the audio buffer.
- One-shot mode plays the full segment on key press; gate mode plays while the key is held.
- The video cache uses disk, not RAM, because full 1080p videos exceed practical tmpfs limits.

## Author

<div align="center">

<img src="src/public/logo.png" alt="PumaSoft" width="80" />

**[PumaSoft][pumasoft-link]**

</div>

## License

MIT © 2026 PumaSoft — see [LICENSE](LICENSE).

[docker-badge]: https://img.shields.io/badge/Docker-2496ED?style=flat-square&logo=docker&logoColor=white
[docker-link]: https://www.docker.com
[node-badge]: https://img.shields.io/badge/Node.js-22-339933?style=flat-square&logo=node.js&logoColor=white
[node-link]: https://nodejs.org
[license-badge]: https://img.shields.io/badge/license-MIT-a8d8a8?style=flat-square
[pumasoft-badge]: https://img.shields.io/badge/by-PumaSoft-ff9f1c?style=flat-square
[pumasoft-link]: https://github.com/felipesuarez-dev
