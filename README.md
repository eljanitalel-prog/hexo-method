# HEXO METHOD — TikTok Video Optimizer

This version turns the original UI into a real video-processing application.

## What changed

The original page was a front-end demo: it simulated compression progress, estimated the output size with a ratio, and downloaded the original file again. The new version uses a Node.js backend with real FFmpeg/FFprobe processing.

### Real workflow

1. Upload video.
2. FFprobe reads the real resolution, FPS, duration, codecs and bitrate.
3. Server creates a temporary processing job.
4. FFmpeg encodes the video to MP4/H.264 + AAC.
5. Original FPS is preserved by default.
6. Optional resolution/aspect settings are applied.
7. A creator tag is automatically burned into every exported video:
   - `HEXO METHOD`
   - `UPLOAD METHOD BY @hexo_orig`
8. The output is available as an MP4 download.
9. Temporary job files are removed after one hour.

## Requirements

- Node.js 18+
- npm
- No system FFmpeg installation is normally required because the project includes `ffmpeg-static` and `ffprobe-static`.

## Run locally

```bash
npm install
npm start
```

Open:

`http://localhost:3000`

## Deploy

This is a long-running Node/Express + FFmpeg application. Use a host that supports background Node processes and temporary disk, such as a VPS, Render, Railway, Replit, or another Node server.

Do not deploy this as a static-only site.

## Important quality note

TikTok can re-encode videos after upload. No website can guarantee zero quality loss after TikTok's own processing. This application creates a high-quality H.264 source and preserves the original FPS by default to minimize unnecessary degradation.

## Security

- Uploads are stored temporarily.
- File names are never passed directly into shell commands.
- FFmpeg is invoked with argument arrays, not a shell string.
- Temporary files are automatically deleted after one hour.
- Upload size defaults to 2 GB and can be changed with `MAX_UPLOAD_BYTES`.
- Set `FONT_FILE` if your server does not have a usable font for FFmpeg's `drawtext`.

## Branding

Every exported video contains the HEXO METHOD creator tag by design.
