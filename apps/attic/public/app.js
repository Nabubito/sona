'use strict';
// Attic — client. Owns the live viewfinder, the shutter, the four-stage
// pipeline animation, and the gallery/lightbox over the manifest.

const $  = (s, r=document) => r.querySelector(s);
const $$ = (s, r=document) => [...r.querySelectorAll(s)];

const els = {
  boot:$('#boot'), bootlog:$('#bootlog'),
  video:$('#video'), canvas:$('#canvas'),
  viewport:$('#viewport'), gridOverlay:$('#gridOverlay'), flash:$('#flash'),
  vpBadge:$('#vpBadge'), countdown:$('#countdown'),
  recBadge:$('#recBadge'), recTime:$('#recTime'),
  modeSwitch:$('#modeSwitch'), modes:$$('.mode'),
  fallback:$('#vpFallback'), fallbackMsg:$('#fallbackMsg'), btnGrant:$('#btnGrant'),
  btnGrid:$('#btnGrid'), btnLevel:$('#btnLevel'), btnMirror:$('#btnMirror'), btnTimer:$('#btnTimer'), timerLbl:$('#timerLbl'),
  lensChips:$('#lensChips'), level:$('#level'), levelLive:$('#levelLive'), levelDeg:$('#levelDeg'),
  btnTorch:$('#btnTorch'), btnGeo:$('#btnGeo'), btnFx:$('#btnFx'), btnPro:$('#btnPro'),
  vignette:$('#vignette'), zoomPill:$('#zoomPill'), fxStrip:$('#fxStrip'), proPanel:$('#proPanel'),
  modeWheel:$('#modeWheel'), wheelMode:$('#wheelMode'), wheelKnurl:$('#modeWheel .wheel-knurl'),
  pZoom:$('#pZoom'), pBright:$('#pBright'), pContrast:$('#pContrast'), pSat:$('#pSat'), pWarmth:$('#pWarmth'), pVig:$('#pVig'), pReset:$('#pReset'),
  vZoom:$('#vZoom'), vBright:$('#vBright'), vContrast:$('#vContrast'), vSat:$('#vSat'), vWarmth:$('#vWarmth'), vVig:$('#vVig'),
  btnShutter:$('#btnShutter'), btnSwitch:$('#btnSwitch'), btnUpload:$('#btnUpload'), filePick:$('#filePick'),
  pipeline:$('#pipeline'),
  gallery:$('#gallery'), galleryEmpty:$('#galleryEmpty'), gStats:$('#gStats'),
  pStats:$('#pStats'), pClock:$('#pClock'),
  tabs:$$('.tab'),
  lightbox:$('#lightbox'), lbImg:$('#lbImg'), lbVid:$('#lbVid'), lbMeta:$('#lbMeta'), lbClose:$('#lbClose'),
  lbPrev:$('#lbPrev'), lbNext:$('#lbNext'), lbFav:$('#lbFav'), lbDownload:$('#lbDownload'), lbDelete:$('#lbDelete'),
  toast:$('#toast'),
};

const IC = n => `<svg class="s-i" aria-hidden="true"><use href="/assets/sona-ui/icons.svg#${n}"/></svg>`;
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const state = {
  stream:null, facing:'environment', mirror:false, grid:false, timer:0, torch:false,
  geoOn:false, geo:null, busy:false, hasMultiCam:false, levelOn:false,
  photos:[], tab:'all', lbIndex:-1, deviceLabel:navigator.platform || 'device',
  // video
  mode:'photo', recording:false, recorder:null, chunks:[], recStart:0, recMime:'', recTimer:null,
  // pro / fx
  fx:{ preset:'none', brightness:1, contrast:1, saturate:1, warmth:0, vignette:0, zoom:1 },
  hwZoom:false, zoomCaps:{min:1,max:5,step:0.1}, fxSnap:null, fxCanvasStop:null,
};

// Instagram-style looks. Each is a CSS filter string baked identically into the
// live preview, the captured JPEG, and recorded video frames.
const PRESETS = [
  { key:'none',      name:'Original',  f:'' },
  { key:'canon',     name:'Canon Pro', f:'contrast(1.08) saturate(1.12) brightness(1.03)' },
  { key:'vivid',     name:'Vivid',     f:'saturate(1.45) contrast(1.12)' },
  { key:'clarendon', name:'Clarendon', f:'contrast(1.2) saturate(1.35) brightness(1.05)' },
  { key:'juno',      name:'Juno',      f:'saturate(1.4) contrast(1.05) sepia(0.1)' },
  { key:'ludwig',    name:'Ludwig',    f:'saturate(1.25) contrast(1.05) brightness(1.05) sepia(0.08)' },
  { key:'lark',      name:'Lark',      f:'contrast(0.92) brightness(1.1) saturate(1.12)' },
  { key:'aden',      name:'Aden',      f:'hue-rotate(-18deg) contrast(0.9) saturate(0.85) brightness(1.1)' },
  { key:'gingham',   name:'Gingham',   f:'brightness(1.05) sepia(0.06) contrast(0.9)' },
  { key:'vintage',   name:'Vintage',   f:'sepia(0.35) contrast(1.1) brightness(1.05) saturate(1.3)' },
  { key:'moon',      name:'Moon',      f:'grayscale(1) contrast(1.1) brightness(1.1)' },
  { key:'noir',      name:'Noir',      f:'grayscale(1) contrast(1.45) brightness(0.95)' },
];

// Build the combined CSS filter from the active preset + manual pro adjustments.
function composedFilter(){
  const fx = state.fx;
  const p = PRESETS.find(x=>x.key===fx.preset);
  let s = (p && p.f) ? p.f + ' ' : '';
  if (fx.brightness !== 1) s += `brightness(${fx.brightness}) `;
  if (fx.contrast   !== 1) s += `contrast(${fx.contrast}) `;
  if (fx.saturate   !== 1) s += `saturate(${fx.saturate}) `;
  // white balance: warm = sepia + a touch of saturation; cool = hue toward blue
  if (fx.warmth > 0) s += `sepia(${(fx.warmth*0.4).toFixed(3)}) saturate(${(1+fx.warmth*0.25).toFixed(3)}) `;
  else if (fx.warmth < 0) s += `hue-rotate(${Math.round(fx.warmth*22)}deg) saturate(${(1+(-fx.warmth)*0.05).toFixed(3)}) `;
  return s.trim() || 'none';
}
function fxActive(){
  const f = state.fx;
  return f.preset!=='none' || f.brightness!==1 || f.contrast!==1 || f.saturate!==1 || f.warmth!==0 || f.vignette>0 || (!state.hwZoom && f.zoom!==1);
}

