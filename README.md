# HEXO METHOD v4 — Railway

Real Node.js + FFmpeg TikTok optimizer.

## Deploy
Push all files in this folder to the GitHub repository connected to Railway.
Railway should build the included Dockerfile automatically.

Required files:
- Dockerfile
- package.json
- server.js
- index.html

The server uses Railway's PORT automatically and listens on 0.0.0.0.

## Test
Open:
`/api/health`

It should return JSON with `ok: true`.

Process flow:
Upload -> FFprobe -> FFmpeg H.264/AAC -> HEXO METHOD tag -> output verification -> download.

The creator tag is always embedded:
HEXO METHOD
UPLOAD METHOD BY @hexo_orig
