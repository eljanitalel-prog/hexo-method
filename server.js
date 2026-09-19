const express = require("express");
const multer = require("multer");
const fs = require("fs");
const fsp = fs.promises;
const path = require("path");
const crypto = require("crypto");
const { spawn } = require("child_process");

const app = express();
const PORT = process.env.PORT || 3000;
const ROOT = __dirname;
const TMP = path.join(ROOT, "tmp");
const PUBLIC = ROOT;

fs.mkdirSync(TMP, { recursive: true });

app.use(express.json({ limit: "1mb" }));
app.use(express.static(PUBLIC));

const upload = multer({
  dest: TMP,
  limits: { fileSize: 2 * 1024 * 1024 * 1024 }
});

const jobs = new Map();

function run(cmd, args) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { windowsHide: true });
    let out = "", err = "";
    p.stdout.on("data", d => out += d.toString());
    p.stderr.on("data", d => err += d.toString());
    p.on("error", reject);
    p.on("close", code => code === 0 ? resolve(out) : reject(new Error(err || `${cmd} exited ${code}`)));
  });
}

function parseFps(rate) {
  if (!rate || rate === "0/0") return 0;
  const [a,b] = String(rate).split("/").map(Number);
  return b ? a / b : Number(rate);
}
function nearFps(fps) {
  if (!fps) return 0;
  const common = [23.976,24,25,29.97,30,48,50,59.94,60,90,100,119.88,120];
  return common.reduce((best,x) => Math.abs(x-fps) < Math.abs(best-fps) ? x : best, common[0]);
}
function fpsText(fps) {
  return Number.isInteger(fps) ? String(fps) : fps.toFixed(3).replace(/0+$/,"").replace(/\.$/,"");
}
function fmtSize(n) {
  const u=["B","KB","MB","GB"]; let i=0, x=n;
  while(x>=1024 && i<u.length-1){x/=1024;i++;}
  return `${x.toFixed(i?1:0)} ${u[i]}`;
}
function fmtDuration(s) {
  if (!Number.isFinite(s)) return "0:00";
  const m=Math.floor(s/60), sec=Math.floor(s%60);
  return `${m}:${String(sec).padStart(2,"0")}`;
}
function safeExt(name) {
  const ext=path.extname(name||"").toLowerCase();
  return [".mp4",".mov",".mkv",".webm",".m4v",".avi"].includes(ext) ? ext : ".mp4";
}

async function probe(filePath, sizeBytes) {
  const raw = await run("ffprobe", [
    "-v","error","-show_entries",
    "format=duration,bit_rate:stream=index,codec_type,codec_name,width,height,r_frame_rate,avg_frame_rate,bit_rate",
    "-of","json",filePath
  ]);
  const data=JSON.parse(raw);
  const streams=data.streams||[];
  const v=streams.find(s=>s.codec_type==="video");
  const a=streams.find(s=>s.codec_type==="audio");
  if(!v) throw new Error("No video stream found.");
  const fps=parseFps(v.avg_frame_rate||v.r_frame_rate);
  const duration=Number(data.format?.duration||0);
  const bitrate=Number(data.format?.bit_rate||v.bit_rate||0);
  return {
    duration, durationFormatted:fmtDuration(duration),
    width:Number(v.width||0), height:Number(v.height||0),
    fps:nearFps(fps), fpsExact:fps,
    sizeBytes:Number(sizeBytes||0), sizeFormatted:fmtSize(Number(sizeBytes||0)),
    bitrate, bitrateFormatted: bitrate ? `${Math.round(bitrate/1000)} kbps` : "—",
    videoCodec:v.codec_name||"unknown",
    audioCodec:a?.codec_name||"none",
    aspectRatio:(v.width&&v.height)?`${v.width}:${v.height}`:"—"
  };
}

function qualityArgs(quality) {
  return {
    max:{crf:"17",preset:"medium"},
    tiktok:{crf:"18",preset:"fast"},
    balanced:{crf:"21",preset:"fast"},
    smaller:{crf:"25",preset:"veryfast"}
  }[quality] || {crf:"18",preset:"fast"};
}

function calcScale(meta, resolution, aspect) {
  if (resolution === "original" && aspect === "keep") return [];
  let w=meta.width, h=meta.height;
  if (resolution==="1080x1920"){w=1080;h=1920;}
  if (resolution==="720x1280"){w=720;h=1280;}
  if (aspect==="crop") return ["-vf",`scale=${w}:${h}:force_original_aspect_ratio=increase,crop=${w}:${h}`];
  if (aspect==="fit") return ["-vf",`scale=${w}:${h}:force_original_aspect_ratio=decrease,pad=${w}:${h}:(ow-iw)/2:(oh-ih)/2`];
  if (resolution!=="original") return ["-vf",`scale=${w}:${h}:force_original_aspect_ratio=decrease`];
  return [];
}

function tagFilter() {
  const font="/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf";
  const text="HEXO METHOD\\nUPLOAD METHOD BY @hexo_orig";
  return `drawtext=fontfile='${font}':text='${text}':fontcolor=white@0.92:fontsize=24:line_spacing=5:box=1:boxcolor=black@0.42:boxborderw=8:x=w-tw-28:y=h-th-28`;
}