// Apply the live preview transform: filter + mirror + digital zoom + vignette.
function applyFx(){
  els.video.style.filter = composedFilter();
  const z = state.hwZoom ? 1 : state.fx.zoom;
  els.video.style.transform = `${state.mirror?'scaleX(-1) ':''}scale(${z})`;
  els.vignette.style.opacity = state.fx.vignette;
  const zv = state.fx.zoom.toFixed(1)+'×';
  els.zoomPill.textContent = zv; els.vZoom.textContent = zv;
  els.zoomPill.hidden = state.fx.zoom <= 1.001;
}

// Draw the current video frame into ctx with all effects baked in (zoom crop,
// mirror, filter, vignette) — used for both photo capture and video frames.
function drawFrame(ctx, w, h){
  const z = state.hwZoom ? 1 : state.fx.zoom;
  ctx.save();
  ctx.filter = composedFilter();
  if (state.mirror){ ctx.translate(w,0); ctx.scale(-1,1); }
  const sw = w/z, sh = h/z, sx = (w-sw)/2, sy = (h-sh)/2;   // centered crop for digital zoom
  try { ctx.drawImage(els.video, sx, sy, sw, sh, 0, 0, w, h); } catch {}
  ctx.restore();
  if (state.fx.vignette > 0) drawVignette(ctx, w, h, state.fx.vignette);
}
function drawVignette(ctx, w, h, amt){
  const g = ctx.createRadialGradient(w/2, h/2, Math.min(w,h)*0.32, w/2, h/2, Math.max(w,h)*0.72);
  g.addColorStop(0, 'rgba(0,0,0,0)');
  g.addColorStop(1, `rgba(0,0,0,${(amt*0.72).toFixed(3)})`);
  ctx.fillStyle = g; ctx.fillRect(0,0,w,h);
}

function setZoom(z){
  z = Math.max(state.zoomCaps.min, Math.min(state.zoomCaps.max, z));
  state.fx.zoom = z; els.pZoom.value = z;
  if (state.hwZoom && state.stream){
    try { state.stream.getVideoTracks()[0].applyConstraints({ advanced:[{ zoom:z }] }); } catch {}
  }
  syncLensChips();
  applyFx();
}

// Pixel-style lens chips — built from the device's real zoom range, never faked.
function buildLensChips(){
  const {min,max} = state.zoomCaps;
  const wanted = [0.6,1,2,5,10];
  const stops = wanted.filter(z => z>=min-0.001 && z<=max+0.001);
  if (!stops.includes(1) && min<=1 && max>=1) stops.unshift(1);
  if (!stops.length) stops.push(1);
  els.lensChips.innerHTML = '';
  stops.forEach(z=>{
    const b=document.createElement('button');
    b.className='lens-chip'; b.dataset.z=z;
    b.textContent = (z===1?'1×':(z<1?z+'×':z+'×'));
    b.addEventListener('click',()=>setZoom(z));
    els.lensChips.appendChild(b);
  });
  els.lensChips.style.display = stops.length>1 ? 'flex' : 'none';
  syncLensChips();
}
function syncLensChips(){
  const chips=[...els.lensChips.querySelectorAll('.lens-chip')];
  if(!chips.length) return;
  let best=chips[0], bestd=Infinity;
  chips.forEach(c=>{ const d=Math.abs(parseFloat(c.dataset.z)-state.fx.zoom); if(d<bestd){bestd=d;best=c;} });
  chips.forEach(c=>c.classList.toggle('active', c===best));
}

// Hard cap so a forgotten recording can't blow past the upload body limit.
const MAX_REC_MS = 5 * 60 * 1000;
const canRecord = typeof MediaRecorder !== 'undefined';
function pickVideoMime(){
  // WebM first: it's a streaming container that's always a valid file even when
  // recorded in chunks. Chrome's MP4 muxer produces a fragmented file with no
  // moov atom that won't play standalone — the server transcodes everything to
  // a clean MP4 anyway. MP4 stays last for Safari/iOS, where its output IS valid.
  const cands = ['video/webm;codecs=vp9,opus','video/webm;codecs=vp8,opus','video/webm','video/mp4'];
  return canRecord ? (cands.find(t=>{ try { return MediaRecorder.isTypeSupported(t); } catch { return false; } }) || '') : '';
}

// ---------------------------------------------------------------------------
// boot
// ---------------------------------------------------------------------------
async function boot(){
  // a short, quiet splash: the flame, then the app
  const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
  await sleep(reduce ? 0 : 420);
  els.boot.classList.add('gone');
  setTimeout(()=>els.boot.remove(), 700);
}

// ---------------------------------------------------------------------------
// views: camera, library, favorites. Phones use the tab bar, desktop the
// sidebar. Each switch is a history entry so the back button stays in-app.
// ---------------------------------------------------------------------------
const VIEWS = ['camera','library','fav'];
function setView(v, push){
  if (!VIEWS.includes(v)) v = 'library';
  if (state.recording && v !== 'camera'){ toast('Stop recording first', true); return; }
  const prev = document.body.dataset.view;
  document.body.dataset.view = v;
  document.querySelectorAll('[data-go]').forEach(b => {
    const on = b.dataset.go === v;
    b.classList.toggle('is-active', on);
    if (on) b.setAttribute('aria-current','page'); else b.removeAttribute('aria-current');
  });
  if (v === 'camera'){
    if (!state.stream) startCamera();
  } else {
    // the camera only runs while you are looking at it: saves battery and the light
    if (state.stream) stopCamera();
    const tab = v === 'fav' ? 'fav' : 'all';
    if (tab !== state.tab){ state.tab = tab; syncTabs(); renderGallery(); }   // favorites filter the loaded list, no refetch
    else syncTabs();
  }
  if (push && prev !== v) history.pushState({ view: v }, '', '#' + v);
}
function syncTabs(){
  els.tabs.forEach(t => { const on = t.dataset.tab === state.tab; t.classList.toggle('active', on); t.setAttribute('aria-pressed', String(on)); });
  const title = document.getElementById('libTitle'); if (title) title.textContent = state.tab === 'fav' ? 'Favorites' : 'Library';
}
window.addEventListener('popstate', e => setView((e.state && e.state.view) || location.hash.slice(1) || defaultView(), false));
const defaultView = () => matchMedia('(min-width: 1024px)').matches ? 'library' : 'camera';

