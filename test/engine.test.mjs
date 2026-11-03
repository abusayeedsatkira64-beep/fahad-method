import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function freePort() {
  const srv = net.createServer(); srv.listen(0, '127.0.0.1'); await once(srv, 'listening');
  const { port } = srv.address(); await new Promise((r) => srv.close(r)); return port;
}
async function waitHealthy(url, proc) {
  for (let i=0;i<100;i++) {
    if (proc.exitCode !== null) throw new Error(`server exited early: ${proc.exitCode}`);
    try { const r=await fetch(`${url}/api/health`); if(r.ok)return; } catch {}
    await sleep(100);
  }
  throw new Error('server did not become healthy');
}
async function readSse(response) {
  assert.equal(response.status,200);
  const reader=response.body.getReader(), decoder=new TextDecoder();
  let buf='', events=[];
  while (true) {
    const {done,value}=await reader.read();
    if(done)break;
    buf+=decoder.decode(value,{stream:true});
    let boundary;
    while((boundary=buf.indexOf('\n\n'))>=0){
      const block=buf.slice(0,boundary);buf=buf.slice(boundary+2);
      const ev=block.split('\n').find(x=>x.startsWith('event:'))?.slice(6).trim();
      const data=block.split('\n').find(x=>x.startsWith('data:'))?.slice(5).trim();
      if(data){const parsed=JSON.parse(data);events.push({...parsed,type:ev||parsed.type});if(ev==='complete'||ev==='error'){await reader.cancel();return events}}
    }
  }
  return events;
}

