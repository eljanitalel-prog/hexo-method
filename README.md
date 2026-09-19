# HEXO METHOD — Real FFmpeg TikTok Optimizer v3

## Railway
1. Upload these files to your GitHub repository.
2. Railway deploys the repository using the Dockerfile.
3. Docker installs FFmpeg, FFprobe and DejaVu fonts.
4. The app listens on Railway's PORT automatically.

## What is real
- `/api/analyze` uses FFprobe for exact media metadata.
- `/api/process` runs real FFmpeg H.264/AAC encoding.
- Processing progress comes from FFmpeg `-progress pipe:1`.
- Output is MP4 with `+faststart`.
- Original FPS is preserved with passthrough when possible.
- Every exported video receives the HEXO METHOD / @hexo_orig creator tag.
- Temporary files are removed after processing/download/timeout.

## Note
The estimated size shown before processing is only an estimate. The final size is measured from the actual FFmpeg output.