// ---------------------------------------------------------------------------
// camera
// ---------------------------------------------------------------------------
async function startCamera(){
  stopCamera();
  els.fallback.hidden = true;
  try {
    // Video mode pulls a mic track too, so clips have sound.
    const constraints = { audio: state.mode==='video', video:{ facingMode:{ ideal: state.facing }, width:{ ideal:2560 }, height:{ ideal:1920 } } };
    const stream = await navigator.mediaDevices.getUserMedia(constraints);
    state.stream = stream;
    els.video.srcObject = stream;
    await els.video.play().catch(()=>{});
    els.vpBadge.textContent = 'Live';
    els.vpBadge.classList.add('live');
    els.btnShutter.disabled = false;
    // capabilities: torch + multi-camera
    const track = stream.getVideoTracks()[0];
    const caps = track.getCapabilities ? track.getCapabilities() : {};
    els.btnTorch.hidden = !('torch' in caps);
    // hardware zoom when the device exposes it, else digital zoom (1–5×)
    if (caps && caps.zoom){ state.hwZoom = true; state.zoomCaps = { min:caps.zoom.min||1, max:caps.zoom.max||5, step:caps.zoom.step||0.1 }; }
    else { state.hwZoom = false; state.zoomCaps = { min:1, max:5, step:0.1 }; }
    els.pZoom.min = state.zoomCaps.min; els.pZoom.max = state.zoomCaps.max; els.pZoom.step = state.zoomCaps.step;
    buildLensChips();
    try { const cams = (await navigator.mediaDevices.enumerateDevices()).filter(d=>d.kind==='videoinput'); state.hasMultiCam = cams.length>1; } catch {}
    els.btnSwitch.style.display = state.hasMultiCam ? '' : 'none';
    applyFx();
  } catch (e) {
    els.vpBadge.textContent = 'Camera off';
    els.vpBadge.classList.remove('live');
    els.btnShutter.disabled = true;
    els.fallback.hidden = false;
    els.fallbackMsg.textContent = (e.name==='NotAllowedError')
      ? 'The camera is blocked. Allow it in your browser settings, then tap below.'
      : (location.protocol==='http:' && location.hostname!=='localhost')
        ? 'The camera needs a secure connection. Open Attic over https.'
        : 'No camera on this device. You can still import photos and videos.';
  }
}
function stopCamera(){
  if (state.stream){ state.stream.getTracks().forEach(t=>t.stop()); state.stream=null; }
  els.vpBadge.textContent = 'Camera off'; els.vpBadge.classList.remove('live');
}
function applyMirror(){ applyFx(); }

// ---------------------------------------------------------------------------
// capture pipeline
// ---------------------------------------------------------------------------
async function shoot(){
  if (state.busy) return;
  if (state.timer > 0){ await runCountdown(state.timer); }
  if (!state.stream){ toast('The camera is not on', true); return; }
  state.busy = true; els.btnShutter.disabled = true;

  // 1 — CAPTURE
  setStage(1);
  els.flash.classList.remove('fire'); void els.flash.offsetWidth; els.flash.classList.add('fire');

  const v = els.video;
  const w = v.videoWidth, h = v.videoHeight;
  const c = els.canvas; c.width = w; c.height = h;
  const ctx = c.getContext('2d');
  drawFrame(ctx, w, h);                    // bakes filter + zoom + mirror + vignette
  const full = c.toDataURL('image/jpeg', 0.92);
  const thumb = makeThumb(c);

  // optional geotag
  if (state.geoOn && state.geo){ /* already captured */ }

  await sleep(160);

  // 2 — UPLOAD
  setStage(2);
  let rec;
  try {
    const body = { full, thumb, w, h, facing:state.facing, device:state.deviceLabel,
      lat: state.geoOn && state.geo ? state.geo.lat : undefined,
      lon: state.geoOn && state.geo ? state.geo.lon : undefined };
    const r = await fetch('/api/upload', { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(body) });
    if (!r.ok) throw new Error('upload '+r.status);
    rec = (await r.json()).photo;
  } catch (e) {
    toast('Could not save that shot. '+e.message, true);
    resetPipeline(); state.busy=false; els.btnShutter.disabled=false; return;
  }

  // 3 — PC SAVE (the server has written to the desktop by now)
  setStage(3); await sleep(220);
  // 4 — CLOUD ARCHIVE
  setStage(4); await sleep(260);

  toast(rec.archived ? 'Saved to your Camera Roll and the vault' : 'Saved to your Camera Roll');
  state.photos.unshift(rec);
  renderGallery(true);
  refreshStats();
  setTimeout(resetPipeline, 900);
  state.busy = false; els.btnShutter.disabled = false;
}

function makeThumb(srcCanvas){
  const max = 420;
  const r = Math.min(max/srcCanvas.width, max/srcCanvas.height, 1);
  const tw = Math.round(srcCanvas.width*r), th = Math.round(srcCanvas.height*r);
  const t = document.createElement('canvas'); t.width=tw; t.height=th;
  t.getContext('2d').drawImage(srcCanvas, 0, 0, tw, th);
  return t.toDataURL('image/jpeg', 0.72);
}

// grab the current live frame as a poster JPEG (used as the video thumbnail)
function grabPoster(){
  const v = els.video, w = v.videoWidth||1280, h = v.videoHeight||720;
  const c = els.canvas; c.width = w; c.height = h;
  drawFrame(c.getContext('2d'), w, h);
  return { full:c.toDataURL('image/jpeg',0.85), thumb:makeThumb(c), w, h };
}