test('end-to-end MP4 stream-copy optimization, verification, and actual download across source types', { timeout: 240000 }, async (t) => {
  const tmp=await fs.mkdtemp(path.join(os.tmpdir(),'fahad-test-'));
  const port=await freePort(), base=`http://127.0.0.1:${port}`;
  let logs='';
  const server=spawn(process.execPath,['server.mjs'],{cwd:ROOT,env:{...process.env,PORT:String(port),HOST:'127.0.0.1'},stdio:['ignore','pipe','pipe']});
  server.stdout.on('data',b=>logs+=b.toString());server.stderr.on('data',b=>logs+=b.toString());
  t.after(async()=>{server.kill('SIGTERM');await Promise.race([once(server,'exit'),sleep(2000)]);await fs.rm(tmp,{recursive:true,force:true});});
  await waitHealthy(base,server);
  const cases=[
    {name:'1080p30-with-audio.mp4',src:'testsrc2=size=1920x1080:rate=30',duration:'0.5',v:['-c:v','libx264','-preset','ultrafast','-pix_fmt','yuv420p','-threads','2'],a:['-f','lavfi','-i','sine=frequency=997:sample_rate=44100','-c:a','aac','-b:a','96k'],width:1920,height:1080,fps:30,codecs:['h264','aac']},
    {name:'1080p60.mp4',src:'testsrc2=size=1920x1080:rate=60',duration:'0.25',v:['-c:v','libx264','-preset','ultrafast','-pix_fmt','yuv420p','-threads','2'],width:1920,height:1080,fps:60,codecs:['h264']},
    {name:'4k60.mp4',src:'testsrc2=size=3840x2160:rate=60',duration:'0.25',v:['-c:v','libx264','-preset','ultrafast','-pix_fmt','yuv420p','-threads','2'],width:3840,height:2160,fps:60,codecs:['h264']},
    {name:'high-frame-rate-120.mp4',src:'testsrc2=size=640x360:rate=120',duration:'0.5',v:['-c:v','libx264','-preset','ultrafast','-pix_fmt','yuv420p'],width:640,height:360,fps:120,codecs:['h264']},
    {name:'quicktime-source.mov',src:'testsrc2=size=640x360:rate=30',duration:'0.4',v:['-c:v','libx264','-preset','ultrafast','-pix_fmt','yuv420p','-f','mov'],width:640,height:360,fps:30,codecs:['h264']},
    {name:'hdr-pq-main10.mp4',src:'testsrc2=size=320x240:rate=24',duration:'0.5',v:['-c:v','libx265','-preset','ultrafast','-pix_fmt','yuv420p10le','-x265-params','log-level=error:pools=1:frame-threads=1','-color_primaries','bt2020','-color_trc','smpte2084','-colorspace','bt2020nc'],width:320,height:240,fps:24,codecs:['hevc'],hdr:'HDR10 / PQ'},
  ];
  for(const c of cases){
    const source=path.join(tmp,c.name);
    const args=['-hide_banner','-loglevel','error','-f','lavfi','-i',c.src,...(c.a||[]),'-t',c.duration,...c.v,'-y',source];
    execFileSync('ffmpeg',args,{timeout:120000,stdio:['ignore','ignore','pipe']});
    const originalBytes=await fs.readFile(source);
    const upload=await fetch(`${base}/api/optimize?filename=${encodeURIComponent(c.name)}`,{method:'POST',headers:{'Content-Type':'application/octet-stream'},body:originalBytes});
    const accepted=await upload.json();
    assert.equal(upload.status,202,`${c.name}: ${JSON.stringify(accepted)}`);
    const events=await readSse(await fetch(`${base}${accepted.eventsUrl}`,{headers:{Accept:'text/event-stream'}}));
    const complete=events.find(e=>e.type==='complete');
    assert.ok(complete,`${c.name}: no complete event: ${JSON.stringify(events.at(-1))}`);
    const result=complete.result;
    assert.equal(result.verificationStatus,'Original encoded streams preserved',c.name);
    assert.equal(result.containerStatus,'Container optimization successful',c.name);
    assert.equal(result.verification.encodedStreamHashesMatch,true,c.name);
    assert.equal(result.verification.codecExtradataHashesMatch,true,c.name);
    assert.equal(result.verification.streamMetadataMatch,true,c.name);
    assert.equal(result.verification.durationMatch,true,c.name);
    assert.equal(result.verification.playbackDecodeValidated,true,c.name);
    assert.equal(result.verification.moovBeforeMdat,true,c.name);
    assert.ok(events.some(e=>e.number==='06'),`${c.name}: sample-table inspection stage missing`);
    assert.ok(events.some(e=>e.number==='11'),`${c.name}: stream verification stage missing`);
    assert.ok(events.some(e=>e.type==='progress'),`${c.name}: real FFmpeg progress event missing`);
    assert.ok(events.filter(e=>e.type==='stage').every(e=>e.progress===undefined),`${c.name}: a stage must not report fabricated percent progress`);
    const download=await fetch(`${base}${result.downloadUrl}`);
    assert.equal(download.status,200,c.name);
    assert.match(download.headers.get('content-type'),/video\/mp4/);
    const outputBytes=Buffer.from(await download.arrayBuffer());
    assert.equal(outputBytes.length,result.optimized.fileSize,c.name);
    const saved=path.join(tmp,`out-${c.name.replace(/\W/g,'-')}.mp4`);await fs.writeFile(saved,outputBytes);
    const probe=JSON.parse(execFileSync('ffprobe',['-v','error','-show_entries','stream=codec_name,codec_type,width,height,avg_frame_rate,color_transfer','-show_entries','format=duration,format_name','-of','json',saved],{encoding:'utf8'}));
    assert.deepEqual(probe.streams.map(s=>s.codec_name),c.codecs,c.name);
    const video=probe.streams.find(s=>s.codec_type==='video');
    assert.equal(video.width,c.width,c.name);assert.equal(video.height,c.height,c.name);
    assert.ok(Math.abs(evalRate(video.avg_frame_rate)-c.fps)<0.01,`${c.name}: frame rate was ${video.avg_frame_rate}`);
    assert.match(result.processingMethod,/No re-encoding/);
    assert.ok(result.optimizedContainer.moovBeforeMdat);
    if(c.hdr) assert.equal(result.optimized.hdr,c.hdr,c.name);
    if(c.name.endsWith('.mov')) assert.match(probe.format?.format_name||'',/mp4|mov/);
    assert.ok(originalBytes.length>0&&outputBytes.length>0);
  }
  assert.ok(logs.includes('FAHAD METHOD listening'));
});
function evalRate(value){const[a,b]=String(value).split('/').map(Number);return b?a/b:0}

test('TikTok endpoint rejects non-TikTok and non-HTTPS URLs before retrieval', { timeout: 15000 }, async(t)=>{
  const port=await freePort(),base=`http://127.0.0.1:${port}`;
  const server=spawn(process.execPath,['server.mjs'],{cwd:ROOT,env:{...process.env,PORT:String(port),HOST:'127.0.0.1'},stdio:'ignore'});
  t.after(async()=>{server.kill('SIGTERM');await Promise.race([once(server,'exit'),sleep(1500)]);});
  await waitHealthy(base,server);
  for(const url of ['http://www.tiktok.com/@a/video/123','https://example.com/@a/video/123','https://www.tiktok.com/@a/profile']){
    const response=await fetch(`${base}/api/analyze-tiktok`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({url})});
    assert.equal(response.status,400);
    assert.match((await response.json()).error,/valid HTTPS TikTok video URL/);
  }
});
