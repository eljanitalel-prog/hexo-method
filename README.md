# HEXO METHOD v5.2

Changes:
- Video watermark/overlay is completely disabled. No `drawtext`, no `UPLOAD METHOD BY @hexo_orig` burned into the video.
- TikTok caption remains `Upload Method → @hexo_orig` and is returned by `/api/process` for the frontend to display/copy.
- Preserve Original FPS is the default.
- FFmpeg uses `-fps_mode passthrough` and does not add `-r` when preserving FPS.
- Output is H.264/AAC MP4 with CRF 19, superfast, yuv420p, +faststart.
- Output reports whether measured FPS stayed within 1% of the source.

Replace `server.js`, `package.json`, and `Dockerfile` in the existing GitHub repository. Keep your existing `index.html` if you want to preserve the current UI.
