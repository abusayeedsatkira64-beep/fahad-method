import http from 'node:http';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(ROOT, 'public');
const HOST = process.env.HOST || '127.0.0.1';
const PORT = Number(process.env.PORT || 4173);
const MAX_BYTES = 1024 ** 3;
const JOB_TTL_MS = 60 * 60 * 1000;
const jobs = new Map();
const toolStatus = { ffmpeg:false, ffprobe:false, ytDlp:false };
const MIME = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml', '.ico': 'image/x-icon' };

function json(res, status, data) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  res.end(JSON.stringify(data));
}
function fileBytes(n) { return Number.isFinite(n) ? n : 0; }
function createJob(filename) {
  const id = randomUUID();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fahad-method-'));
  const safe = path.basename(filename || 'video.mp4').replace(/[^a-zA-Z0-9._ -]/g, '_').slice(0, 160) || 'video.mp4';
  const job = { id, dir, filename: safe, createdAt: Date.now(), events: [], clients: new Set(), done: false, busy: false, uploading: true };
  jobs.set(id, job);
  return job;
}
function emit(job, event) {
  const item = { id: job.events.length + 1, at: new Date().toISOString(), ...event };
  job.events.push(item);
  if (job.events.length > 500) job.events.splice(0, job.events.length - 500);
  const wire = `id: ${item.id}\nevent: ${item.type || 'message'}\ndata: ${JSON.stringify(item)}\n\n`;
  for (const res of job.clients) if (!res.destroyed) res.write(wire);
  if (item.type === 'complete' || item.type === 'error') {
    job.done = true;
    for (const res of job.clients) { if (!res.destroyed) res.end(); }
    job.clients.clear();
  }
}
function stage(job, number, text, detail = '') {
  emit(job, { type: 'stage', number, text, detail });
}
function run(bin, args, { timeoutMs = 10 * 60 * 1000, maxStdout = 16 * 1024 * 1024, onStdoutLine } = {}) {
  return new Promise((resolve, reject) => {
    const proc = spawn(bin, args, { shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '', stdoutTail = '';
    let settled = false;
    const timer = setTimeout(() => proc.kill('SIGKILL'), timeoutMs);
    timer.unref?.();
    proc.stdout.on('data', (buf) => {
      const text = buf.toString();
      if (onStdoutLine) {
        stdoutTail += text;
        const lines = stdoutTail.split(/\r?\n/);
        stdoutTail = lines.pop() || '';
        for (const line of lines) onStdoutLine(line);
      }
      if (stdout.length < maxStdout) stdout += text.slice(0, maxStdout - stdout.length);
      else if (!settled) { settled = true; proc.kill('SIGKILL'); reject(new Error(`${bin} produced excessive output`)); }
    });
    proc.stderr.on('data', (buf) => { if (stderr.length < 1024 * 1024) stderr += buf.toString().slice(0, 1024 * 1024 - stderr.length); });
    proc.on('error', (err) => { clearTimeout(timer); reject(new Error(`Could not start ${bin}: ${err.message}`)); });
    proc.on('close', (code, signal) => {
      clearTimeout(timer);
      if (settled) return;
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(`${bin} exited ${code ?? signal}: ${stderr.trim().slice(-1800) || 'no diagnostic output'}`));
    });
  });
}
async function detectTools() {
  const checks = await Promise.all([
    run('ffmpeg', ['-version'], { timeoutMs:10000, maxStdout:2048 }).then(()=>true).catch(()=>false),
    run('ffprobe', ['-version'], { timeoutMs:10000, maxStdout:2048 }).then(()=>true).catch(()=>false),
    run('yt-dlp', ['--version'], { timeoutMs:10000, maxStdout:2048 }).then(()=>true).catch(()=>false),
  ]);
  toolStatus.ffmpeg=checks[0]; toolStatus.ffprobe=checks[1]; toolStatus.ytDlp=checks[2];
}
async function probe(file) {
  const { stdout } = await run('ffprobe', ['-v', 'error', '-show_data_hash', 'sha256', '-show_streams', '-show_format', '-show_chapters', '-of', 'json', file], { timeoutMs: 120000 });
  return JSON.parse(stdout);
}
const BOX_CONTAINERS = new Set(['moov','trak','mdia','minf','stbl','edts','dinf','mvex','moof','traf','mfra','sinf','schi','ipro','iprp','ipco','iref','tref','hnti','strk','strd','meco','mere']);
async function parseMp4(file) {
  const fh = await fsp.open(file, 'r');
  try {
    const stat = await fh.stat();
    const nodes = [];
    async function readBoxes(start, end, depth, parent = '') {
      if (depth > 16) throw new Error('MP4 box nesting exceeds safe parser limit');
      let pos = start;
      while (pos + 8 <= end) {
        if (nodes.length > 100000) throw new Error('MP4 contains an excessive number of boxes');
        const head = Buffer.alloc(16);
        const { bytesRead } = await fh.read(head, 0, Math.min(16, end - pos), pos);
        if (bytesRead < 8) break;
        const size32 = head.readUInt32BE(0);
        const type = head.toString('ascii', 4, 8);
        let size = size32, header = 8;
        if (size32 === 1) {
          if (bytesRead < 16) throw new Error(`Truncated extended-size ${type} box`);
          const wide = head.readBigUInt64BE(8);
          if (wide > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error(`${type} box exceeds parser limits`);
          size = Number(wide); header = 16;
        } else if (size32 === 0) size = end - pos;
        if (size < header || pos + size > end) throw new Error(`Invalid ${type} box size or offset`);
        const node = { type, size, offset: pos, parent, depth };
        nodes.push(node);
        if (BOX_CONTAINERS.has(type)) await readBoxes(pos + header, pos + size, depth + 1, type);
        if (type === 'meta' && pos + header + 4 <= pos + size) await readBoxes(pos + header + 4, pos + size, depth + 1, type);
        pos += size;
      }
      if (pos !== end && end - pos >= 8) throw new Error('MP4 box alignment is invalid');
    }
    await readBoxes(0, stat.size, 0);
    const top = nodes.filter((n) => n.depth === 0);
    const moov = top.find((n) => n.type === 'moov');
    const mdat = top.find((n) => n.type === 'mdat');
    if (!top.some((n) => n.type === 'ftyp') || !moov || !mdat) throw new Error('The file does not contain a recognizable ISO BMFF/MP4 structure (ftyp, moov, and mdat required).');
    const sampleTypes = ['stts','ctts','stsc','stsz','stz2','stco','co64','stss','sdtp','sgpd','sbgp','saiz','saio'];
    return {
      topLevel: top.map(({ type, size }) => ({ type, size })),
      sampleTableBoxes: nodes.filter((n) => n.parent === 'stbl' && sampleTypes.includes(n.type)).map(({ type, size }) => ({ type, size })),
      moovBeforeMdat: moov.offset < mdat.offset,
      moovOffset: moov.offset,
      mdatOffset: mdat.offset,
      boxCount: nodes.length,
      fileSize: fileBytes(stat.size),
    };
  } finally { await fh.close(); }
}
function fraction(s) {
  if (!s || s === '0/0') return null;
  const [a, b] = String(s).split('/').map(Number);
  if (!Number.isFinite(a) || !Number.isFinite(b) || !b) return null;
  return a / b;
}
function firstStream(probeData, type) { return (probeData.streams || []).find((s) => s.codec_type === type); }
function hdrStatus(stream) {
  const transfer = String(stream?.color_transfer || '').toLowerCase();
  const side = (stream?.side_data_list || []).map((x) => `${x.side_data_type || ''} ${x.name || ''}`).join(' ').toLowerCase();
  if (/dolby vision|dovi/.test(side)) return 'Dolby Vision metadata present';
  if (transfer.includes('smpte2084')) return 'HDR10 / PQ';
  if (transfer.includes('arib-std-b67')) return 'HLG';
  if (/mastering display|content light level/.test(side)) return 'HDR metadata present';
  if (transfer) return 'SDR / non-HDR transfer';
  return 'Unavailable';
}
function streamInfo(probeData, actualSize) {
  const v = firstStream(probeData, 'video');
  const a = firstStream(probeData, 'audio');
  const rate = fraction(v?.avg_frame_rate) ?? fraction(v?.r_frame_rate);
  const videoBitrate = v?.bit_rate ? Number(v.bit_rate) : null;
  const audioBitrate = a?.bit_rate ? Number(a.bit_rate) : null;
  const ratio = v?.display_aspect_ratio && v.display_aspect_ratio !== '0:1' ? v.display_aspect_ratio : (v?.width && v?.height ? `${v.width}:${v.height}` : null);
  return {
    resolution: v?.width && v?.height ? `${v.width} × ${v.height}` : 'Unavailable',
    width: v?.width ?? null,
    height: v?.height ?? null,
    fps: rate ? Number(rate.toFixed(3)) : null,
    fpsText: rate ? `${Number(rate.toFixed(3))} fps` : 'Unavailable',
    averageFps: fraction(v?.avg_frame_rate) ? Number(fraction(v.avg_frame_rate).toFixed(3)) : null,
    videoCodec: v?.codec_name || 'Unavailable',
    audioCodec: a?.codec_name || 'Unavailable',
    videoBitrate,
    audioBitrate,
    duration: Number(probeData.format?.duration || v?.duration || a?.duration || 0) || null,
    fileSize: actualSize,
    aspectRatio: ratio || 'Unavailable',
    pixelFormat: v?.pix_fmt || 'Unavailable',
    colorSpace: v?.color_space || 'Unavailable',
    colorTransfer: v?.color_transfer || 'Unavailable',
    hdr: hdrStatus(v),
    videoStreamCount: (probeData.streams || []).filter((s) => s.codec_type === 'video').length,
    audioStreamCount: (probeData.streams || []).filter((s) => s.codec_type === 'audio').length,
    streamCount: (probeData.streams || []).length,
    streams: (probeData.streams || []).map((s) => ({
      index: s.index, type: s.codec_type || 'unknown', codec: s.codec_name || 'unknown', profile: s.profile || null,
      extradataHash: s.extradata_hash || null,
      width: s.width || null, height: s.height || null,
      fps: fraction(s.avg_frame_rate) ?? fraction(s.r_frame_rate),
      bitrate: s.bit_rate ? Number(s.bit_rate) : null,
      pixFmt: s.pix_fmt || null,
      colorSpace: s.color_space || null,
      language: s.tags?.language || null,
    })),
  };
}
function runProgressFfmpeg(job, input, output, duration) {
  return new Promise((resolve, reject) => {
    const args = ['-hide_banner','-nostdin','-y','-i',input,'-map','0','-map_metadata','0','-map_chapters','0','-c','copy','-movflags','+faststart','-progress','pipe:1','-nostats','-f','mp4',output];
    const proc = spawn('ffmpeg', args, { shell: false, windowsHide: true, stdio: ['ignore','pipe','pipe'] });
    let stderr = '', tail = '', current = -1, settled = false;
    const timer = setTimeout(() => proc.kill('SIGKILL'), 20 * 60 * 1000); timer.unref?.();
    proc.stdout.on('data', (buf) => {
      tail += buf.toString();
      const lines = tail.split(/\r?\n/); tail = lines.pop() || '';
      for (const line of lines) {
        const [key, val] = line.split('=', 2);
        if (key === 'out_time_ms' && duration > 0) {
          const p = Math.min(100, (Number(val) / (duration * 1e6)) * 100);
          const rounded = Math.max(0, Math.floor(p));
          if (rounded > current) { current = rounded; emit(job, { type:'progress', progress:current, detail:'FFmpeg stream-copy remux is processing media packets.' }); }
        }
      }
    });
    proc.stderr.on('data', (buf) => { if (stderr.length < 1e6) stderr += buf.toString().slice(0,1e6-stderr.length); });
    proc.on('error', (err) => { clearTimeout(timer); reject(new Error(`Could not start FFmpeg: ${err.message}`)); });
    proc.on('close', (code, signal) => {
      clearTimeout(timer);
      if (settled) return;
      if (code === 0) resolve({ stderr });
      else reject(new Error(`FFmpeg stream-copy remux failed (${code ?? signal}): ${stderr.trim().slice(-1800) || 'no diagnostic output'}`));
    });
  });
}
async function streamHashes(file) {
  const { stdout } = await run('ffmpeg', ['-hide_banner','-nostdin','-v','error','-i',file,'-map','0','-c','copy','-f','streamhash','-hash','sha256','-'], { timeoutMs: 10 * 60 * 1000, maxStdout: 4 * 1024 * 1024 });
  const matches = [...stdout.matchAll(/^\s*(\d+),[^,]*,SHA256=([a-f0-9]{64})\s*$/gmi)];
  if (!matches.length) throw new Error('FFmpeg could not compute SHA-256 packet hashes for this stream layout.');
  return matches.sort((a,b)=>Number(a[1])-Number(b[1])).map((m)=>({ index:Number(m[1]), hash:m[2].toLowerCase() }));
}
function compareProbe(a, b) {
  const as = a.streams || [], bs = b.streams || [];
  if (as.length !== bs.length) return { ok:false, reason:`Stream count changed (${as.length} → ${bs.length}).` };
  for (let i = 0; i < as.length; i++) {
    const x = as[i], y = bs[i];
    for (const k of ['codec_type','codec_name','profile','width','height','pix_fmt','color_space','color_transfer','color_primaries','color_range','sample_rate','channels','channel_layout','extradata_hash']) {
      if ((x[k] ?? null) !== (y[k] ?? null)) return { ok:false, reason:`Stream ${i} ${k} changed (${x[k] ?? 'none'} → ${y[k] ?? 'none'}).` };
    }
    const xr = fraction(x.avg_frame_rate) ?? fraction(x.r_frame_rate), yr = fraction(y.avg_frame_rate) ?? fraction(y.r_frame_rate);
    if (xr && yr && Math.abs(xr - yr) > 0.001) return { ok:false, reason:`Stream ${i} frame rate changed.` };
  }
  const da = Number(a.format?.duration || 0), db = Number(b.format?.duration || 0);
  const durationMatch = !(da && db) || Math.abs(da - db) <= Math.max(0.1, da * 0.001);
  if (!durationMatch) return { ok:false, reason:`Duration changed (${da.toFixed(3)}s → ${db.toFixed(3)}s).`, durationMatch };
  return { ok:true, reason:'Duration, stream count, codecs, frame rate, dimensions, pixel format, color metadata and core track parameters match.', durationMatch };
}
async function validateDecode(file) {
  await run('ffmpeg', ['-hide_banner','-nostdin','-v','error','-xerror','-i',file,'-map','0:v?','-map','0:a?','-f','null','-'], { timeoutMs: 20 * 60 * 1000, maxStdout: 1024 * 1024 });
}
async function processJob(job) {
  if (job.busy) return;
  job.busy = true;
  const input = path.join(job.dir, 'input.bin');
  const output = path.join(job.dir, 'optimized.mp4');
  const started = Date.now();
  try {
    const inputStat = await fsp.stat(input);
    stage(job, '01', 'Loading original video…', 'Upload completed; input is stored in an isolated temporary directory.');
    stage(job, '02', 'Inspecting MP4 container…', 'Reading bounded ISO BMFF box headers before media probing.');
    const originalBoxes = await parseMp4(input);
    const original = await probe(input);
    const formats = String(original.format?.format_name || '').split(',');
    if (!formats.some((name) => ['mov','mp4','m4a','3gp','3g2','mj2'].includes(name))) throw new Error('FFprobe did not identify a supported ISO BMFF / MOV / MP4 container.');
    if (!(original.streams || []).some((s) => s.codec_type === 'video')) throw new Error('No video stream was detected. No output was created.');
    stage(job, '03', 'Detecting original video streams…', `${original.streams.length} stream(s): ${original.streams.map((s)=>`${s.codec_type || 'unknown'} / ${s.codec_name || 'unknown'}`).join(', ')}.`);
    const originalInfo = streamInfo(original, inputStat.size);
    stage(job, '04', 'Detecting original FPS…', `Detected ${originalInfo.fpsText}; no frame-rate conversion will be applied.`);
    stage(job, '05', 'Analyzing video metadata…', `${originalInfo.resolution}; ${originalInfo.videoCodec}; audio ${originalInfo.audioCodec}; ${originalInfo.hdr} color classification.`);
    stage(job, '06', 'Reading MP4 sample tables…', `${originalBoxes.boxCount} boxes inspected; ${originalBoxes.sampleTableBoxes.length} sample-table boxes indexed.`);
    stage(job, '07', 'Initializing optimization engine…', 'MP4 stream-copy remux selected; video and audio encoders are disabled.');
    stage(job, '08', 'Preserving original encoded streams…', 'Starting FFmpeg with -c copy; no lossy encoding or quality preset is used.');
    stage(job, '09', 'Optimizing container structure…', 'Writing MP4 output and relocating moov metadata for progressive playback.');
    await runProgressFfmpeg(job, input, output, originalInfo.duration || 0);
    const outStat = await fsp.stat(output);
    if (outStat.size < 32) throw new Error('FFmpeg produced an empty or incomplete output file.');
    stage(job, '10', 'Validating output file…', `FFprobe is inspecting ${outStat.size} output bytes and the MP4 box tree.`);
    const optimized = await probe(output);
    const outputBoxes = await parseMp4(output);
    const streamComparison = compareProbe(original, optimized);
    stage(job, '11', 'Verifying original media streams…', 'Computing SHA-256 packet hashes and codec-extradata hashes, then decoding output video/audio for playback validation.');
    const [beforeHashes, afterHashes] = await Promise.all([streamHashes(input), streamHashes(output)]);
    const hashMatch = beforeHashes.length === afterHashes.length && beforeHashes.every((x, i) => x.index === afterHashes[i].index && x.hash === afterHashes[i].hash);
    const originalExtradata = (original.streams || []).map((s) => s.extradata_hash || null);
    const optimizedExtradata = (optimized.streams || []).map((s) => s.extradata_hash || null);
    const extradataMatch = originalExtradata.length === optimizedExtradata.length && originalExtradata.every((x, i) => x === optimizedExtradata[i]);
    await validateDecode(output);
    const optimizedInfo = streamInfo(optimized, outStat.size);
    const verification = {
      streamMetadataMatch: streamComparison.ok,
      streamMetadataReason: streamComparison.reason,
      durationMatch: streamComparison.durationMatch,
      encodedStreamHashesMatch: hashMatch,
      codecExtradataHashesMatch: extradataMatch,
      originalCodecExtradataHashes: originalExtradata,
      optimizedCodecExtradataHashes: optimizedExtradata,
      originalStreamHashes: beforeHashes,
      optimizedStreamHashes: afterHashes,
      moovBeforeMdat: outputBoxes.moovBeforeMdat,
      playbackDecodeValidated: true,
      originalContainerMoovBeforeMdat: originalBoxes.moovBeforeMdat,
      containerOptimized: outputBoxes.moovBeforeMdat,
    };
    if (!streamComparison.ok) throw new Error(`Output verification failed: ${streamComparison.reason}`);
    if (!hashMatch) throw new Error('Output verification failed: one or more encoded packet stream hashes changed.');
    if (!outputBoxes.moovBeforeMdat) throw new Error('Output validation failed: moov metadata is not before mdat after fast-start processing.');
    stage(job, '12', 'Optimization completed.', 'Encoded stream hashes match; output passed FFprobe, MP4 structure and decode checks.');
    const method = 'FFmpeg MP4 stream-copy remux (-c copy) with fast-start moov relocation. No re-encoding.';
    emit(job, {
      type:'complete',
      result:{
        filename: job.filename,
        outputFilename: `${path.basename(job.filename, path.extname(job.filename)) || 'video'}-optimized.mp4`,
        original: originalInfo,
        optimized: optimizedInfo,
        processingMethod: method,
        verificationStatus: 'Original encoded streams preserved',
        containerStatus: 'Container optimization successful',
        verification,
        originalContainer: originalBoxes,
        optimizedContainer: outputBoxes,
        sizeDelta: outStat.size - inputStat.size,
        processingTimeMs: Date.now() - started,
        downloadUrl: `/api/jobs/${job.id}/download`,
        previewUrl: `/api/jobs/${job.id}/preview`,
      }
    });
  } catch (err) {
    await fsp.rm(output, { force: true }).catch(()=>{});
    const msg = err?.message || 'Unknown processing error';
    const status = /re-encod|cannot copy|not supported|muxer|codec|stream-copy/i.test(msg) ? 'Re-encoding required or stream-copy unsupported' : 'Output validation failed';
    emit(job, { type:'error', status, message:msg, processingTimeMs:Date.now()-started });
  }
}
function validTikTokUrl(raw) {
  let url;
  try { url = new URL(raw); } catch { return null; }
  const host = url.hostname.toLowerCase().replace(/\.$/, '');
  const allowed = host === 'tiktok.com' || host.endsWith('.tiktok.com');
  if (!allowed || !['https:'].includes(url.protocol) || url.username || url.password || !url.pathname) return null;
  if (!/(^|\/)video\/\d+|\/t\/[\w-]+/i.test(url.pathname) && !/vm\.tiktok\.com|vt\.tiktok\.com/i.test(host)) return null;
  return url.toString();
}
function safeMetric(value) { return Number.isFinite(Number(value)) && value !== null ? Number(value) : null; }
async function analyzeTikTok(rawUrl) {
  const url = validTikTokUrl(rawUrl);
  if (!url) throw new Error('Enter a valid HTTPS TikTok video URL. Other hosts and non-video paths are not accepted.');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fahad-tiktok-'));
  const videoPath = path.join(dir, 'delivered-video.%(ext)s');
  try {
    const { stdout } = await run('yt-dlp', ['--no-warnings','--no-progress','--no-call-home','--no-update','--no-playlist','--max-filesize','1G','-f','best','-o',videoPath,'--print-json',url], { timeoutMs: 180000, maxStdout: 10 * 1024 * 1024 });
    const metadata = JSON.parse(stdout.trim().split(/\r?\n/).filter(Boolean).at(-1) || '{}');
    const files = await fsp.readdir(dir);
    let mediaPath = null;
    for (const name of files) { const p = path.join(dir,name); if ((await fsp.stat(p)).isFile() && !name.endsWith('.part')) { mediaPath=p; break; } }
    if (!mediaPath) throw new Error('TikTok returned metadata but no accessible video media was downloaded.');
    const st = await fsp.stat(mediaPath);
    if (st.size > MAX_BYTES) throw new Error('The retrieved video is larger than the 1 GB analysis limit.');
    const report = await probe(mediaPath);
    const media = streamInfo(report, st.size);
    return {
      source:'TikTok page metadata', deliveredSource:'Media file retrieved from TikTok and inspected with FFprobe',
      title:metadata.title || 'Unavailable', creator:metadata.uploader || metadata.channel || 'Unavailable',
      views:safeMetric(metadata.view_count), likes:safeMetric(metadata.like_count), comments:safeMetric(metadata.comment_count), shares:safeMetric(metadata.repost_count ?? metadata.share_count),
      specifications:media,
      sourceUrl:url,
      note:'These are the specifications of the accessible media delivered by TikTok, not a guarantee of the original creator file. TikTok may transcode uploads server-side.',
    };
  } finally { await fsp.rm(dir, { recursive:true, force:true }).catch(()=>{}); }
}
function sse(req,res,job) {
  res.writeHead(200, { 'Content-Type':'text/event-stream; charset=utf-8','Cache-Control':'no-cache, no-transform','Connection':'keep-alive','X-Accel-Buffering':'no' });
  res.write(': connected\n\n');
  for (const event of job.events) res.write(`id: ${event.id}\nevent: ${event.type || 'message'}\ndata: ${JSON.stringify(event)}\n\n`);
  if (job.done) { res.end(); return; }
  job.clients.add(res);
  const ping = setInterval(()=>{ if (!res.destroyed) res.write(': ping\n\n'); }, 20000);
  const close = ()=>{ clearInterval(ping); job.clients.delete(res); };
  req.on('close',close); res.on('close',close);
}
async function serveStatic(req,res,url) {
  let pathname;
  try { pathname = decodeURIComponent(url.pathname); } catch { return json(res,400,{error:'Invalid path.'}); }
  if (pathname === '/') pathname = '/index.html';
  const file = path.resolve(PUBLIC, `.${pathname}`);
  if (!file.startsWith(PUBLIC + path.sep)) return json(res,404,{error:'Not found.'});
  try {
    const stat = await fsp.stat(file);
    if (!stat.isFile()) return json(res,404,{error:'Not found.'});
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream', 'Content-Length':stat.size, 'X-Content-Type-Options':'nosniff', 'Cache-Control':path.basename(file)==='app.js'?'public,max-age=300':'no-cache' });
    fs.createReadStream(file).pipe(res);
  } catch { json(res,404,{error:'Not found.'}); }
}
const server = http.createServer(async (req,res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  try {
    if (req.method === 'GET' && url.pathname === '/api/health') {
      const ok=toolStatus.ffmpeg&&toolStatus.ffprobe;
      return json(res,ok?200:503,{ok,engine:'FFmpeg stream-copy MP4 remux',ffmpeg:toolStatus.ffmpeg,ffprobe:toolStatus.ffprobe,ytDlp:toolStatus.ytDlp,maxUploadBytes:MAX_BYTES});
    }
    if (req.method === 'POST' && url.pathname === '/api/optimize') {
      const filename = url.searchParams.get('filename') || 'video.mp4';
      const ext = path.extname(filename).toLowerCase();
      if (!['.mp4','.mov','.m4v'].includes(ext)) return json(res,415,{error:'Only MP4, MOV, or M4V files can be processed.'});
      const stated = Number(req.headers['content-length'] || 0);
      if (stated > MAX_BYTES) { req.resume(); return json(res,413,{error:'Maximum upload size is 1 GB.'}); }
      const job = createJob(filename);
      const target = path.join(job.dir,'input.bin');
      let received = 0;
      const limit = new Transform({ transform(chunk,enc,cb) { received += chunk.length; if (received > MAX_BYTES) cb(new Error('Maximum upload size is 1 GB.')); else cb(null,chunk); } });
      try {
        await pipeline(req,limit,createWriteStream(target,{flags:'wx',mode:0o600}));
      } catch (err) {
        await fsp.rm(job.dir,{recursive:true,force:true}).catch(()=>{}); jobs.delete(job.id);
        if (!res.headersSent) return json(res, received > MAX_BYTES ? 413 : 400, {error:received > MAX_BYTES ? 'Maximum upload size is 1 GB.' : `Upload failed: ${err.message}`});
        return;
      }
      if (!received) { await fsp.rm(job.dir,{recursive:true,force:true}); jobs.delete(job.id); return json(res,400,{error:'The uploaded file is empty.'}); }
      job.uploading = false;
      json(res,202,{jobId:job.id,eventsUrl:`/api/jobs/${job.id}/events`,size:received});
      void processJob(job);
      return;
    }
    const jobMatch = url.pathname.match(/^\/api\/jobs\/([0-9a-f-]{36})(?:\/(events|download|preview))?$/i);
    if (jobMatch) {
      const job = jobs.get(jobMatch[1]);
      if (!job) return json(res,404,{error:'This temporary job has expired or does not exist.'});
      const action = jobMatch[2];
      if (req.method === 'GET' && action === 'events') return sse(req,res,job);
      if (req.method === 'GET' && (action === 'download' || action === 'preview')) {
        if (!job.done || job.events.at(-1)?.type !== 'complete') return json(res,409,{error:'The verified output is not ready.'});
        const output = path.join(job.dir,'optimized.mp4');
        const stat = await fsp.stat(output).catch(()=>null);
        if (!stat) return json(res,404,{error:'The optimized output is no longer available.'});
        const result = job.events.at(-1).result;
        const headers = { 'Content-Type':'video/mp4','Content-Length':stat.size,'X-Content-Type-Options':'nosniff','Cache-Control':'no-store','Content-Disposition':action==='download'?`attachment; filename*=UTF-8''${encodeURIComponent(result.outputFilename)}`:'inline' };
        res.writeHead(200,headers); fs.createReadStream(output).pipe(res); return;
      }
      return json(res,404,{error:'Not found.'});
    }
    if (req.method === 'POST' && url.pathname === '/api/analyze-tiktok') {
      let body='';
      for await (const chunk of req) { body += chunk; if (body.length > 32768) { res.destroy(); return; } }
      let data;
      try { data=JSON.parse(body); } catch { return json(res,400,{error:'Invalid JSON request.'}); }
      try {
        const result = await analyzeTikTok(data.url);
        return json(res,200,result);
      } catch (err) {
        const message = err?.message || 'TikTok media could not be retrieved.';
        return json(res, message.startsWith('Enter a valid HTTPS TikTok video URL.') ? 400 : 502, {error:message});
      }
    }
    if (req.method === 'GET' || req.method === 'HEAD') return serveStatic(req,res,url);
    return json(res,405,{error:'Method not allowed.'});
  } catch (err) {
    if (!res.headersSent) json(res,500,{error:err?.message || 'Internal server error.'}); else res.destroy();
  }
});
const cleanup = setInterval(async()=>{
  for (const [id,job] of jobs) if (!job.uploading && (!job.busy || job.done) && Date.now()-job.createdAt > JOB_TTL_MS) {
    for (const client of job.clients) client.end();
    jobs.delete(id); await fsp.rm(job.dir,{recursive:true,force:true}).catch(()=>{});
  }
},60000); cleanup.unref?.();
await detectTools();
server.listen(PORT,HOST,()=>console.log(`FAHAD METHOD listening on http://${HOST}:${PORT} (ffmpeg=${toolStatus.ffmpeg}, ffprobe=${toolStatus.ffprobe}, yt-dlp=${toolStatus.ytDlp})`));