function buildVideoFilter(meta, body) {
  const parts=[];
  const scale=calcScale(meta, body.resolution||"original", body.aspectRatio||"keep");
  if(scale.length) parts.push(scale[1]);
  // Always add the HEXO METHOD creator tag as requested.
  parts.push(tagFilter());
  return parts.length ? ["-vf", parts.join(",")] : [];
}

app.post("/api/analyze", upload.single("video"), async (req,res)=>{
  if(!req.file) return res.status(400).json({error:"No video uploaded."});
  try {
    const meta=await probe(req.file.path, req.file.size);
    await fsp.unlink(req.file.path).catch(()=>{});
    res.json(meta);
  } catch(e) {
    await fsp.unlink(req.file.path).catch(()=>{});
    res.status(422).json({error:"Could not analyze this video. Make sure it is a valid video file.", details:String(e.message).slice(0,500)});
  }
});

app.post("/api/process", upload.single("video"), async (req,res)=>{
  if(!req.file) return res.status(400).json({error:"No video uploaded."});
  const id=crypto.randomUUID();
  const input=req.file.path;
  const out=path.join(TMP,`${id}.mp4`);
  const body=req.body||{};
  jobs.set(id,{state:"starting",progress:0,status:"Preparing FFmpeg...",created:Date.now(),output:out});
  res.json({jobId:id});
  (async()=>{
    try{
      const meta=await probe(input,req.file.size);
      const q=qualityArgs(body.quality);
      const fps=meta.fpsExact||meta.fps;
      const args=["-hide_banner","-y","-i",input,"-map","0:v:0","-map","0:a:0?"];
      const vf=buildVideoFilter(meta,body);
      args.push(...vf,"-c:v","libx264","-preset",q.preset,"-crf",q.crf,"-pix_fmt","yuv420p");
      if(body.preserveFps!=="false" && fps) args.push("-fps_mode","passthrough");
      else if(body.outputFps && Number(body.outputFps)>0) args.push("-r",String(body.outputFps));
      args.push("-c:a","aac","-b:a",String(body.audioBitrate||"192k"),"-ar","48000","-movflags","+faststart","-progress","pipe:1",out);
      jobs.set(id,{state:"processing",progress:0,status:"Encoding H.264 + AAC...",created:Date.now(),output:out});
      const child=spawn("ffmpeg",args,{windowsHide:true});
      let stderr="";
      child.stderr.on("data",d=>{ stderr += d.toString(); if(stderr.length>12000) stderr=stderr.slice(-12000); });
      let duration=meta.duration||0;
      child.stdout.on("data",d=>{
        const lines=d.toString().split(/\r?\n/);
        for(const line of lines){
          const [k,v]=line.split("=");
          if(k==="out_time_ms" && duration){
            const sec=Number(v)/1000000;
            const pct=Math.max(0,Math.min(99,sec/duration*100));
            const j=jobs.get(id); if(j){j.progress=pct;j.status=`Encoding video… ${Math.round(pct)}%`;}
          }
        }
      });
      await new Promise((resolve,reject)=>{
        child.on("error",reject);
        child.on("close",code=>code===0?resolve():reject(new Error(stderr||`FFmpeg exited with code ${code}`)));
      });
      const stat=await fsp.stat(out);
      const outputMeta=await probe(out,stat.size);
      jobs.set(id,{state:"done",progress:100,status:"Optimization complete.",created:Date.now(),output:out,meta,outputMeta});
    }catch(e){
      jobs.set(id,{state:"error",progress:0,status:"Processing failed.",created:Date.now(),error:String(e.message).slice(0,1000)});
      await fsp.unlink(out).catch(()=>{});
    }finally{
      await fsp.unlink(input).catch(()=>{});
    }
  })();
});

app.get("/api/process/:id/status",(req,res)=>{
  const j=jobs.get(req.params.id);
  if(!j) return res.status(404).json({error:"Job not found."});
  res.json({
    state:j.state, progress:j.progress, status:j.status, error:j.error,
    meta:j.meta, outputMeta:j.outputMeta,
    download:j.state==="done"?`/api/process/${req.params.id}/download`:null
  });
});

app.get("/api/process/:id/download",async(req,res)=>{
  const j=jobs.get(req.params.id);
  if(!j || j.state!=="done") return res.status(404).send("Output not ready.");
  if(!fs.existsSync(j.output)) return res.status(404).send("Output expired.");
  res.download(j.output,"HEXO_METHOD_TikTok_Optimized.mp4",async()=>{ 
    setTimeout(async()=>{await fsp.unlink(j.output).catch(()=>{}); jobs.delete(req.params.id);}, 60000);
  });
});

setInterval(async()=>{
  const cutoff=Date.now()-60*60*1000;
  for(const [id,j] of jobs){
    if(j.created<cutoff){
      if(j.output) await fsp.unlink(j.output).catch(()=>{});
      jobs.delete(id);
    }
  }
},10*60*1000);

app.get("*",(req,res)=>{
  if(req.path.startsWith("/api/")) return res.status(404).end();
  res.sendFile(path.join(ROOT,"index.html"));
});

app.listen(PORT,()=>console.log(`HEXO METHOD running on port ${PORT}`));