// ---------------------------------------------------------------------------
// video — record the live stream, then ride the same upload pipeline
// ---------------------------------------------------------------------------
function setMode(m){
  if (state.recording) return;            // can't switch mid-record
  if (m==='video' && !canRecord){ toast('This browser cannot record video',true); return; }
  if (m===state.mode){ return; }
  state.mode = m;
  els.modes.forEach(b=>{ b.classList.toggle('active', b.dataset.mode===m); b.setAttribute('aria-pressed', String(b.dataset.mode===m)); });
  els.btnShutter.classList.toggle('video', m==='video');
  els.btnShutter.setAttribute('aria-label', m==='video'?'Record video':'Take photo');
  els.filePick.setAttribute('accept', m==='video' ? 'video/*' : 'image/*');
  startCamera();                          // re-acquire with/without the mic
}

function fmtDur(s){ s=Math.max(0,Math.round(s)); const m=Math.floor(s/60); return m+':'+String(s%60).padStart(2,'0'); }

function startRecording(){
  if (!state.stream){ toast('The camera is not on', true); return; }
  const mime = pickVideoMime();
  // When effects are on, record a canvas that draws filtered/zoomed frames so
  // the clip matches the preview. Otherwise record the raw stream (lighter).
  let source = state.stream; state.fxCanvasStop = null;
  if (fxActive()){
    try {
      const v = els.video, w = v.videoWidth||1280, h = v.videoHeight||720;
      const cc = document.createElement('canvas'); cc.width = w; cc.height = h;
      const cx = cc.getContext('2d');
      let raf; const loop = ()=>{ drawFrame(cx, w, h); raf = requestAnimationFrame(loop); }; loop();
      const cstream = cc.captureStream(30);
      state.stream.getAudioTracks().forEach(t=>cstream.addTrack(t));
      source = cstream; state.fxCanvasStop = ()=>cancelAnimationFrame(raf);
    } catch (e){ source = state.stream; state.fxCanvasStop = null; }
  }
  let rec;
  try { rec = new MediaRecorder(source, mime ? { mimeType:mime } : undefined); }
  catch (e){ if (state.fxCanvasStop) state.fxCanvasStop(); toast('Could not start recording. '+e.message, true); return; }
  state.recorder = rec; state.chunks = []; state.recMime = rec.mimeType || mime || 'video/webm';
  state.poster = grabPoster();
  rec.ondataavailable = e => { if (e.data && e.data.size) state.chunks.push(e.data); };
  rec.onstop = () => finishVideo();
  rec.start();
  state.recording = true; state.recStart = Date.now();
  els.btnShutter.classList.add('recording');
  els.recBadge.hidden = false; els.recTime.textContent = '0:00';
  setStage(1);
  state.recTimer = setInterval(()=>{
    const ms = Date.now()-state.recStart;
    els.recTime.textContent = fmtDur(ms/1000);
    if (ms >= MAX_REC_MS){ toast('Clips stop at 5 minutes'); stopRecording(); }
  }, 250);
}

function stopRecording(){
  if (!state.recording || !state.recorder) return;
  clearInterval(state.recTimer); state.recTimer=null;
  els.recBadge.hidden = true;
  els.btnShutter.classList.remove('recording');
  try { state.recorder.stop(); } catch {}
  if (state.fxCanvasStop){ try { state.fxCanvasStop(); } catch {} state.fxCanvasStop = null; }
  state.recording = false;
}

async function finishVideo(){
  const durSec = (Date.now()-state.recStart)/1000;
  const blob = new Blob(state.chunks, { type: state.recMime });
  state.chunks = [];
  if (!blob.size){ toast('Nothing was recorded', true); resetPipeline(); return; }
  state.busy = true; els.btnShutter.disabled = true;

  // 2 — UPLOAD
  setStage(2);
  let rec;
  try {
    const video = await blobToDataURL(blob);
    const p = state.poster || {};
    const body = { kind:'video', video, thumb:p.thumb, mime:state.recMime,
      w:p.w|0, h:p.h|0, dur:durSec, facing:state.facing, device:state.deviceLabel,
      lat: state.geoOn && state.geo ? state.geo.lat : undefined,
      lon: state.geoOn && state.geo ? state.geo.lon : undefined };
    const r = await fetch('/api/upload', { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(body) });
    if (!r.ok) throw new Error('upload '+r.status);
    rec = (await r.json()).photo;
  } catch (e) {
    toast('Could not save that clip. '+e.message, true);
    resetPipeline(); state.busy=false; els.btnShutter.disabled=false; return;
  }

  setStage(3); await sleep(220);
  setStage(4); await sleep(260);
  toast(rec.archived ? 'Clip saved to your Camera Roll and the vault' : 'Clip saved to your Camera Roll');
  state.photos.unshift(rec);
  renderGallery(true); refreshStats();
  setTimeout(resetPipeline, 900);
  state.busy = false; els.btnShutter.disabled = false;
}

function blobToDataURL(blob){ return new Promise((res,rej)=>{ const fr=new FileReader(); fr.onload=()=>res(fr.result); fr.onerror=rej; fr.readAsDataURL(blob); }); }

// shutter button routes by mode
function primaryAction(){
  if (state.mode==='video'){ state.recording ? stopRecording() : startRecording(); }
  else shoot();
}

function setStage(n){
  const steps = $$('.pipeline .step');
  els.pipeline.className = 'pipeline s'+n;
  steps.forEach((s,i)=>{
    s.classList.remove('active','done');
    if (i < n-1) s.classList.add('done');
    else if (i === n-1) s.classList.add('active');
  });
  // when we hit the last stage, mark it done too
  if (n>=4){ steps[3].classList.remove('active'); steps[3].classList.add('done'); }
}
function resetPipeline(){ els.pipeline.className='pipeline'; $$('.pipeline .step').forEach(s=>s.classList.remove('active','done')); }

async function runCountdown(secs){
  els.countdown.hidden=false;
  for (let s=secs;s>0;s--){ els.countdown.textContent=s; await sleep(1000); }
  els.countdown.hidden=true;
}

