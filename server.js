const express = require('express');
const multer = require('multer');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { spawn } = require('child_process');

const FFMPEG = (() => {
  try { return require('ffmpeg-static'); } catch { return 'ffmpeg'; }
})();
const FFPROBE = (() => {
  try { return require('ffprobe-static').path; } catch { return 'ffprobe'; }
})();

const app = express();
const PORT = Number(process.env.PORT || 3000);
const ROOT = __dirname;
const JOB_ROOT = path.join(os.tmpdir(), 'hexo-method-jobs');

fs.mkdirSync(JOB_ROOT, { recursive: true });

const upload = multer({
  dest: JOB_ROOT,
  limits: {
    fileSize: Number(process.env.MAX_UPLOAD_BYTES || 2 * 1024 * 1024 * 1024) // 2 GB
  },
  fileFilter: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    const allowed = new Set(['.mp4', '.mov', '.mkv', '.webm']);
    cb(null, allowed.has(ext));
  }
});

const jobs = new Map();

function id() {
  return crypto.randomBytes(16).toString('hex');
}

function runProbe(file) {
  return new Promise((resolve, reject) => {
    const p = spawn(FFPROBE, [
      '-v', 'error',
      '-print_format', 'json',
      '-show_streams',
      '-show_format',
      file
    ]);

    let stdout = '';
    let stderr = '';
    p.stdout.on('data', d => stdout += d);
    p.stderr.on('data', d => stderr += d);
    p.on('error', reject);
    p.on('close', code => {
      if (code !== 0) return reject(new Error(stderr || 'ffprobe failed'));
      try {
        const data = JSON.parse(stdout);
        const video = data.streams?.find(s => s.codec_type === 'video');
        const audio = data.streams?.find(s => s.codec_type === 'audio');
        if (!video) throw new Error('No video stream found');

        const fps = parseRate(video.avg_frame_rate || video.r_frame_rate);
        const duration = Number(video.duration || data.format?.duration || 0);
        const bitrate = Number(video.bit_rate || data.format?.bit_rate || 0);

        resolve({
          width: Number(video.width),
          height: Number(video.height),
          fps: fps || 30,
          duration,
          bitrate,
          videoCodec: video.codec_name || 'unknown',
          audioCodec: audio?.codec_name || 'none',
          pixelFormat: video.pix_fmt || 'unknown',
          container: data.format?.format_name || ''
        });
      } catch (e) {
        reject(e);
      }
    });
  });
}

function parseRate(rate) {
  if (!rate || rate === '0/0') return 0;
  const [a, b] = String(rate).split('/').map(Number);
  return b ? a / b : Number(rate);
}

function formatFps(fps) {
  return Number.isFinite(fps) ? Number(fps.toFixed(3)) : 30;
}

function findFont() {
  const candidates = [
    process.env.FONT_FILE,
    '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf',
    '/usr/share/fonts/truetype/liberation2/LiberationSans-Bold.ttf',
    'C:\\Windows\\Fonts\\arialbd.ttf',
    'C:\\Windows\\Fonts\\arial.ttf'
  ].filter(Boolean);
  return candidates.find(p => fs.existsSync(p)) || null;
}

function escapeDrawtext(text) {
  return String(text)
    .replace(/\\/g, '\\\\')
    .replace(/:/g, '\\:')
    .replace(/'/g, "\\'");
}

function buildVideoFilter(settings, source) {
  const filters = [];
  const target = settings.resolution === '1080x1920'
    ? { w: 1080, h: 1920 }
    : settings.resolution === '720x1280'
      ? { w: 720, h: 1280 }
      : { w: Number(settings.width) || source.width, h: Number(settings.height) || source.height };

  const wantsTarget = settings.resolution !== 'original' ||
    Number(settings.width) !== source.width ||
    Number(settings.height) !== source.height;

  if (settings.aspectRatio === 'crop') {
    filters.push(`scale=${target.w}:${target.h}:force_original_aspect_ratio=increase,crop=${target.w}:${target.h}`);
  } else if (settings.aspectRatio === 'fit') {
    filters.push(`scale=${target.w}:${target.h}:force_original_aspect_ratio=decrease,pad=${target.w}:${target.h}:(ow-iw)/2:(oh-ih)/2:color=black`);
  } else if (wantsTarget) {
    filters.push(`scale=${target.w}:${target.h}:flags=lanczos`);
  }

  // Required creator tag, inspired by editing-page signatures.
  const font = findFont();
  const fontOpt = font ? `:fontfile='${escapeDrawtext(font)}'` : '';
  filters.push(
    `drawtext=text='${escapeDrawtext('HEXO METHOD')}'${fontOpt}` +
    `:fontcolor=white@0.94:fontsize=h*0.022:box=1:boxcolor=black@0.38:boxborderw=10` +
    `:x=w-tw-w*0.035:y=h-th-h*0.035` +
    `:shadowcolor=black@0.7:shadowx=2:shadowy=2`,
    `drawtext=text='${escapeDrawtext('UPLOAD METHOD BY @hexo_orig')}'${fontOpt}` +
    `:fontcolor=white@0.78:fontsize=h*0.012:box=1:boxcolor=black@0.38:boxborderw=8` +
    `:x=w-tw-w*0.035:y=h-h*0.035-th`
  );

  return filters.join(',');
}

function safeNumber(value, fallback, min, max) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.max(min, Math.min(max, n)) : fallback;
}

