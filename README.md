# HEXO METHOD v5 — Railway

Real FFmpeg TikTok optimizer with a speed-first H.264 pipeline.

## Deploy
Upload/replace the repository files with these files and commit. Railway will rebuild the Docker image.

## Encoding defaults
- H.264 / libx264
- TikTok default: CRF 19 + `superfast`
- Maximum Quality: CRF 18 + `veryfast`
- Preserve original FPS by default
- AAC 192 kbps
- yuv420p
- +faststart
- `threads 0` to let FFmpeg use available CPU threads

## Branding
When the watermark option is enabled, the output gets:
`UPLOAD METHOD BY @hexo_orig`

Processed files are stored temporarily and scheduled for deletion after 1 hour.
