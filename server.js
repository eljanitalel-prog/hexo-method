const express = require('express');
const multer = require('multer');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { spawn } = require('child_process');

const app = express();
const PORT = process.env.PORT || 8080;
const TMP = process.env.TMPDIR || os.tmpdir();
const JOB_DIR = path.join(TMP, 'hexo-method');
fs.mkdirSync(JOB_DIR, { recursive: true });

const upload = multer({
  dest: JOB_DIR,
  limits: { fileSize: 2 * 1024 * 1024 * 1024 }
});

app.use(express.static(path.join(__dirname)));
app.get('/health', (_req, res) => res.json({ ok: true, ffmpeg: true, version: '5.2' }));

function num(v, fallback, min, max) {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}
function safePreset(v) {
  return ['ultrafast','superfast','veryfast','faster','fast','medium'].includes(v) ? v : 'superfast';
}
function safeCrf(v) { return Math.round(num(v, 19, 14, 30)); }
function safeAudio(v) { return Math.round(num(v, 192, 64, 320)); }
function safeVideoBitrate(v) { return Math.round(num(v, 8000, 500, 50000)); }
function safeRes(v) { return ['original','1080x1920','720x1280'].includes(v) ? v : 'original'; }
function safeAspect(v) { return ['crop','fit','keep'].includes(v) ? v : 'keep'; }

function parseFps(rate) {
  if (!rate || !rate.includes('/')) return Number(rate) || 0;
  const [a,b] = rate.split('/').map(Number);
  return b ? a / b : 0;
}

function runProbe(file) {
  return new Promise((resolve, reject) => {
    const args = ['-v','error','-print_format','json','-show_format','-show_streams',file];
    const p = spawn('ffprobe', args, { stdio: ['ignore','pipe','pipe'] });
    let out = '', err = '';
    p.stdout.on('data', d => out += d);
    p.stderr.on('data', d => err += d);
    p.on('error', reject);
    p.on('close', code => {
      if (code !== 0) return reject(new Error(err || `ffprobe exited ${code}`));
      try { resolve(JSON.parse(out)); } catch (e) { reject(e); }
    });
  });
}

function metaFromProbe(probe, sizeBytes) {
  const v = (probe.streams || []).find(s => s.codec_type === 'video') || {};
  const a = (probe.streams || []).find(s => s.codec_type === 'audio') || {};
  const duration = Number(probe.format?.duration || v.duration || 0);
  const fps = parseFps(v.avg_frame_rate || v.r_frame_rate || '0/1');
  return {
    width: Number(v.width || 0),
    height: Number(v.height || 0),
    fps: Number(fps.toFixed(3)),
    duration,
    sizeBytes,
    videoCodec: v.codec_name || 'unknown',
    audioCodec: a.codec_name || 'none',
    bitrate: Number(probe.format?.bit_rate || 0)
  };
}

function buildFilter({ resolution, aspect }) {
  if (resolution === 'original') return null;
  const [w,h] = resolution.split('x').map(Number);
  if (aspect === 'crop') {
    return `scale=${w}:${h}:force_original_aspect_ratio=increase,crop=${w}:${h}`;
  }
  if (aspect === 'fit') {
    return `scale=${w}:${h}:force_original_aspect_ratio=decrease,pad=${w}:${h}:(ow-iw)/2:(oh-ih)/2:color=black`;
  }
  return `scale=${w}:${h}:force_original_aspect_ratio=decrease`;
}

function ffmpegArgs(input, output, opts) {
  const args = [
    '-hide_banner','-y','-i',input,
    '-map','0:v:0','-map','0:a:0?',
    '-c:v','libx264',
    '-preset',safePreset(opts.preset),
    '-crf',String(safeCrf(opts.crf)),
    '-threads','0',
    '-pix_fmt','yuv420p',
    '-fps_mode','passthrough',
    '-c:a','aac',
    '-b:a',`${safeAudio(opts.audioBitrate)}k`,
    '-ar','48000',
    '-movflags','+faststart'
  ];

  const filter = buildFilter(opts);
  if (filter) args.push('-vf', filter);

  // IMPORTANT: when Preserve Original FPS is enabled, no -r conversion is added.
  if (!opts.preserveFps) {
    const requested = Number(opts.fps);
    if (requested && requested >= 1 && requested <= 120) args.push('-r',String(requested));
  }

  if (opts.useBitrate) {
    const br = safeVideoBitrate(opts.videoBitrate);
    args.push('-maxrate',`${br}k`,'-bufsize',`${br * 2}k`);
  }

  args.push('-progress','pipe:1','-nostats',output);
  return args;
}

async function cleanupLater(paths, delay = 60 * 60 * 1000) {
  setTimeout(async () => {
    for (const p of paths) { try { await fsp.unlink(p); } catch {} }
  }, delay).unref();
}