function normalizeSettings(raw, source) {
  const q = {
    max: { crf: 16, preset: 'slow', bitrate: 12000 },
    tiktok: { crf: 18, preset: 'medium', bitrate: 8000 },
    balanced: { crf: 22, preset: 'medium', bitrate: 5000 },
    smaller: { crf: 26, preset: 'fast', bitrate: 3000 }
  }[raw.quality] || { crf: 18, preset: 'medium', bitrate: 8000 };

  const crf = safeNumber(raw.crf, q.crf, 12, 30);
  const bitrate = safeNumber(raw.videoBitrate, q.bitrate, 500, 50000);
  const audioBitrate = safeNumber(raw.audioBitrate, 256, 64, 320);
  const presetAllowed = new Set(['ultrafast','superfast','veryfast','faster','fast','medium','slow','slower','veryslow']);
  const preset = presetAllowed.has(raw.preset) ? raw.preset : q.preset;

  const codec = 'libx264'; // TikTok-friendly output
  const pixelFormat = ['yuv420p','yuv422p','yuv444p'].includes(raw.pixelFormat) ? raw.pixelFormat : 'yuv420p';

  const preserveFps = raw.preserveFps !== false;
  let fps = null;
  if (!preserveFps && raw.fps && raw.fps !== 'auto') {
    fps = safeNumber(raw.fps, Math.min(source.fps, 60), 1, 120);
  }

  const width = safeNumber(raw.width, source.width, 2, 7680);
  const height = safeNumber(raw.height, source.height, 2, 7680);

  return {
    quality: raw.quality || 'tiktok',
    crf, bitrate, audioBitrate, preset, codec, pixelFormat,
    preserveFps, fps,
    resolution: raw.resolution || 'original',
    aspectRatio: ['crop','fit','keep'].includes(raw.aspectRatio) ? raw.aspectRatio : 'keep',
    width: Math.round(width / 2) * 2,
    height: Math.round(height / 2) * 2,
    faststart: raw.faststart !== false,
    tuneFilm: raw.tuneFilm !== false
  };
}

async function safeRm(dir) {
  try { await fsp.rm(dir, { recursive: true, force: true }); } catch {}
}

function startJob(job, source, settings) {
  const input = job.input;
  const output = job.output;
  const duration = Math.max(Number(source.duration) || 1, 0.1);
  const filter = buildVideoFilter(settings, source);

  const args = [
    '-hide_banner',
    '-y',
    '-i', input,
    '-map', '0:v:0',
    '-map', '0:a:0?',
    '-vf', filter,
    '-c:v', settings.codec,
    '-preset', settings.preset,
    '-crf', String(settings.crf),
    '-maxrate', `${settings.bitrate}k`,
    '-bufsize', `${Math.max(settings.bitrate * 2, 1000)}k`,
    '-pix_fmt', settings.pixelFormat,
    '-c:a', 'aac',
    '-b:a', `${settings.audioBitrate}k`,
    '-ar', '48000',
    ...(settings.faststart ? ['-movflags', '+faststart'] : []),
    '-metadata', 'comment=HEXO METHOD - UPLOAD METHOD BY @hexo_orig'
  ];

  if (settings.tuneFilm) args.push('-tune', 'film');

  // Preserve the original timing/frame rate unless the user explicitly selects another FPS.
  // passthrough avoids silently converting 60/90/120 FPS to 30 FPS.
  args.push('-fps_mode', settings.preserveFps ? 'passthrough' : 'cfr');
  if (!settings.preserveFps && settings.fps) args.push('-r', String(settings.fps));

  args.push('-progress', 'pipe:1', '-nostats', output);

  job.status = 'processing';
  job.message = 'Encoding H.264 video and embedding HEXO METHOD tag...';

  const ff = spawn(FFMPEG, args, { windowsHide: true });
  job.process = ff;

  let stdout = '';
  let stderr = '';

  ff.stdout.on('data', chunk => {
    stdout += chunk.toString();
    const lines = stdout.split(/\r?\n/);
    stdout = lines.pop() || '';

    for (const line of lines) {
      const [key, value] = line.split('=');
      if (key === 'out_time_ms') {
        const seconds = Number(value) / 1000000;
        const percent = Math.min(99, Math.max(0, (seconds / duration) * 100));
        job.percent = percent;
        job.message = `Encoding video... ${Math.round(percent)}%`;
      }
      if (key === 'progress' && value === 'end') job.percent = 99;
      broadcast(job);
    }
  });

  ff.stderr.on('data', chunk => {
    stderr += chunk.toString();
    // FFmpeg diagnostics are intentionally kept server-side.
  });

  ff.on('error', err => {
    job.status = 'error';
    job.error = err.message;
    broadcast(job);
  });

  ff.on('close', async code => {
    if (code !== 0) {
      job.status = 'error';
      job.error = (stderr.match(/Error .*/i)?.[0] || stderr.slice(-1000) || `FFmpeg exited with code ${code}`).trim();
      broadcast(job);
      return;
    }

    try {
      const outputMeta = await runProbe(output);
      const stat = await fsp.stat(output);
      job.meta = {
        ...outputMeta,
        fps: formatFps(outputMeta.fps),
        sizeBytes: stat.size,
        duration: outputMeta.duration || source.duration
      };
      job.status = 'completed';
      job.percent = 100;
      job.message = 'Optimization complete.';
      broadcast(job);
    } catch (e) {
      job.status = 'error';
      job.error = e.message;
      broadcast(job);
    }
  });
}