// import from device
function importFile(file){
  if (file.type && file.type.startsWith('video/')) return importVideo(file);
  const fr = new FileReader();
  fr.onload = async () => {
    const img = new Image();
    img.onload = async () => {
      const c=els.canvas; c.width=img.naturalWidth; c.height=img.naturalHeight;
      c.getContext('2d').drawImage(img,0,0);
      const full=c.toDataURL('image/jpeg',0.92), thumb=makeThumb(c);
      setStage(2);
      try{
        const r=await fetch('/api/upload',{method:'POST',headers:{'Content-Type':'application/json'},
          body:JSON.stringify({ full, thumb, w:c.width, h:c.height, device:state.deviceLabel+' (import)' })});
        const rec=(await r.json()).photo;
        setStage(4); await sleep(300);
        toast('Imported into your Camera Roll and the vault');
        state.photos.unshift(rec); renderGallery(true); refreshStats();
      }catch(e){ toast('Could not import that file',true); }
      setTimeout(resetPipeline,900);
    };
    img.src=fr.result;
  };
  fr.readAsDataURL(file);
}

// import a video file: probe it for dimensions + a poster frame, then upload.
async function importVideo(file){
  setStage(2);
  try {
    const video = await blobToDataURL(file);
    const probe = document.createElement('video');
    probe.muted = true; probe.src = video;
    const meta = await new Promise((res)=>{
      probe.onloadeddata = ()=>{ probe.currentTime = Math.min(0.1, probe.duration||0); };
      probe.onseeked = ()=>res({ w:probe.videoWidth, h:probe.videoHeight, dur:probe.duration||0 });
      probe.onerror = ()=>res({ w:0, h:0, dur:0 });
      setTimeout(()=>res({ w:probe.videoWidth, h:probe.videoHeight, dur:probe.duration||0 }), 4000);
    });
    let thumb;
    try { const c=els.canvas; c.width=meta.w||1280; c.height=meta.h||720; c.getContext('2d').drawImage(probe,0,0,c.width,c.height); thumb=makeThumb(c); } catch {}
    const mime = file.type || 'video/mp4';
    const body = { kind:'video', video, thumb, mime, w:meta.w|0, h:meta.h|0, dur:meta.dur, device:state.deviceLabel+' (import)' };
    const r = await fetch('/api/upload',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
    const rec = (await r.json()).photo;
    setStage(4); await sleep(300);
    toast('Clip imported into your Camera Roll and the vault');
    state.photos.unshift(rec); renderGallery(true); refreshStats();
  } catch(e){ toast('Could not import that video',true); }
  setTimeout(resetPipeline,900);
}

// ---------------------------------------------------------------------------
// gallery
// ---------------------------------------------------------------------------
async function loadPhotos(){
  if (!state.photos.length){ els.gallery.innerHTML = Array.from({length:12}, () => '<div class="s-skel s-skel--tile"></div>').join(''); els.galleryEmpty.hidden = true; }
  els.gallery.setAttribute('aria-busy','true');
  try{
    // always load everything; Favorites is a client side filter over this list
    const r=await fetch('/api/photos?limit=300');
    state.photos=(await r.json()).photos||[];
  }catch{ state.photos=[]; }
  els.gallery.removeAttribute('aria-busy');
  renderGallery();
}

function dayLabel(ts){
  const d=new Date(ts), today=new Date(); today.setHours(0,0,0,0);
  const y=new Date(today); y.setDate(y.getDate()-1);
  if (d>=today) return 'Today';
  if (d>=y) return 'Yesterday';
  return d.toLocaleDateString(undefined,{weekday:'short',month:'short',day:'numeric'});
}
function timeLabel(ts){ return new Date(ts).toLocaleTimeString(undefined,{hour:'2-digit',minute:'2-digit'}); }

function renderEmpty(){
  const fav = state.tab==='fav';
  els.galleryEmpty.innerHTML = fav
    ? `<div class="s-empty"><div class="s-empty__icon">${IC('star')}</div><h2 class="s-empty__title">No favorites yet</h2>
        <p class="s-empty__text">Open any photo and tap the star. Your favorites gather here.</p>
        <div class="s-empty__actions"><button class="s-btn" data-go="library">${IC('images')}See all photos</button></div></div>`
    : `<div class="s-empty"><div class="s-empty__icon">${IC('images')}</div><h2 class="s-empty__title">Your attic is empty</h2>
        <p class="s-empty__text">Every photo and video you take here is saved straight into a plain folder on your computer, then tucked into your private vault. Nothing goes to anyone's cloud.</p>
        <div class="s-empty__actions"><button class="s-btn s-btn--primary" data-go="camera">${IC('camera')}Open the camera</button><button class="s-btn" data-empty-import>${IC('import')}Import a photo</button></div></div>`;
}
function renderGallery(freshTop=false){
  const list = state.tab==='fav' ? state.photos.filter(p=>p.fav) : state.photos;
  els.galleryEmpty.hidden = list.length>0;
  if (!list.length) renderEmpty();
  els.gallery.innerHTML='';
  // count per day so each header can say how many shots it holds
  const perDay = {}; list.forEach(p => { const k = dayLabel(p.ts); perDay[k] = (perDay[k]||0) + 1; });
  let lastDay='';
  list.forEach((p,idx)=>{
    const dl=dayLabel(p.ts);
    if (dl!==lastDay){ lastDay=dl; const h=document.createElement('h2'); h.className='day-head'; h.innerHTML=`${esc(dl)} <span class="n">${perDay[dl]} ${perDay[dl]===1?'item':'items'}</span>`; els.gallery.appendChild(h); }
    const isVid = p.kind==='video';
    const cell=document.createElement('div'); cell.className='cell'+(isVid?' video':'')+(freshTop&&idx===0?' fresh':'');
    cell.tabIndex = 0; cell.setAttribute('role','button'); cell.dataset.id = p.id;
    cell.setAttribute('aria-label', `${isVid?'Video':'Photo'}, ${dl}, ${timeLabel(p.ts)}${p.fav?', favorite':''}`);
    cell.innerHTML=`<img loading="lazy" src="${p.thumb}" alt="">
      ${isVid?`<div class="play">${IC('play')}</div><div class="dur">${fmtDur(p.dur||0)}</div>`:''}
      <div class="tag">${p.fav?`<span class="fav">${IC('star-fill')}</span>`:''}</div>
      <div class="time">${timeLabel(p.ts)}</div>`;
    const img=cell.querySelector('img');
    img.addEventListener('load',()=>img.classList.add('loaded'));
    if (img.complete) img.classList.add('loaded');
    cell.addEventListener('click',()=>openLightbox(p.id, cell));
    cell.addEventListener('keydown',e=>{ if(e.key==='Enter'||e.key===' '){ e.preventDefault(); openLightbox(p.id, cell); } });
    els.gallery.appendChild(cell);
  });
}

// ---------------------------------------------------------------------------
// lightbox
// ---------------------------------------------------------------------------
function visibleList(){ return state.tab==='fav'?state.photos.filter(p=>p.fav):state.photos; }
let lbReturn = null;
function openLightbox(id, from){
  const list=visibleList(); const i=list.findIndex(p=>p.id===id); if(i<0)return;
  state.lbIndex=i; showLb();
  lbReturn = from || document.activeElement;
  els.lightbox.hidden=false;
  setTimeout(()=>{ try{ els.lbClose.focus({preventScroll:true}); }catch{} }, 30);
}
function showLb(){
  const list=visibleList(); const p=list[state.lbIndex]; if(!p)return;
  const isVid = p.kind==='video';
  els.lbVid.pause();
  if (isVid){
    els.lbImg.hidden=true; els.lbImg.removeAttribute('src');
    els.lbVid.hidden=false; els.lbVid.src=p.url; els.lbVid.poster=p.thumb;
  } else {
    els.lbVid.hidden=true; els.lbVid.removeAttribute('src');
    els.lbImg.hidden=false; els.lbImg.src=p.url;
  }
  els.lbDownload.href=p.download;
  els.lbFav.classList.toggle('on',p.fav);
  els.lbFav.setAttribute('aria-pressed', String(!!p.fav));
  els.lbFav.innerHTML = IC(p.fav?'star-fill':'star') + `<span>${p.fav?'Favorite':'Add to favorites'}</span>`;
  els.lbImg.alt = `${isVid?'Video':'Photo'} from ${new Date(p.ts).toLocaleString()}`;
  const bits = [];
  if (p.w&&p.h) bits.push(`${p.w} × ${p.h}`);
  if (p.bytes) bits.push(`${(p.bytes/1048576).toFixed(1)} MB`);
  if (isVid&&p.dur) bits.push(fmtDur(p.dur));
  if (p.archived) bits.push('in the vault');
  if (p.lat!=null&&p.lon!=null) bits.push(`${p.lat.toFixed(3)}, ${p.lon.toFixed(3)}`);
  const when = new Date(p.ts);
  els.lbMeta.innerHTML = `<b>${esc(when.toLocaleDateString(undefined,{weekday:'long',month:'long',day:'numeric'}))} · ${esc(timeLabel(p.ts))}</b>${esc(bits.join(' · '))}`;
}
function closeLb(){
  els.lightbox.hidden=true; els.lbImg.removeAttribute('src'); try{ els.lbVid.pause(); }catch{} els.lbVid.removeAttribute('src');
  // the gallery may have re-rendered (favorite toggled), so find the cell again by id
  const cur = visibleList()[state.lbIndex];
  if (lbReturn && !lbReturn.isConnected && cur) lbReturn = els.gallery.querySelector(`.cell[data-id="${cur.id}"]`);
  if (lbReturn && lbReturn.focus) try{ lbReturn.focus({preventScroll:true}); }catch{}
  lbReturn = null;
}
function lbStep(d){ const list=visibleList(); state.lbIndex=(state.lbIndex+d+list.length)%list.length; showLb(); }
async function lbToggleFav(){
  const p=visibleList()[state.lbIndex]; if(!p)return;
  const r=await fetch(`/api/photo/${p.id}/fav`,{method:'POST'}); const j=await r.json();
  p.fav=j.fav; const m=state.photos.find(x=>x.id===p.id); if(m)m.fav=j.fav;
  showLb(); renderGallery();
}
async function lbDelete(){
  const p=visibleList()[state.lbIndex]; if(!p)return;
  if(!confirm('Delete this from your computer and the vault? This cannot be undone.'))return;
  await fetch(`/api/photo/${p.id}`,{method:'DELETE'});
  state.photos=state.photos.filter(x=>x.id!==p.id);
  lbReturn = null;
  toast('Deleted'); closeLb(); renderGallery(); refreshStats();
}

// ---------------------------------------------------------------------------
// stats + clock
// ---------------------------------------------------------------------------
async function refreshStats(){
  try{
    const s=await (await fetch('/api/stats')).json();
    els.pStats.textContent=`${s.total} shots`;
    const mb=(s.bytes/1048576);
    const size = mb >= 1024 ? (mb/1024).toFixed(1)+' GB' : Math.max(0, Math.round(mb))+' MB';
    const where = s.cloud === 'local vault' ? 'private vault on this computer' : 'vault plus your off site backup';
    els.gStats.textContent = s.total ? `${s.total} ${s.total===1?'item':'items'} · ${s.today} today · ${size}` : '';
    const side = document.getElementById('sideStats');
    if (side) side.textContent = s.total ? `${s.total} ${s.total===1?'photo':'photos'}, ${size}` : 'Nothing here yet';
    if (side && side.nextElementSibling && s.total) side.nextElementSibling.lastChild.textContent = s.archived===s.total ? `Everything is saved in your ${where}.` : `${s.archived} of ${s.total} saved in your ${where}.`;
  }catch{}
}
function tickClock(){ const d=new Date(); els.pClock.textContent=d.toLocaleTimeString(undefined,{hour12:false}); }

// ---------------------------------------------------------------------------
// misc
// ---------------------------------------------------------------------------
let toastT;
function toast(msg, err=false){ els.toast.textContent=msg; els.toast.className='toast show'+(err?' err':''); clearTimeout(toastT); toastT=setTimeout(()=>els.toast.className='toast',2600); }
const sleep=ms=>new Promise(r=>setTimeout(r,ms));

function captureGeo(){
  if(!navigator.geolocation){ toast('This device cannot share its location',true); state.geoOn=false; els.btnGeo.classList.remove('on'); return; }
  navigator.geolocation.getCurrentPosition(
    pos=>{ state.geo={lat:pos.coords.latitude,lon:pos.coords.longitude}; toast('New shots will carry their location'); },
    ()=>{ toast('Location was not allowed',true); state.geoOn=false; els.btnGeo.classList.remove('on'); },
    {enableHighAccuracy:true,timeout:8000});
}

// ---------------------------------------------------------------------------
// filters + pro controls UI
// ---------------------------------------------------------------------------
function buildFxStrip(){
  els.fxStrip.innerHTML = PRESETS.map(p=>
    `<button class="fx-chip${p.key===state.fx.preset?' active':''}" data-key="${p.key}">
       <span class="fx-thumb" style="filter:${p.f||'none'}"></span>
       <span class="fx-name">${p.name}</span>
     </button>`).join('');
  els.fxStrip.querySelectorAll('.fx-chip').forEach(ch=>ch.addEventListener('click',()=>selectPreset(ch.dataset.key)));
  refreshFxThumbs();
}
function refreshFxThumbs(){
  try{
    const v=els.video, tw=150, th=Math.round(tw*(v.videoHeight||4)/(v.videoWidth||3))||112;
    const c=document.createElement('canvas'); c.width=tw; c.height=th;
    const cx=c.getContext('2d');
    if(state.mirror){ cx.translate(tw,0); cx.scale(-1,1); }
    cx.drawImage(v,0,0,tw,th);
    state.fxSnap=c.toDataURL('image/jpeg',0.6);
  }catch{ state.fxSnap=null; }
  if(state.fxSnap) els.fxStrip.querySelectorAll('.fx-thumb').forEach(t=>t.style.backgroundImage=`url(${state.fxSnap})`);
}
function selectPreset(key){
  state.fx.preset=key;
  els.fxStrip.querySelectorAll('.fx-chip').forEach(ch=>ch.classList.toggle('active',ch.dataset.key===key));
  applyFx();
}
function toggleFx(){
  if(els.fxStrip.hidden){ buildFxStrip(); els.fxStrip.hidden=false; els.btnFx.classList.add('on'); }
  else { els.fxStrip.hidden=true; els.btnFx.classList.remove('on'); }
}
function togglePro(){
  const open = els.proPanel.hidden;
  els.proPanel.hidden = !open;
  els.btnPro.classList.toggle('on', open);
}
function signed(n){ n=Math.round(n); return (n>0?'+':'')+n; }
function resetFx(){
  state.fx={ preset:'none', brightness:1, contrast:1, saturate:1, warmth:0, vignette:0, zoom:1 };
  els.pZoom.value=1; els.pBright.value=1; els.pContrast.value=1; els.pSat.value=1; els.pWarmth.value=0; els.pVig.value=0;
  els.vBright.textContent='0'; els.vContrast.textContent='0'; els.vSat.textContent='0'; els.vWarmth.textContent='0'; els.vVig.textContent='0';
  if(!els.fxStrip.hidden) els.fxStrip.querySelectorAll('.fx-chip').forEach(ch=>ch.classList.toggle('active',ch.dataset.key==='none'));
  applyFx(); toast('Back to normal');
}
function wireProControls(){
  els.pBright.addEventListener('input',()=>{ state.fx.brightness=+els.pBright.value; els.vBright.textContent=signed((els.pBright.value-1)*100); applyFx(); });
  els.pContrast.addEventListener('input',()=>{ state.fx.contrast=+els.pContrast.value; els.vContrast.textContent=signed((els.pContrast.value-1)*100); applyFx(); });
  els.pSat.addEventListener('input',()=>{ state.fx.saturate=+els.pSat.value; els.vSat.textContent=signed((els.pSat.value-1)*100); applyFx(); });
  els.pWarmth.addEventListener('input',()=>{ state.fx.warmth=+els.pWarmth.value; els.vWarmth.textContent=signed(els.pWarmth.value*100); applyFx(); });
  els.pVig.addEventListener('input',()=>{ state.fx.vignette=+els.pVig.value; els.vVig.textContent=Math.round(els.pVig.value*100); applyFx(); });
  els.pZoom.addEventListener('input',()=>setZoom(+els.pZoom.value));
  els.pReset.addEventListener('click',resetFx);
}
// Canon-style mode dial: each turn snaps to the next shooting mode.
const WHEEL = [
  { label:'AUTO',  apply:()=>{ setMode('photo'); selectPreset('none'); } },
  { label:'VIVID', apply:()=>{ setMode('photo'); selectPreset('vivid'); } },
  { label:'MONO',  apply:()=>{ setMode('photo'); selectPreset('noir'); } },
  { label:'PRO',   apply:()=>{ setMode('photo'); if(els.proPanel.hidden) togglePro(); } },
  { label:'VID',   apply:()=>{ setMode('video'); } },
];
let wheelIdx=0, wheelTurns=0;
function turnWheel(dir=1){
  wheelIdx=(wheelIdx+dir+WHEEL.length)%WHEEL.length;
  wheelTurns+=dir;
  const m=WHEEL[wheelIdx];
  els.wheelKnurl.style.transform=`rotate(${wheelTurns*(360/WHEEL.length)}deg)`;
  els.wheelMode.textContent=m.label;
  m.apply();
  toast('Mode: '+m.label);
}

function touchDist(e){ const a=e.touches[0],b=e.touches[1]; return Math.hypot(a.clientX-b.clientX,a.clientY-b.clientY); }
function wireZoomGestures(){
  const vp=els.viewport; let startDist=0, startZoom=1;
  vp.addEventListener('touchstart',e=>{ if(e.touches.length===2){ startDist=touchDist(e); startZoom=state.fx.zoom; } },{passive:true});
  vp.addEventListener('touchmove',e=>{ if(e.touches.length===2 && startDist){ e.preventDefault(); setZoom(startZoom*(touchDist(e)/startDist)); } },{passive:false});
  vp.addEventListener('dblclick',()=>setZoom(state.fx.zoom>1.05?1:2));
  vp.addEventListener('wheel',e=>{ e.preventDefault(); setZoom(state.fx.zoom+(e.deltaY<0?0.2:-0.2)); },{passive:false});
}

// Pixel-style horizon level — real device tilt via the orientation sensor.
let _levelBound=false;
function onTilt(e){
  if(!state.levelOn) return;
  // gamma = left/right tilt in degrees; clamp for display
  let g = e.gamma||0;
  g = Math.max(-45,Math.min(45,g));
  els.levelLive.style.transform = `translate(-50%,-50%) rotate(${ -g }deg)`;
  els.levelDeg.textContent = Math.round(Math.abs(g))+'°';
  els.level.classList.toggle('flat', Math.abs(g)<=1.5);
}
async function toggleLevel(){
  state.levelOn = !state.levelOn;
  els.btnLevel.classList.toggle('on',state.levelOn);
  els.level.hidden = !state.levelOn;
  if(state.levelOn){
    // iOS needs an explicit permission grant on a user gesture
    try{
      if(typeof DeviceOrientationEvent!=='undefined' && DeviceOrientationEvent.requestPermission){
        const p=await DeviceOrientationEvent.requestPermission();
        if(p!=='granted'){ toast('Motion sensors were not allowed',true); }
      }
    }catch{}
    if(!_levelBound){ window.addEventListener('deviceorientation',onTilt); _levelBound=true; }
  }
}

// ---------------------------------------------------------------------------
// wire up
// ---------------------------------------------------------------------------
function wire(){
  els.btnShutter.addEventListener('click',primaryAction);
  els.modes.forEach(b=>b.addEventListener('click',()=>setMode(b.dataset.mode)));
  if (!canRecord) els.modeSwitch.style.display='none';   // hide video mode on unsupported browsers
  els.btnGrant.addEventListener('click',startCamera);
  els.btnSwitch.addEventListener('click',()=>{ if(state.recording){ toast('Stop recording to switch cameras',true); return; } state.facing = state.facing==='environment'?'user':'environment'; startCamera(); });
  els.btnUpload.addEventListener('click',()=>els.filePick.click());
  els.filePick.addEventListener('change',e=>{ if(e.target.files[0]) importFile(e.target.files[0]); e.target.value=''; });

  els.btnGrid.addEventListener('click',()=>{ state.grid=!state.grid; els.gridOverlay.classList.toggle('on',state.grid); els.btnGrid.classList.toggle('on',state.grid); });
  els.btnLevel.addEventListener('click',toggleLevel);
  els.btnMirror.addEventListener('click',()=>{ state.mirror=!state.mirror; applyMirror(); els.btnMirror.classList.toggle('on',state.mirror); });
  els.btnTimer.addEventListener('click',()=>{ state.timer = state.timer===0?3:state.timer===3?10:0; els.timerLbl.textContent=state.timer+'s'; els.btnTimer.classList.toggle('on',state.timer>0); });
  els.btnTorch.addEventListener('click',async()=>{
    if(!state.stream)return; const track=state.stream.getVideoTracks()[0];
    try{ state.torch=!state.torch; await track.applyConstraints({advanced:[{torch:state.torch}]}); els.btnTorch.classList.toggle('on',state.torch);}catch{ toast('Torch not supported',true); }
  });
  els.btnGeo.addEventListener('click',()=>{ state.geoOn=!state.geoOn; els.btnGeo.classList.toggle('on',state.geoOn); if(state.geoOn)captureGeo(); else state.geo=null; });
  els.btnFx.addEventListener('click',toggleFx);
  els.btnPro.addEventListener('click',togglePro);
  // the Canon-style mode dial was already hidden (display:none) before this redesign and is no longer in the markup
  if (els.modeWheel){
    els.modeWheel.addEventListener('click',()=>turnWheel(1));
    els.modeWheel.addEventListener('wheel',e=>{ e.preventDefault(); turnWheel(e.deltaY>0?1:-1); },{passive:false});
  }
  wireProControls();
  wireZoomGestures();

  document.querySelectorAll('[data-action=reveal]').forEach(b=>b.addEventListener('click',async()=>{ await fetch('/api/reveal',{method:'POST'}); toast('Opened the Camera Roll folder on the PC'); }));
  document.querySelectorAll('[data-action=logout]').forEach(b=>b.addEventListener('click',async()=>{ await fetch('/api/logout',{method:'POST'}); location.reload(); }));

  els.tabs.forEach(t=>t.addEventListener('click',()=>setView(t.dataset.tab==='fav'?'fav':'library', true)));
  // any [data-go] (tab bar, sidebar, empty state buttons) switches the view
  document.addEventListener('click',e=>{
    const g=e.target.closest('[data-go]'); if(g){ setView(g.dataset.go, true); return; }
    if(e.target.closest('[data-empty-import]')) els.filePick.click();
  });

  els.lbClose.addEventListener('click',closeLb);
  els.lbPrev.addEventListener('click',()=>lbStep(-1));
  els.lbNext.addEventListener('click',()=>lbStep(1));
  els.lbFav.addEventListener('click',lbToggleFav);
  els.lbDelete.addEventListener('click',lbDelete);
  els.lightbox.addEventListener('click',e=>{ if(e.target===els.lightbox)closeLb(); });
  document.addEventListener('keydown',e=>{
    if(els.lightbox.hidden)return;
    if(e.key==='Escape')closeLb(); if(e.key==='ArrowLeft')lbStep(-1); if(e.key==='ArrowRight')lbStep(1);
    if(e.key==='Tab'){ // keep focus inside the lightbox
      const f=[...els.lightbox.querySelectorAll('button,a[href],video[controls]')].filter(n=>n.offsetParent!==null);
      if(!f.length) return; const a=f[0], z=f[f.length-1];
      if(e.shiftKey && document.activeElement===a){ e.preventDefault(); z.focus(); }
      else if(!e.shiftKey && document.activeElement===z){ e.preventDefault(); a.focus(); }
    }
  });
  // shutter via spacebar on desktop
  document.addEventListener('keydown',e=>{
    if(e.code!=='Space' || !els.lightbox.hidden || document.body.dataset.view!=='camera') return;
    const t=document.activeElement; if(t && (t.tagName==='INPUT' || t.tagName==='BUTTON' || t.getAttribute('role')==='button')) return;
    e.preventDefault(); primaryAction();
  });
}

// ---------------------------------------------------------------------------
(async function main(){
  wire();
  boot();
  tickClock(); setInterval(tickClock,1000);
  const first = VIEWS.includes(location.hash.slice(1)) ? location.hash.slice(1) : defaultView();
  history.replaceState({ view: first }, '', '#' + first);
  setView(first, false);
  await loadPhotos();
  refreshStats(); setInterval(refreshStats,15000);
})();