app.post('/api/process', upload.single('video'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No video file uploaded.' });

  const input = req.file.path;
  const jobId = crypto.randomUUID();
  const output = path.join(JOB_DIR, `${jobId}.mp4`);

  res.status(200);
  res.setHeader('Content-Type','application/x-ndjson; charset=utf-8');
  res.setHeader('Cache-Control','no-store');
  res.setHeader('X-Accel-Buffering','no');
  if (res.flushHeaders) res.flushHeaders();

  const send = obj => { if (!res.writableEnded) res.write(JSON.stringify(obj) + '\n'); };

  try {
    send({ type:'status', stage:'analyze', progress:2, message:'Analyzing source video...' });
    const probe = await runProbe(input);
    const originalMeta = metaFromProbe(probe, req.file.size);
    send({ type:'meta', original: originalMeta });

    const resolution = safeRes(req.body.resolution);
    const aspect = safeAspect(req.body.aspect);
    const preserveFps = String(req.body.preserveFps) !== 'false';
    const quality = req.body.quality || 'tiktok';
    const preset = safePreset(req.body.preset || (quality === 'max' ? 'veryfast' : 'superfast'));
    const crf = safeCrf(req.body.crf || ({ max:18, tiktok:19, balanced:21, smaller:24 }[quality] || 19));
    const audioBitrate = safeAudio(req.body.audioBitrate || (quality === 'smaller' ? 128 : 192));
    const videoBitrate = safeVideoBitrate(req.body.videoBitrate || 8000);
    const fps = req.body.fps || 'auto';
    const useBitrate = quality === 'smaller';

    // Watermark/overlay is deliberately ignored in v5.2.
    // The output video is always clean. Caption is supplied by the frontend only.
    send({ type:'status', stage:'encode', progress:5, message:`Encoding H.264 (${preset}, CRF ${crf}) — original FPS preserved...` });

    const args = ffmpegArgs(input, output, {
      resolution, aspect, preserveFps, fps, preset, crf, audioBitrate,
      videoBitrate, useBitrate
    });

    const proc = spawn('ffmpeg', args, { stdio:['ignore','pipe','pipe'] });
    let stderr = '';
    proc.stderr.on('data', d => {
      stderr += d.toString();
      if (stderr.length > 20000) stderr = stderr.slice(-20000);
    });

    let buffer = '';
    proc.stdout.on('data', chunk => {
      buffer += chunk.toString();
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() || '';
      let outTime = 0;
      for (const line of lines) {
        const [k,v] = line.split('=');
        if (k === 'out_time_ms') outTime = Number(v) / 1e6;
        if (k === 'progress' && outTime > 0 && originalMeta.duration > 0) {
          const pct = Math.min(98, 5 + (outTime / originalMeta.duration) * 90);
          send({ type:'progress', stage:'encode', progress:Number(pct.toFixed(1)), message:`Encoding H.264… ${pct.toFixed(0)}%` });
        }
      }
    });

    const code = await new Promise((resolve, reject) => {
      proc.on('error', reject);
      proc.on('close', resolve);
    });

    if (code !== 0) {
      throw new Error(stderr.trim().split('\n').slice(-8).join('\n') || `FFmpeg exited with code ${code}`);
    }

    const stat = await fsp.stat(output);
    send({ type:'status', stage:'finalize', progress:99, message:'Finalizing MP4 output...' });

    const outProbe = await runProbe(output);
    const optimizedMeta = metaFromProbe(outProbe, stat.size);

    // Report whether the measured FPS stayed effectively unchanged.
    const fpsDiff = Math.abs((originalMeta.fps || 0) - (optimizedMeta.fps || 0));
    const fpsPreserved = !originalMeta.fps || fpsDiff <= Math.max(0.01, originalMeta.fps * 0.01);

    send({
      type:'complete',
      progress:100,
      original: originalMeta,
      optimized: optimizedMeta,
      fpsPreserved,
      caption: 'Upload Method → @hexo_orig',
      watermarkAdded: false,
      downloadUrl:`/api/download/${jobId}`,
      jobId
    });

    await cleanupLater([input, output]);
    res.end();
  } catch (err) {
    send({ type:'error', message: err.message || 'FFmpeg processing failed.' });
    try { await fsp.unlink(input); } catch {}
    try { await fsp.unlink(output); } catch {}
    res.end();
  }
});

app.get('/api/download/:id', async (req, res) => {
  const id = String(req.params.id).replace(/[^a-zA-Z0-9-]/g,'');
  const file = path.join(JOB_DIR, `${id}.mp4`);
  try {
    await fsp.access(file, fs.constants.R_OK);
    res.download(file, `HEXO-METHOD-${id}.mp4`);
  } catch {
    res.status(404).send('This processed video is no longer available.');
  }
});

app.use((err, _req, res, _next) => {
  console.error(err);
  if (!res.headersSent) res.status(500).json({ error: err.message || 'Server error' });
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`HEXO METHOD v5.2 running on port ${PORT}`);
  console.log('FFmpeg real processing enabled; video watermark disabled; original FPS preservation enabled.');
});
