import React, { useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import './styles.css';

type Media = {
  resolution: string; width: number|null; height: number|null; fps:number|null; fpsText:string; averageFps:number|null;
  videoCodec:string; audioCodec:string; videoBitrate:number|null; audioBitrate:number|null; duration:number|null; fileSize:number;
  aspectRatio:string; pixelFormat:string; colorSpace:string; colorTransfer?:string; hdr:string; videoStreamCount:number; audioStreamCount:number; streamCount:number;
  streams:Array<{index:number;type:string;codec:string;profile:string|null;width:number|null;height:number|null;fps:number|null;bitrate:number|null;pixFmt:string|null;colorSpace:string|null;language:string|null}>;
};
type Verify = { streamMetadataMatch:boolean; streamMetadataReason:string; encodedStreamHashesMatch:boolean; originalStreamHashes:Array<{index:number;hash:string}>; optimizedStreamHashes:Array<{index:number;hash:string}>; moovBeforeMdat:boolean; playbackDecodeValidated:boolean; originalContainerMoovBeforeMdat:boolean; containerOptimized:boolean };
type Result = { filename:string; outputFilename:string; original:Media; optimized:Media; processingMethod:string; verificationStatus:string; containerStatus:string; verification:Verify; originalContainer:{topLevel:Array<{type:string;size:number}>;sampleTableBoxes:Array<{type:string;size:number}>;moovBeforeMdat:boolean;boxCount:number}; optimizedContainer:{topLevel:Array<{type:string;size:number}>;sampleTableBoxes:Array<{type:string;size:number}>;moovBeforeMdat:boolean;boxCount:number}; sizeDelta:number; processingTimeMs:number; downloadUrl:string; previewUrl:string };
type TerminalEvent = { id?:number;at?:string;type?:string;number?:string|number;text?:string;progress?:number;detail?:string;message?:string;status?:string;result?:Result;processingTimeMs?:number };
type TikTokReport = { source:string;deliveredSource:string;title:string;creator:string;views:number|null;likes:number|null;comments:number|null;shares:number|null;specifications:Media;note:string;sourceUrl:string };

const fmtBytes=(n:number)=>{if(!Number.isFinite(n)||n<0)return'Unavailable';if(n===0)return'0 B';const u=['B','KB','MB','GB'];const i=Math.min(Math.floor(Math.log(n)/Math.log(1024)),3);return`${(n/1024**i).toFixed(i===0?0:2)} ${u[i]}`};
const fmtDuration=(n:number|null)=>{if(!n||!Number.isFinite(n))return'Unavailable';const s=Math.round(n);return`${Math.floor(s/60)}:${String(s%60).padStart(2,'0')}`};
const fmtRate=(n:number|null)=>n?`${(n/1e6).toFixed(n>1e6?2:3)} Mb/s`:'Unavailable';
const fmtCount=(n:number|null)=>n===null?'Unavailable':new Intl.NumberFormat('en').format(n);

function Icon({name,size=18}:{name:string;size?:number}){
 const p:Record<string,React.ReactNode>={
  arrow:<><path d="M5 12h14"/><path d="m13 6 6 6-6 6"/></>,
  upload:<><path d="M12 16V4"/><path d="m7 9 5-5 5 5"/><path d="M20 16v4H4v-4"/></>,
  play:<path d="m8 5 12 7-12 7z" fill="currentColor" stroke="none"/>,
  check:<path d="m5 12 4 4L19 6"/>,
  download:<><path d="M12 4v12"/><path d="m7 11 5 5 5-5"/><path d="M4 20h16"/></>,
  external:<><path d="M14 4h6v6"/><path d="M10 14 20 4"/><path d="M18 13v6H5V6h6"/></>,
  file:<><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/></>,
  shield:<><path d="M12 22s8-4 8-11V5l-8-3-8 3v6c0 7 8 11 8 11z"/><path d="m9 12 2 2 4-4"/></>,
  hash:<><path d="M4 9h16M4 15h16M10 3 8 21M16 3l-2 18"/></>,
  link:<><path d="M10 13a5 5 0 0 0 7.07 0l3-3A5 5 0 0 0 13 2.93l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.07 0l-3 3A5 5 0 0 0 11 21.07l1.71-1.71"/></>,
 };
 return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{p[name]||p.file}</svg>;
}
function Pill({children,tone='neutral'}:{children:React.ReactNode;tone?:string}){return <span className={`pill ${tone}`}><i />{children}</span>}
function Kicker({children}:{children:React.ReactNode}){return <div className="kicker"><span />{children}</div>}
function App(){
 const [file,setFile]=useState<File|null>(null),[busy,setBusy]=useState(false),[uploadProgress,setUploadProgress]=useState(0),[progress,setProgress]=useState<number|null>(0),[stageText,setStageText]=useState('Awaiting a video file'),[events,setEvents]=useState<TerminalEvent[]>([]),[result,setResult]=useState<Result|null>(null),[error,setError]=useState(''),[drag,setDrag]=useState(false);
 const [tiktokUrl,setTiktokUrl]=useState(''),[tiktokReport,setTiktokReport]=useState<TikTokReport|null>(null),[analyzing,setAnalyzing]=useState(false),[analysisError,setAnalysisError]=useState('');
 const [health,setHealth]=useState<'checking'|'ready'|'offline'>('checking');
 const inputRef=useRef<HTMLInputElement>(null),terminalRef=useRef<HTMLDivElement>(null);
 useEffect(()=>{fetch('/api/health').then(r=>r.ok?r.json():Promise.reject()).then(()=>setHealth('ready')).catch(()=>setHealth('offline'));},[]);
 useEffect(()=>{if(terminalRef.current)terminalRef.current.scrollTop=terminalRef.current.scrollHeight;},[events]);
 const terminalLines=useMemo(()=>events.slice(-80),[events]);
 function addLocal(text:string,type='info',detail=''){setEvents((old)=>[...old,{id:Date.now()+Math.random(),at:new Date().toISOString(),type,text,detail}]);}
 function selectFile(f:File|null){if(!f)return;setError('');setResult(null);if(!/\.(mp4|mov|m4v)$/i.test(f.name)){setError('Choose an MP4, MOV, or M4V file.');return}if(f.size>1024**3){setError('Maximum file size is 1 GB.');return}if(!f.size){setError('This file is empty.');return}setFile(f);}
 function startOptimization(){if(!file||busy)return;setBusy(true);setError('');setResult(null);setEvents([]);setProgress(0);setUploadProgress(0);setStageText('Uploading original video…');
   const xhr=new XMLHttpRequest();xhr.open('POST',`/api/optimize?filename=${encodeURIComponent(file.name)}`);xhr.setRequestHeader('Content-Type','application/octet-stream');
   xhr.upload.onprogress=(e)=>{if(e.lengthComputable){const p=Math.floor(e.loaded/e.total*100);setUploadProgress(p);setProgress(p);setStageText(`Uploading original video… ${p}%`);}};
   xhr.onerror=()=>{setError('Upload connection failed. The server may be unavailable.');setBusy(false);setStageText('Engine unavailable');};
   xhr.onload=()=>{let body:any={};try{body=JSON.parse(xhr.responseText)}catch{}
    if(xhr.status!==202){setError(body.error||`Upload failed (${xhr.status}).`);setBusy(false);setStageText('Upload failed');return}
    setUploadProgress(100);setProgress(null);setStageText('Upload complete · waiting for FFprobe inspection');addLocal(`Upload complete · ${fmtBytes(file.size)}`,'stage','Received by the local processing backend.');
    const source=new EventSource(body.eventsUrl);
    source.addEventListener('stage',(raw)=>{const e=JSON.parse((raw as MessageEvent).data) as TerminalEvent;setEvents(old=>[...old,e]);setProgress(null);setStageText(e.text||'Processing');});
    source.addEventListener('progress',(raw)=>{const e=JSON.parse((raw as MessageEvent).data) as TerminalEvent;setProgress(typeof e.progress==='number'?e.progress:null);setEvents(old=>{if(old.at(-1)?.type==='progress')return [...old.slice(0,-1),e];return [...old,e]});if(e.detail)setStageText(e.detail);});
    source.addEventListener('complete',(raw)=>{const e=JSON.parse((raw as MessageEvent).data) as TerminalEvent;if(e.result){setResult(e.result);setProgress(100);setStageText('Optimization and verification complete');}setBusy(false);source.close();});
    source.addEventListener('error',(raw)=>{const me=raw as MessageEvent;if(me.data){const e=JSON.parse(me.data) as TerminalEvent;setError(`${e.status||'Processing failed'}: ${e.message||'Unknown error'}`);setEvents(old=>[...old,e]);setStageText(e.status||'Processing failed');}else if(source.readyState===EventSource.CLOSED&&!result){setError('Processing connection closed before a verified result arrived.');setStageText('Connection closed');}setProgress(null);setBusy(false);source.close();});
   };
   xhr.send(file);
 }
 async function analyzeTikTok(e:React.FormEvent){e.preventDefault();if(analyzing)return;setAnalyzing(true);setTiktokReport(null);setAnalysisError('');try{const r=await fetch('/api/analyze-tiktok',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({url:tiktokUrl})});const d=await r.json();if(!r.ok)throw new Error(d.error||'Analysis failed.');setTiktokReport(d);}catch(err:any){setAnalysisError(err.message||'TikTok media could not be retrieved.');}finally{setAnalyzing(false)}}
 const effectiveTerminal=terminalLines.length?terminalLines:null;
 const nav=[['#optimizer','Optimizer'],['#terminal','Activity terminal'],['#analyzer','TikTok analyzer'],['#contact','Contact']];
 return <div className="app-shell">
  <header className="topbar"><a href="#top" className="brand" aria-label="Fahad Method home"><span className="brand-mark"><span /><span /><span /></span><span>FAHAD <b>METHOD</b></span></a>
   <nav className="main-nav" aria-label="Main navigation">{nav.map(([href,label])=><a key={href} href={href}>{label}</a>)}</nav>
   <div className="top-state"><span className={`status-dot ${health}`} />{health==='ready'?'ENGINE ONLINE':health==='offline'?'ENGINE OFFLINE':'CHECKING ENGINE'}</div>
  </header>
  <main id="top">
   <section className="hero wrap" id="optimizer">
    <div className="hero-copy"><Kicker>LOSSLESS CONTAINER OPTIMIZATION</Kicker><h1>Keep the stream.<br/><span>Optimize the container.</span></h1>
     <p className="hero-lede">A preservation-first MP4 workflow. The encoded video and audio stay untouched while the container is remuxed and independently verified.</p>
     <div className="hero-points"><span><Icon name="shield" size={15}/> Stream-copy only</span><span><Icon name="hash" size={15}/> SHA-256 verified</span><span><Icon name="play" size={15}/> Playback checked</span></div>
    </div>
    <div className="container-visual" aria-label="MP4 container processing overview">
     <div className="visual-head"><span>CONTAINER MAP</span><Pill tone="green">MP4 / MOV</Pill></div>
     <div className="atom-track"><div className="atom ftyp"><small>01</small><b>ftyp</b><em>file type</em></div><div className="atom moov"><small>02</small><b>moov</b><em>index + timing</em></div><div className="atom mdat"><small>03</small><b>mdat</b><em>encoded media</em></div></div>
     <div className="visual-caption"><span className="live-line"/><span>Original sample payloads are hash-checked after remux.</span></div>
     <div className="visual-footer"><span>NO TRANSCODE</span><span>NO QUALITY PRESET</span><span>NO FRAME-RATE CHANGE</span></div>
    </div>
   </section>
   <section className="workspace wrap">
    <div className="section-heading"><div><Kicker>01 / VIDEO OPTIMIZER</Kicker><h2>Source in. Verified file out.</h2></div><div className="size-limit"><span className="tiny-dot"/> Maximum upload <b>1 GB</b></div></div>
    <div className="optimizer-grid">
     <div className="panel upload-panel">
      <div className="panel-top"><div><span className="eyebrow">SELECT SOURCE</span><span className="panel-count">01</span></div><Icon name="file" size={17}/></div>
      <div className={`dropzone ${drag?'dragging':''} ${file?'has-file':''}`} onDragOver={e=>{e.preventDefault();setDrag(true)}} onDragLeave={()=>setDrag(false)} onDrop={e=>{e.preventDefault();setDrag(false);selectFile(e.dataTransfer.files?.[0]||null)}}>
       <input ref={inputRef} type="file" accept=".mp4,.mov,.m4v,video/mp4,video/quicktime" onChange={e=>selectFile(e.target.files?.[0]||null)} aria-label="Choose video file" />
       <div className="upload-icon"><Icon name={file?'check':'upload'} size={22}/></div>
       {file?<><strong className="file-name">{file.name}</strong><span className="drop-sub">{fmtBytes(file.size)} · {file.type||'video file'}</span><button className="text-button" onClick={()=>{setFile(null);setResult(null);if(inputRef.current)inputRef.current.value=''}}>Remove file</button></>:<><strong>Drop a video to begin</strong><span className="drop-sub">or choose a file from your device</span><button className="outline-button" onClick={()=>inputRef.current?.click()}>BROWSE VIDEO</button><span className="formats">MP4 · MOV · M4V</span></>}
      </div>
      <div className="upload-bottom"><span>ENCODED STREAMS ARE NEVER RE-ENCODED</span><span>≤ 1 GB</span></div>
      {error&&<div className="inline-error" role="alert">{error}</div>}
      <button className="primary-button optimize-button" disabled={!file||busy||health!=='ready'} onClick={startOptimization}>{busy?<><span className="spinner"/>PROCESSING SOURCE</>:<>OPTIMIZE VIDEO <Icon name="arrow" size={17}/></>}</button>
      <p className="action-note">Stream-copy remux only. If safe preservation is impossible, processing stops.</p>
     </div>
     <div className="panel method-panel">
      <div className="panel-top"><div><span className="eyebrow">METHOD / 4 CHECKPOINTS</span><span className="panel-count">02</span></div><Pill tone={health==='ready'?'green':health==='offline'?'red':'neutral'}>{health==='ready'?'READY':health==='offline'?'OFFLINE':'CHECKING'}</Pill></div>
      <ol className="method-list"><li><span className="step-index">A</span><div><b>Inspect structure</b><small>FFprobe metadata · MP4 atom tree</small></div></li><li><span className="step-index">B</span><div><b>Remux, never re-encode</b><small>FFmpeg stream-copy · fast-start layout</small></div></li><li><span className="step-index">C</span><div><b>Compare stream hashes</b><small>SHA-256 packet hashes · original vs output</small></div></li><li><span className="step-index">D</span><div><b>Validate playable output</b><small>FFprobe · MP4 structure · decode check</small></div></li></ol>
      <div className="method-note"><Icon name="shield" size={16}/><span>No claim of TikTok-side quality retention. TikTok may encode uploads independently.</span></div>
     </div>
    </div>
    <div className="result-wrap" aria-live="polite">
     {busy&&<div className="progress-card"><div className="progress-title"><div><span className="eyebrow">LIVE PROCESS · {events.at(-1)?.type==='progress'?'FFMPEG REMUX':'BACKEND STAGE'}</span><strong>{stageText}</strong></div><span className="progress-number">{progress===null?'—':`${progress}%`}</span></div>{progress!==null&&<div className="progress-rail"><span style={{width:`${progress}%`}}/></div>}<div className="progress-meta"><span>Upload transfer {uploadProgress}%</span><span>{events.length?`${events.length} backend events`:'Awaiting engine events'}</span><span>Elapsed <Elapsed running={busy}/></span></div></div>}
     {result&&<ResultCard result={result}/>}
    </div>
   </section>
   <section className="terminal-section wrap" id="terminal"><div className="section-heading"><div><Kicker>02 / PROCESSING ACTIVITY TERMINAL</Kicker><h2>Every line maps to real work.</h2></div><Pill tone={busy?'green':error?'red':'neutral'}>{busy?'PROCESSING':error?'REQUIRES ATTENTION':result?'VERIFIED':'IDLE'}</Pill></div>
    <div className="terminal panel"><div className="terminal-head"><div className="terminal-controls"><i/><i/><i/></div><span>FAHAD METHOD ENGINE / LIVE LOG</span><span className="terminal-time">{busy?'LIVE':result?'COMPLETED':'READY'}</span></div>
     <div className="terminal-body" ref={terminalRef} role="log" aria-live="polite" aria-label="Processing activity">
      {!effectiveTerminal?<div className="terminal-empty"><span className="prompt-mark">&gt;_</span><span>Waiting for source media. Actual backend activity appears here.</span></div>:effectiveTerminal.map((e,i)=><div className={`log-row ${e.type==='error'?'log-error':''}`} key={e.id||i}><time>{e.at?new Date(e.at).toLocaleTimeString('en-GB',{hour12:false}):'--:--:--'}</time><span className="log-marker">{e.number?`[${String(e.number).padStart(2,'0')}]`:e.type==='error'?'[ERR]':e.type==='progress'?'[RUN]':'[SYS]'}</span><div><strong>{e.text||e.message||e.detail||'Processing update'}</strong>{e.detail&&<small>{e.detail}</small>}</div></div>)}
     </div><div className="terminal-foot"><span><i className={`status-dot ${busy?'ready':''}`}/>{busy?'BACKEND EVENT STREAM':'LOCAL ENGINE'}</span><span>{events.length?`${events.length} event${events.length===1?'':'s'}`:'NO EVENTS'}</span></div>
    </div>
   </section>
   <section className="analyzer-section wrap" id="analyzer"><div className="section-heading"><div><Kicker>03 / TIKTOK ANALYZER</Kicker><h2>Inspect delivered media.</h2><p>Fetch accessible TikTok video media, then inspect the delivered file with FFprobe. Private, removed, region-blocked, or inaccessible videos remain unavailable.</p></div></div>
    <div className="analyzer-grid"><form className="panel analyzer-form" onSubmit={analyzeTikTok}><label htmlFor="tiktok-url" className="eyebrow">TIKTOK VIDEO URL</label><div className="url-input-wrap"><Icon name="link" size={18}/><input id="tiktok-url" type="url" required placeholder="https://www.tiktok.com/@creator/video/..." value={tiktokUrl} onChange={e=>setTiktokUrl(e.target.value)} /></div><button className="primary-button" disabled={analyzing}>{analyzing?<><span className="spinner"/>RETRIEVING MEDIA</>:<>ANALYZE VIDEO <Icon name="arrow" size={17}/></>}</button><p className="action-note">Only TikTok video URLs are accepted. No engagement data is inferred or fabricated.</p>{analysisError&&<div className="inline-error" role="alert">{analysisError}</div>}</form>
     <div className="panel analyzer-result">{tiktokReport?<TikTokCard report={tiktokReport}/>:<div className="analyzer-empty"><div className="empty-mark"><Icon name="play" size={21}/></div><strong>Awaiting a public video link</strong><span>Unavailable metrics will be labeled honestly. Media specifications describe the copy TikTok served.</span></div>}</div>
    </div>
   </section>
   <section className="studio-section wrap" id="studio"><div className="studio-card"><div className="studio-left"><Kicker>04 / TIKTOK STUDIO UPLOAD</Kicker><h2>Your video is ready.<br/><span>Upload it yourself.</span></h2><p>Download the verified MP4, then choose it in TikTok Studio. TikTok controls any processing after upload.</p></div><div className="studio-actions">{result?<a className="primary-button" href={result.downloadUrl}><Icon name="download" size={17}/> DOWNLOAD OPTIMIZED VIDEO</a>:<button className="primary-button" disabled><Icon name="download" size={17}/> DOWNLOAD OPTIMIZED VIDEO</button>}<a className="outline-button studio-link" href="https://www.tiktok.com/tiktokstudio/upload" target="_blank" rel="noreferrer">OPEN TIKTOK STUDIO <Icon name="external" size={16}/></a><span className="studio-caption">TikTok Studio opens in a new tab · manual upload</span></div></div></section>
  </main>
  <footer className="footer wrap" id="contact"><div className="footer-brand"><a href="#top" className="brand"><span className="brand-mark"><span/><span/><span/></span><span>FAHAD <b>METHOD</b></span></a><span>Professional Video Method Optimization</span></div><div className="footer-credit">Developed by <b>Fahad</b></div><div className="footer-links"><a href="https://www.facebook.com/fahad31674" target="_blank" rel="noreferrer">Facebook <Icon name="external" size={13}/></a><a href="https://www.tiktok.com/@fahad16042026" target="_blank" rel="noreferrer">TikTok <Icon name="external" size={13}/></a></div></footer>
 </div>
}
function Elapsed({running}:{running:boolean}){const [s,setS]=useState(0);useEffect(()=>{if(!running)return;const t=setInterval(()=>setS(v=>v+1),1000);return()=>clearInterval(t)},[running]);return <>{Math.floor(s/60)}:{String(s%60).padStart(2,'0')}</>}
function ResultCard({result:r}:{result:Result}){
 const rows=(m:Media)=>[['Resolution',m.resolution],['FPS',m.fpsText],['Video codec',m.videoCodec],['Audio codec',m.audioCodec],['File size',fmtBytes(m.fileSize)]];
 return <div className="result-card panel"><div className="result-head"><div><Kicker>VERIFIED OUTPUT</Kicker><h3>YOUR VIDEO IS READY!</h3><span className="result-file"><Icon name="file" size={15}/>{r.outputFilename}</span></div><Pill tone="green"><Icon name="check" size={13}/> STREAMS PRESERVED</Pill></div>
  <div className="result-columns"><div className="info-column"><span className="eyebrow">ORIGINAL</span>{rows(r.original).map(([k,v])=><div className="info-row" key={k}><span>{k}</span><b>{v}</b></div>)}</div><div className="info-column output-column"><span className="eyebrow">OPTIMIZED MP4</span>{rows(r.optimized).map(([k,v])=><div className="info-row" key={k}><span>{k}</span><b>{v}</b></div>)}</div></div>
  <div className="verification-box"><div className="verify-title"><Icon name="shield" size={17}/><b>Verification passed</b><span>INDEPENDENT CHECK</span></div><div className="verify-points"><span><Icon name="check" size={13}/> Encoded packet SHA-256 hashes match</span><span><Icon name="check" size={13}/> Codec initialization hashes match</span><span><Icon name="check" size={13}/> FFprobe stream parameters match</span><span><Icon name="check" size={13}/> MP4 fast-start structure validated</span><span><Icon name="check" size={13}/> Output video/audio decode checked</span></div><div className="method-detail">{r.processingMethod}</div></div>
  <div className="result-actions"><a className="primary-button download-cta" href={r.downloadUrl}><Icon name="download" size={18}/> DOWNLOAD OPTIMIZED VIDEO</a><span>Container bytes changed by {r.sizeDelta>=0?'+':''}{fmtBytes(r.sizeDelta)} · {fmtDuration(r.processingTimeMs/1000)} processing</span></div>
  <details className="stream-details"><summary>View stream hash and MP4 structure verification</summary><div className="details-grid"><div><b>Original SHA-256</b>{r.verification.originalStreamHashes.map(x=><code key={x.index}>Stream {x.index}: {x.hash}</code>)}</div><div><b>Optimized SHA-256</b>{r.verification.optimizedStreamHashes.map(x=><code key={x.index}>Stream {x.index}: {x.hash}</code>)}</div></div><div className="atom-summary">Input atoms: {r.originalContainer.topLevel.map(x=>x.type).join(' · ')} <span>→</span> Output atoms: {r.optimizedContainer.topLevel.map(x=>x.type).join(' · ')}<br/>Inspected {r.originalContainer.boxCount} input boxes · {r.originalContainer.sampleTableBoxes.length} sample-table boxes · moov before mdat: {r.originalContainer.moovBeforeMdat?'yes':'no'} → {r.optimizedContainer.moovBeforeMdat?'yes':'no'}</div></details>
 </div>
}
function TikTokCard({report:r}:{report:TikTokReport}){
 const m=r.specifications;
 const rows:[string,string][]=[['Resolution',m.resolution],['Width',m.width?`${m.width} px`:'Unavailable'],['Height',m.height?`${m.height} px`:'Unavailable'],['FPS',m.fpsText],['Average FPS',m.averageFps?`${m.averageFps.toFixed(3)} fps`:'Unavailable'],['Video codec',m.videoCodec],['Audio codec',m.audioCodec],['Video bitrate',fmtRate(m.videoBitrate)],['Audio bitrate',fmtRate(m.audioBitrate)],['File size',fmtBytes(m.fileSize)],['Duration',fmtDuration(m.duration)],['Aspect ratio',m.aspectRatio],['Pixel format',m.pixelFormat],['Color space',m.colorSpace],['HDR status',m.hdr]];
 return <><div className="analyzer-card-head"><div><span className="eyebrow">DELIVERED VIDEO SPECIFICATIONS</span><h3>{r.title}</h3><span className="creator-line">{r.creator}</span></div><Pill tone="green">FFPROBE VERIFIED</Pill></div><div className="source-label"><span>NOT ORIGINAL SOURCE GUARANTEE</span>{r.deliveredSource}</div><div className="analyzer-stats">{rows.map(([k,v])=><div className="stat-cell" key={k}><span>{k}</span><b>{v}</b></div>)}</div><div className="engagement"><span className="eyebrow">PUBLIC ENGAGEMENT · PAGE METADATA</span><div>{[['Views',r.views],['Likes',r.likes],['Comments',r.comments],['Shares',r.shares]].map(([k,v])=><div key={String(k)}><span>{k}</span><b>{fmtCount(v as number|null)}</b></div>)}</div></div><p className="tiktok-note">{r.note}</p></>;
}

createRoot(document.getElementById('root')!).render(<App/>);
