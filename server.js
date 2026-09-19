const express = require('express');
const multer = require('multer');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');

const app = express();
const PORT = Number(process.env.PORT || 8080);
const ROOT = __dirname;
const WORK = path.join('/tmp', 'hexo-method');
const JOBS = new Map();

fs.mkdirSync(WORK, { recursive: true });

app.use(express.json({ limit: '1mb' }));
app.use(express.static(ROOT, { index: 'index.html' }));

const upload = multer({
  dest: WORK,
  limits: { fileSize: 2 * 1024 * 1024 * 1024 } // 2 GB
});

function safeId() {
  return crypto.randomBytes(12).toString('hex');
}

function runProbe(file) {
  return new Promise((resolve, reject) => {
    const p = spawn('ffprobe', [
      '-v', 'error',
      '-print_format', 'json',
      '-show_streams',
      '-show_format',
      file
    ]);
    let out = '', err = '';
    p.stdout.on('data', d => out += d);
    p.stderr.on('data', d => err += d);
    p.on('error', reject);
    p.on('close', code => {
      if (code !== 0) return reject(new Error(err || `ffprobe exited ${code}`));
      try { resolve(JSON.parse(out)); }
      catch { reject(new Error('Invalid ffprobe JSON')); }
    });
  });
}

function rationalToNumber(v, fallback = 30) {
  if (!v) return fallback;
  const parts = String(v).split('/');
  if (parts.length === 2 && Number(parts[1])) return Number(parts[0]) / Number(parts[1]);
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function bytes(n) {
  const units = ['B','KB','MB','GB'];
  let x = Number(n) || 0, i = 0;
  while (x >= 1024 && i < units.length - 1) { x /= 1024; i++; }
  return `${x.toFixed(i ? 2 : 0)} ${units[i]}`;
}

function outputMeta(probe, stat) {
  const vs = probe.streams.find(s => s.codec_type === 'video') || {};
  const as = probe.streams.find(s => s.codec_type === 'audio') || {};
  const duration = Number(probe.format?.duration || 0);
  const fps = rationalToNumber(vs.avg_frame_rate || vs.r_frame_rate, 30);
  return {
    sizeBytes: stat.size,
    sizeFormatted: bytes(stat.size),
    width: Number(vs.width || 0),
    height: Number(vs.height || 0),
    fps: Math.round(fps * 100) / 100,
    duration,
    durationFormatted: duration > 0 ? `${Math.floor(duration/60)}:${String(Math.floor(duration%60)).padStart(2,'0')}` : '—',
    videoCodec: vs.codec_name || 'unknown',
    audioCodec: as.codec_name || 'unknown',
    bitrate: Number(probe.format?.bit_rate || 0),
    bitrateFormatted: bytes(Number(probe.format?.bit_rate || 0) / 8) + '/s'
  };
}

function filterFor(options) {
  const res = options.resolution || 'original';
  const ar = options.aspectRatio || 'keep';
  let vf = [];

  if (res === '1080x1920') {
    if (ar === 'crop') vf.push("scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920");
    else if (ar === 'fit') vf.push("scale=1080:1920:force_original_aspect_ratio=decrease,pad=1080:1920:(ow-iw)/2:(oh-ih)/2:color=black");
    else vf.push("scale=1080:1920:force_original_aspect_ratio=decrease");
  } else if (res === '720x1280') {
    if (ar === 'crop') vf.push("scale=720:1280:force_original_aspect_ratio=increase,crop=720:1280");
    else if (ar === 'fit') vf.push("scale=720:1280:force_original_aspect_ratio=decrease,pad=720:1280:(ow-iw)/2:(oh-ih)/2:color=black");
    else vf.push("scale=720:1280:force_original_aspect_ratio=decrease");
  } else if (ar === 'crop') {
    vf.push("crop=ih*9/16:ih:(iw-ih*9/16)/2:0");
  }

  // Keep H.264/yuv420p compatibility even for odd source dimensions.
  vf.push("scale=trunc(iw/2)*2:trunc(ih/2)*2");

  // Required creator tag, always embedded.
  const font = "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf";
  const p = options.watermarkPosition || 'bottom-right';
  const x = p === 'bottom-left' ? '40' : p === 'top-left' ? '40' : 'w-tw-40';
  const y1 = p === 'top-left' || p === 'top-right' ? '40' : 'h-th-70';
  const y2 = p === 'top-left' || p === 'top-right' ? '68' : 'h-th-40';

  const esc = s => s.replace(/[:'\\]/g, '\\$&');
  vf.push(`drawtext=fontfile=${font}:text='${esc('HEXO METHOD')}':fontcolor=white@0.92:fontsize=22:borderw=2:bordercolor=black@0.55:x=${x}:y=${y1}`);
  vf.push(`drawtext=fontfile=${font}:text='${esc('UPLOAD METHOD BY @hexo_orig')}':fontcolor=white@0.88:fontsize=13:borderw=2:bordercolor=black@0.55:x=${x}:y=${y2}`);

  return vf.join(',');
}

function qualityOptions(options) {
  const q = options.quality || 'tiktok';
  let crf = Number(options.crf);
  if (!Number.isFinite(crf)) crf = q === 'max' ? 18 : q === 'tiktok' ? 19 : q === 'balanced' ? 22 : 26;
  crf = Math.max(12, Math.min(28, crf));

  // Faster than the previous "slow" preset while retaining strong quality.
  const preset = q === 'max' ? 'veryfast' : 'veryfast';
  const audio = Math.max(96, Math.min(320, Number(options.audioBitrate) || 192));
  return { crf, preset, audio };
}

function progressSteps(progress) {
  return [
    { id: 'analyze', done: progress >= 5, active: progress < 5 },
    { id: 'encode', done: progress >= 85, active: progress >= 5 && progress < 85 },
    { id: 'audio', done: progress >= 90, active: progress >= 85 && progress < 90 },
    { id: 'mux', done: progress >= 97, active: progress >= 90 && progress < 97 },
    { id: 'finalize', done: progress >= 100, active: progress >= 97 }
  ];
}

app.post('/api/process', upload.single('video'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No video uploaded' });

  const jobId = safeId();
  const dir = path.join(WORK, jobId);
  await fsp.mkdir(dir, { recursive: true });

  const input = path.join(dir, path.basename(req.file.path));
  const output = path.join(dir, 'HEXO_METHOD_output.mp4');
  await fsp.rename(req.file.path, input);

  let options = {};
  try { options = JSON.parse(req.body.options || '{}'); } catch {}

  const job = { createdAt: Date.now(), status: 'processing', progress: 1, message: 'Analyzing source video...', dir, input, output };
  JOBS.set(jobId, job);
  res.json({ jobId });

  (async () => {
    try {
      const probe = await runProbe(input);
      const video = probe.streams.find(s => s.codec_type === 'video');
      if (!video) throw new Error('No video stream found');

      const duration = Number(probe.format?.duration || 0);
      const q = qualityOptions(options);
      const vf = filterFor(options);

      let targetFps = '';
      if (!options.preserveFps && options.fps && options.fps !== 'auto') targetFps = String(Number(options.fps));

      const args = [
        '-hide_banner', '-y',
        '-i', input,
        '-map', '0:v:0',
        '-map', '0:a:0?',
        '-vf', vf,
        '-c:v', 'libx264',
        '-preset', q.preset,
        '-crf', String(q.crf),
        '-pix_fmt', 'yuv420p',
        '-c:a', 'aac',
        '-b:a', `${q.audio}k`,
        '-movflags', '+faststart',
        '-progress', 'pipe:1',
        '-nostats'
      ];
      if (targetFps) args.push('-r', targetFps);
      args.push(output);

      const ff = spawn('ffmpeg', args, { cwd: dir });
      job.ffmpegPid = ff.pid;
      let stderr = '';
      let lastProgress = 1;

      ff.stdout.on('data', chunk => {
        const text = chunk.toString();
        const m = text.match(/out_time_ms=(\d+)/);
        if (m && duration > 0) {
          const pct = Math.min(99, Math.max(1, (Number(m[1]) / 1000000 / duration) * 100));
          lastProgress = pct;
          job.progress = pct;
          job.message = pct < 85 ? 'Encoding H.264 video...' : pct < 97 ? 'Finalizing audio and MP4...' : 'Finishing output...';
        }
      });

      ff.stderr.on('data', d => {
        stderr += d.toString();
        if (stderr.length > 12000) stderr = stderr.slice(-12000);
      });

      ff.on('error', err => {
        job.status = 'failed';
        job.error = `FFmpeg could not start: ${err.message}`;
      });

      ff.on('close', async code => {
        if (job.status === 'failed') return;
        if (code !== 0) {
          job.status = 'failed';
          job.error = `FFmpeg exited with code ${code}. ${stderr.split('\n').filter(Boolean).slice(-8).join(' ')}`;
          return;
        }

        try {
          const outProbe = await runProbe(output);
          const stat = await fsp.stat(output);
          job.outputMeta = outputMeta(outProbe, stat);
          job.progress = 100;
          job.message = 'Optimization complete!';
          job.status = 'completed';
        } catch (e) {
          job.status = 'failed';
          job.error = `Output verification failed: ${e.message}`;
        }
      });
    } catch (e) {
      job.status = 'failed';
      job.error = e.message;
    }
  })();
});

app.get('/api/process/:id', (req, res) => {
  const job = JOBS.get(req.params.id);
  if (!job) return res.status(404).json({ error: 'Job not found or expired' });

  if (job.status === 'completed') {
    return res.json({
      status: 'completed',
      progress: 100,
      message: job.message,
      output: job.outputMeta,
      downloadUrl: `/api/download/${encodeURIComponent(req.params.id)}`
    });
  }

  res.json({
    status: job.status,
    progress: job.progress,
    message: job.message,
    error: job.error,
    progressSteps: progressSteps(job.progress)
  });
});

app.get('/api/download/:id', async (req, res) => {
  const job = JOBS.get(req.params.id);
  if (!job || job.status !== 'completed') return res.status(404).send('File not ready');
  try {
    res.download(job.output, 'HEXO_METHOD_optimized.mp4', async () => {
      // Keep file for a short time so comparison/download can work.
    });
  } catch {
    res.status(500).send('Download failed');
  }
});

app.get('/api/health', async (_req, res) => {
  res.json({ ok: true, ffmpeg: true, time: new Date().toISOString() });
});

async function cleanup() {
  const now = Date.now();
  for (const [id, job] of JOBS) {
    if (job.status === 'processing') continue;
    const age = now - (job.createdAt || now);
    if (age > 60 * 60 * 1000) {
      try { await fsp.rm(job.dir, { recursive: true, force: true }); } catch {}
      JOBS.delete(id);
    }
  }
}
setInterval(cleanup, 10 * 60 * 1000);

app.listen(PORT, '0.0.0.0', () => {
  console.log(`HEXO METHOD running on port ${PORT}`);
  console.log('FFmpeg/FFprobe expected in PATH');
});