const clients = new Map();

function broadcast(job) {
  const list = clients.get(job.id) || [];
  const payload = JSON.stringify({
    status: job.status,
    percent: Math.round(job.percent || 0),
    message: job.message,
    step: job.status === 'completed' ? 'finalize' : (job.percent < 10 ? 'analyze' : job.percent < 90 ? 'encode' : 'mux'),
    error: job.error,
    meta: job.status === 'completed' ? job.meta : undefined,
    downloadUrl: job.status === 'completed' ? `/api/download/${job.id}` : undefined
  });
  for (const res of list) {
    res.write(`data: ${payload}\n\n`);
  }
}

app.use(express.static(ROOT));

app.post('/api/probe', upload.single('video'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No video uploaded.' });
  try {
    const meta = await runProbe(req.file.path);
    res.json({
      ...meta,
      fps: formatFps(meta.fps)
    });
  } catch (e) {
    res.status(400).json({ error: e.message });
  } finally {
    await safeRm(req.file.path);
  }
});

app.post('/api/process', upload.single('video'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No video uploaded.' });

  const jobId = id();
  const dir = path.join(JOB_ROOT, jobId);
  await fsp.mkdir(dir, { recursive: true });

  const input = path.join(dir, 'input' + path.extname(req.file.originalname).toLowerCase());
  const output = path.join(dir, 'HEXO-METHOD-output.mp4');

  try {
    await fsp.rename(req.file.path, input);
    const source = await runProbe(input);
    let raw = {};
    try { raw = JSON.parse(req.body.settings || '{}'); } catch {}

    const settings = normalizeSettings(raw, source);
    const job = {
      id: jobId,
      dir, input, output, status: 'queued', percent: 0, createdAt: Date.now(),
      message: 'Job queued...',
      source, settings
    };
    jobs.set(jobId, job);

    // Start asynchronously so the browser gets a job ID immediately.
    setImmediate(() => startJob(job, source, settings));

    res.json({ jobId });
  } catch (e) {
    await safeRm(dir);
    res.status(400).json({ error: e.message });
  }
});

app.get('/api/progress/:id', (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) return res.status(404).end();

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders?.();

  const list = clients.get(job.id) || [];
  list.push(res);
  clients.set(job.id, list);

  res.write(`data: ${JSON.stringify({
    status: job.status,
    percent: Math.round(job.percent || 0),
    message: job.message,
    step: job.status === 'completed' ? 'finalize' : 'analyze'
  })}\n\n`);

  req.on('close', () => {
    const current = clients.get(job.id) || [];
    clients.set(job.id, current.filter(x => x !== res));
  });
});

app.get('/api/download/:id', async (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job || job.status !== 'completed') return res.status(404).send('File is not ready.');

  try {
    await fsp.access(job.output);
    res.download(job.output, 'HEXO-METHOD.mp4');
  } catch {
    res.status(404).send('Output file no longer exists.');
  }
});

// Cleanup completed/failed jobs after 1 hour.
setInterval(async () => {
  const now = Date.now();
  for (const [jobId, job] of jobs) {
    if (now - (job.createdAt || now) > 60 * 60 * 1000) {
      if (job.process) {
        try { job.process.kill('SIGKILL'); } catch {}
      }
      await safeRm(job.dir);
      jobs.delete(jobId);
      clients.delete(jobId);
    }
  }
}, 10 * 60 * 1000);

app.use((err, req, res, next) => {
  console.error(err);
  if (err instanceof multer.MulterError) return res.status(400).json({ error: err.message });
  res.status(500).json({ error: 'Server error.' });
});

app.listen(PORT, () => {
  console.log(`HEXO METHOD running at http://localhost:${PORT}`);
  console.log('FFmpeg/FFprobe ready via local static binaries when available.');
});
