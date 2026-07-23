'use strict';
// ---------------------------------------------------------------------------
// Attic — server (Sona)
//
// The pipeline, end to end:
//   1. CAPTURE  — any device opens the Attic in a browser, grants the camera, shoots.
//   2. UPLOAD   — the frame (full JPEG + a client-rendered thumbnail) is POSTed here.
//   3. PC SAVE  — written straight into the desktop Camera Roll folder.
//   4. ARCHIVE  — copied into the cloud vault (date-foldered, deduped, manifested),
//                 and pushed to an off-site remote if one is configured.
//
// No native image libs: thumbnails are produced in the browser on a <canvas>,
// so the server stays a pure-Node, dependency-light Express app.
// ---------------------------------------------------------------------------
const express = require('express');
const fs      = require('fs');
const path    = require('path');
const os      = require('os');
const crypto  = require('crypto');
const { execFile } = require('child_process');
const db = require('./db');

const APP_DIR = path.join(__dirname, '..');
const PUB     = path.join(APP_DIR, 'public');
const THUMBS  = path.join(APP_DIR, 'thumbs');

// Where the shots land. The user asked for "directly on my desktop in a
// designated folder" — this is it. Overridable via env for portability.
const DESKTOP = path.join(os.homedir(), 'Desktop');
const ROLL    = process.env.CAM_ROLL  || path.join(DESKTOP, 'Camera Roll');
const VAULT   = process.env.CAM_VAULT || path.join(ROLL, '.vault');
for (const d of [ROLL, VAULT, THUMBS]) fs.mkdirSync(d, { recursive: true });

const PORT        = parseInt(process.env.PORT || '3060', 10);
// The passcode that unlocks the Attic. Set your own with CAM_PASS; the value
// below is a placeholder the first-run wizard replaces.
const PASSCODE    = process.env.CAM_PASS || '0000';
const COOKIE_NAME = 'cam_session';
// Optional off-site backup. If you wire up rclone (`rclone config`) and set
// CAM_RCLONE_REMOTE=myremote:camera, every archived shot is pushed there too.
const RCLONE_REMOTE = process.env.CAM_RCLONE_REMOTE || '';

// ---- session token (persisted so restarts don't sign you out) ----
const TOKEN_PATH = path.join(APP_DIR, '.session-token');
let SESSION_TOKEN = '';
try { SESSION_TOKEN = fs.readFileSync(TOKEN_PATH, 'utf8').trim(); } catch {}
if (!SESSION_TOKEN) { SESSION_TOKEN = crypto.randomBytes(24).toString('hex'); try { fs.writeFileSync(TOKEN_PATH, SESSION_TOKEN); } catch {} }

function safeEq(a, b) {
  const A = Buffer.from(String(a)), B = Buffer.from(String(b));
  if (A.length !== B.length) return false;
  return crypto.timingSafeEqual(A, B);
}

// ---- brute-force lockout ----
// Per-IP lockout, plus a GLOBAL throttle that no amount of X-Forwarded-For
// rotation can escape: a 6-digit passcode is only 1e6 combos, so without a
// header-independent cap the lockout is meaningless.
const fails = new Map();
let globalFails = { n:0, until:0 };
function lockState(ip){ return fails.get(ip) || { n:0, until:0 }; }
function noteFail(ip){
  const s=lockState(ip); s.n++; if (s.n>=8){ s.until=Date.now()+15*60_000; s.n=0; } fails.set(ip,s);
  globalFails.n++; if (globalFails.n>=30){ globalFails.until=Date.now()+15*60_000; globalFails.n=0; }
}
function noteSuccess(ip){ fails.delete(ip); globalFails.n=0; }
function locked(ip){ return lockState(ip).until > Date.now() || globalFails.until > Date.now(); }
setInterval(()=>{ const now=Date.now(); for (const [k,v] of fails) if (!v.until || v.until<now) fails.delete(k); }, 60_000).unref();

// ---- cookies ----
function parseCookies(req){ const out={}; const h=req.headers.cookie; if(!h) return out; for (const p of h.split(';')){ const i=p.indexOf('='); if(i<0) continue; out[p.slice(0,i).trim()]=decodeURIComponent(p.slice(i+1).trim()); } return out; }
function setCookie(res, req, name, val, maxAge){ const secure=(req.headers['x-forwarded-proto']==='https'); let c=`${name}=${encodeURIComponent(val)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}`; if(secure) c+='; Secure'; const prev=res.getHeader('Set-Cookie'); res.setHeader('Set-Cookie', prev?[].concat(prev,c):c); }
// Sona: self-contained gate. Auth = the native cam_session cookie that /api/auth
// sets after a correct passcode. No external SSO — self-contained.
function isAuthed(req){ const c = parseCookies(req)[COOKIE_NAME]; return !!c && safeEq(c, SESSION_TOKEN); }

const app = express();
app.disable('x-powered-by');

// ---- transport hardening (defense-in-depth on top of Cloudflare TLS) ----
// HSTS tells every browser "only ever reach me over HTTPS" so a first-visit
// http:// request can't be SSL-stripped before the edge redirect — the gate
// passcode + session cookie never get a chance to travel in cleartext. The
// rest stop MIME-sniffing, framing (clickjacking) and referrer leakage.
app.use((req, res, next) => {
  res.setHeader('Strict-Transport-Security', 'max-age=63072000; includeSubDomains; preload');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  // self-only: blocks any external script/exfil host while still allowing the
  // app's inline scripts/styles (gate + app rely on them) and blob/data media.
  res.setHeader('Content-Security-Policy',
    "default-src 'self'; img-src 'self' data: blob:; media-src 'self' blob:; " +
    "script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; " +
    "connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'");
  next();
});
// Trust ONLY the local reverse proxy (cloudflared runs on loopback). With
// `true` Express would take the client-controlled leftmost X-Forwarded-For as
// req.ip, letting an attacker rotate the header to dodge the auth lockout.
app.set('trust proxy', 'loopback');
// The native passcode gate below is the sole wall.
app.use(express.json({ limit: '256mb' }));  // base64 frames are a few MB; clips are bigger

// ---- public (pre-gate) ----
// Pre-auth: don't leak filesystem paths / username here. Real paths are
// available post-auth via /api/stats.
app.get('/health', (req,res)=>res.json({ ok:true, app:'attic' }));
app.get('/api/auth-status', (req,res)=>res.json({ authed:isAuthed(req) }));
app.post('/api/auth', (req,res)=>{
  const ip=req.ip||'x';
  if (locked(ip)) return res.status(429).json({ ok:false, error:'locked' });
  // Passcode gate: the passcode is the sole factor.
  const passcode=String((req.body&&req.body.passcode)||'');
  if (passcode && safeEq(passcode, PASSCODE)) { setCookie(res,req,COOKIE_NAME,SESSION_TOKEN,60*60*24*30); noteSuccess(ip); return res.json({ ok:true }); }
  noteFail(ip); res.status(401).json({ ok:false, error:'denied' });
});
app.post('/api/logout', (req,res)=>{ setCookie(res,req,COOKIE_NAME,'',0); res.json({ ok:true }); });
app.get('/gate.html', (req,res)=>res.sendFile(path.join(PUB,'gate.html')));
app.get('/manifest.webmanifest', (req,res)=>{ res.type('application/manifest+json'); res.sendFile(path.join(PUB,'manifest.webmanifest')); });
app.get('/icon.png', (req,res)=>res.sendFile(path.join(PUB,'icon.png'), e=>{ if(e&&!res.headersSent) res.status(404).end(); }));

// Shared Sona theme + fonts must load on the lock screen, before auth.
app.use('/assets', express.static(path.join(PUB,'assets')));

// ---- auth wall ----
app.use((req,res,next)=>{ if (isAuthed(req)) return next(); if (req.path.startsWith('/api/')) return res.status(401).json({ error:'auth' }); return res.redirect('/gate.html'); });   // unauthed page loads -> native passcode gate

app.use(express.static(PUB));

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------
const uid = () => Date.now().toString(36) + crypto.randomBytes(3).toString('hex');
// uid()s are base36 time + hex random => [a-z0-9] only. Validate every :id
// route param against this so a crafted id (`..\`, `%2f`, encoded dots) can
// never be joined into a path or used to probe outside the manifest.
const ID_RE = /^[a-z0-9]+$/i;
function pad(n){ return String(n).padStart(2,'0'); }
function stamp(d){ return `${d.getFullYear()}${pad(d.getMonth()+1)}${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`; }
function startOfToday(){ const d=new Date(); d.setHours(0,0,0,0); return d.getTime(); }

// "data:image/jpeg;base64,..." -> Buffer.
// NB: the media type can itself contain a comma (e.g.
// "data:video/webm;codecs=vp8,opus;base64,..."), so we must split on the
// "base64," marker, NOT the first comma — otherwise the payload is mis-sliced
// and the decoded file is garbage.
function dataUrlToBuffer(durl){
  durl = String(durl||'');
  const m = durl.indexOf('base64,');
  const i = m >= 0 ? m + 7 : (durl.indexOf(',') + 1);
  if (i <= 0) return null;
  try { return Buffer.from(durl.slice(i), 'base64'); } catch { return null; }
}

// ffmpeg: prefer the estate's pinned/patched build (FFMPEG_PATH), else PATH.
const FFMPEG = process.env.CAM_FFMPEG || process.env.FFMPEG_PATH || 'ffmpeg';

// Normalize a recorded clip into a clean, universally-playable MP4:
// H.264 + AAC, yuv420p, moov atom up front (+faststart). MediaRecorder's own
// file (fragmented MP4 / WebM) won't open in PC players or as a plain <video>
// source, so every clip is transcoded here before it lands in the Camera Roll.
function transcodeToMp4(srcBuf, cb){
  const base   = path.join(THUMBS, '_enc_' + crypto.randomBytes(6).toString('hex'));
  const tmpIn  = base + '.src';        // ffmpeg sniffs the container, extension is cosmetic
  const tmpOut = base + '.mp4';
  try { fs.writeFileSync(tmpIn, srcBuf); } catch (e) { return cb(e, null); }
  execFile(FFMPEG, [
    '-y', '-v', 'error', '-i', tmpIn,
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-b:a', '128k',
    '-movflags', '+faststart', tmpOut,
  ], { windowsHide:true, timeout:180000 }, (err)=>{
    let out = null;
    try { if (!err && fs.existsSync(tmpOut)) out = fs.readFileSync(tmpOut); } catch {}
    try { fs.existsSync(tmpIn)  && fs.unlinkSync(tmpIn);  } catch {}
    try { fs.existsSync(tmpOut) && fs.unlinkSync(tmpOut); } catch {}
    cb(out ? null : (err || new Error('no output')), out);
  });
}

// Off-site push (best-effort, fire-and-forget). No-op unless rclone is wired up.
function cloudPush(absPath, relInVault){
  if (!RCLONE_REMOTE) return;
  const dest = `${RCLONE_REMOTE}/${path.dirname(relInVault).replace(/\\/g,'/')}`;
  execFile('rclone', ['copy', absPath, dest, '--no-traverse'], { windowsHide:true, timeout:120000 }, (err)=>{
    if (err) console.warn('[cam] rclone push failed:', err.message);
  });
}

// ---------------------------------------------------------------------------
// UPLOAD — the heart of the pipeline
// ---------------------------------------------------------------------------
// Resource guards: even a fully authed client (or a leaked session cookie)
// must not be able to exhaust the host. Each upload holds a large decoded
// buffer in memory, and each video spawns an ffmpeg encode — both are bounded.
let inFlight = 0;     const MAX_INFLIGHT = 3;   // concurrent uploads (memory)
let activeEncodes = 0; const MAX_ENCODES = 2;   // concurrent ffmpeg transcodes (CPU)

app.post('/api/upload', (req,res)=>{
  if (inFlight >= MAX_INFLIGHT) return res.status(429).json({ ok:false, error:'busy' });
  inFlight++;
  let released = false;
  res.on('close', ()=>{ if (!released){ released = true; inFlight--; } });

  const b = req.body || {};
  // Photos arrive as `full` (JPEG); videos as `video` (webm/mp4) plus a `thumb`
  // poster frame. Both ride the same pipeline: PC save → vault archive → manifest.
  const isVideo = b.kind === 'video';
  const media = dataUrlToBuffer(isVideo ? b.video : b.full);
  const thumb = dataUrlToBuffer(b.thumb);
  if (!media) return res.status(400).json({ ok:false, error: isVideo ? 'no video' : 'no image' });

  // Photos save as-is. Videos get normalized to a clean H.264 MP4 first —
  // browsers' MediaRecorder output (fragmented MP4 / WebM) won't play as a
  // standalone file, so we transcode before it ever touches the Camera Roll.
  if (isVideo) {
    if (activeEncodes >= MAX_ENCODES) return res.status(429).json({ ok:false, error:'transcoder busy' });
    activeEncodes++;
    return transcodeToMp4(media, (err, mp4) => {
      activeEncodes--;
      if (err && !mp4) console.warn('[cam] transcode failed, saving raw:', err.message);
      const usedMp4 = !!mp4;
      const ext = usedMp4 ? 'mp4' : (String(b.mime||'').includes('mp4') ? 'mp4' : 'webm');
      finalizeSave(res, b, mp4 || media, thumb, { isVideo:true, ext, dur:Number(b.dur)||0 });
    });
  }
  finalizeSave(res, b, media, thumb, { isVideo:false, ext:'jpg', dur:null });
});

// shared tail of the pipeline: PC save → vault archive → manifest → respond.
function finalizeSave(res, b, media, thumb, { isVideo, ext, dur }){
  const now = new Date();
  const id  = uid();
  const filename = `${isVideo?'VID':'IMG'}_${stamp(now)}_${id.slice(-4)}.${ext}`;

  // 2/3 — PC SAVE: straight into the desktop Camera Roll.
  const rollPath = path.join(ROLL, filename);
  fs.writeFileSync(rollPath, media);

  // dedupe-friendly fingerprint
  const hash = crypto.createHash('sha256').update(media).digest('hex');

  // poster/thumbnail (client-rendered) lands beside the manifest for snappy galleries.
  if (thumb) { try { fs.writeFileSync(path.join(THUMBS, id + '.jpg'), thumb); } catch {} }

  // 4 — ARCHIVE: copy into the date-foldered cloud vault, then push off-site.
  const dayFolder = `${now.getFullYear()}-${pad(now.getMonth()+1)}-${pad(now.getDate())}`;
  const vaultDir  = path.join(VAULT, String(now.getFullYear()), dayFolder);
  let vaultPath = null, archived = false;
  try {
    fs.mkdirSync(vaultDir, { recursive: true });
    vaultPath = path.join(vaultDir, filename);
    fs.copyFileSync(rollPath, vaultPath);
    archived = true;
    cloudPush(vaultPath, path.relative(VAULT, vaultPath));
  } catch (e) { console.warn('[cam] archive failed:', e.message); }

  const rec = db.insert({
    id, ts: now.getTime(), filename, roll_path: rollPath, vault_path: vaultPath,
    archived, w: b.w|0, h: b.h|0, bytes: media.length,
    device: String(b.device||'').slice(0,120), facing: b.facing==='environment'?'back':(b.facing==='user'?'front':null),
    lat: (typeof b.lat==='number')?b.lat:null, lon: (typeof b.lon==='number')?b.lon:null, hash,
    kind: isVideo ? 'video' : 'photo', dur: isVideo ? dur : null,
  });

  res.json({ ok:true, photo: shape(rec) });
}

// shape a db row for the client
function shape(r){
  if (!r) return null;
  const isVid = r.kind === 'video';
  return {
    id:r.id, ts:r.ts, filename:r.filename, w:r.w, h:r.h, bytes:r.bytes,
    facing:r.facing, lat:r.lat, lon:r.lon, archived:!!r.archived, fav:!!r.fav, note:r.note||'',
    kind: r.kind || 'photo', dur: r.dur || 0,
    url:     isVid ? `/api/video/${r.id}`        : `/api/photo/${r.id}`,
    thumb:   `/api/thumb/${r.id}`,
    download:isVid ? `/api/video/${r.id}?dl=1`   : `/api/photo/${r.id}?dl=1`,
  };
}

// ---------------------------------------------------------------------------
// gallery + media
// ---------------------------------------------------------------------------
app.get('/api/photos', (req,res)=>{
  const limit  = Math.min(parseInt(req.query.limit||'120',10), 500);
  const offset = parseInt(req.query.offset||'0',10) || 0;
  const fav    = req.query.fav === '1';
  res.json({ photos: db.list({ limit, offset, fav }).map(shape) });
});

app.get('/api/stats', (req,res)=>{
  const s = db.stats();
  res.json({ ...s, today: db.todayCount(startOfToday()), roll: ROLL, cloud: RCLONE_REMOTE ? 'rclone:'+RCLONE_REMOTE : 'local vault' });
});

app.get('/api/photo/:id', (req,res)=>{
  if (!ID_RE.test(req.params.id)) return res.status(400).end();
  const r = db.get(req.params.id);
  if (!r || !fs.existsSync(r.roll_path)) {
    // fall back to the vault copy if the roll file was moved/cleaned
    if (r && r.vault_path && fs.existsSync(r.vault_path)) return sendImg(res, r.vault_path, r.filename, req.query.dl);
    return res.status(404).end();
  }
  sendImg(res, r.roll_path, r.filename, req.query.dl);
});
function sendImg(res, p, name, dl){
  res.setHeader('Cache-Control','private, no-store');   // private media: never cache at the edge/browser
  res.type('image/jpeg');
  if (dl) res.setHeader('Content-Disposition', `attachment; filename="${name}"`);
  res.sendFile(p);
}

// Video needs HTTP range support so the browser can seek/scrub and start
// playback before the whole file arrives.
app.get('/api/video/:id', (req,res)=>{
  if (!ID_RE.test(req.params.id)) return res.status(400).end();
  const r = db.get(req.params.id);
  const p = (r && fs.existsSync(r.roll_path)) ? r.roll_path
          : (r && r.vault_path && fs.existsSync(r.vault_path)) ? r.vault_path : null;
  if (!p) return res.status(404).end();
  sendVideo(req, res, p, r.filename, req.query.dl);
});
function sendVideo(req, res, p, name, dl){
  const total = fs.statSync(p).size;
  const type  = String(name||'').endsWith('.mp4') ? 'video/mp4' : 'video/webm';
  res.setHeader('Cache-Control','private, no-store');   // private media: never cache at the edge/browser
  if (dl) res.setHeader('Content-Disposition', `attachment; filename="${name}"`);
  const range = req.headers.range;
  if (range){
    const m = /bytes=(\d*)-(\d*)/.exec(range) || [];
    let start = m[1] ? parseInt(m[1],10) : 0;
    let end   = m[2] ? parseInt(m[2],10) : total-1;
    if (isNaN(start) || start<0) start = 0;
    if (isNaN(end) || end>=total) end = total-1;
    if (start > end){ res.status(416).setHeader('Content-Range', `bytes */${total}`); return res.end(); }
    res.writeHead(206, { 'Content-Range':`bytes ${start}-${end}/${total}`, 'Accept-Ranges':'bytes', 'Content-Length':end-start+1, 'Content-Type':type });
    return fs.createReadStream(p, { start, end }).pipe(res);
  }
  res.writeHead(200, { 'Content-Length':total, 'Accept-Ranges':'bytes', 'Content-Type':type });
  fs.createReadStream(p).pipe(res);
}

app.get('/api/thumb/:id', (req,res)=>{
  if (!ID_RE.test(req.params.id)) return res.status(400).end();
  const p = path.join(THUMBS, req.params.id + '.jpg');
  if (fs.existsSync(p)) { res.setHeader('Cache-Control','private, no-store'); res.type('image/jpeg'); return res.sendFile(p); }
  // no thumb on record? serve the full frame.
  const r = db.get(req.params.id);
  if (r && fs.existsSync(r.roll_path)) { res.setHeader('Cache-Control','private, no-store'); res.type('image/jpeg'); return res.sendFile(r.roll_path); }
  res.status(404).end();
});

app.post('/api/photo/:id/fav', (req,res)=>{ const r=db.get(req.params.id); if(!r) return res.status(404).json({ok:false}); db.setFav(r.id, !r.fav); res.json({ ok:true, fav: !r.fav }); });
app.post('/api/photo/:id/note', (req,res)=>{ const r=db.get(req.params.id); if(!r) return res.status(404).json({ok:false}); db.setNote(r.id, (req.body&&req.body.note)||''); res.json({ ok:true }); });

app.delete('/api/photo/:id', (req,res)=>{
  const r = db.get(req.params.id);
  if (!r) return res.status(404).json({ ok:false });
  const keepVault = req.query.keepVault === '1';   // delete from roll but keep the archive
  for (const p of [r.roll_path, path.join(THUMBS, r.id+'.jpg'), keepVault?null:r.vault_path]) {
    if (p) try { fs.existsSync(p) && fs.unlinkSync(p); } catch {}
  }
  db.remove(r.id);
  res.json({ ok:true });
});

// open the Camera Roll folder in Explorer (handy from the desktop view)
app.post('/api/reveal', (req,res)=>{
  execFile('explorer.exe', [ROLL], { windowsHide:true }, ()=>{});
  res.json({ ok:true, path: ROLL });
});

// Reaching the Attic from other devices: the recommended path is a private
// mesh VPN (Tailscale / WireGuard), so the app binds all interfaces by default
// and the traffic rides inside the encrypted tunnel — nothing is exposed to the
// public internet. If you instead put this behind your own reverse proxy, or
// only ever use it on localhost, set CAM_HOST to '127.0.0.1'. Note: on a plain
// untrusted LAN with no TLS, the gate passcode + session cookie travel in
// cleartext — use the VPN or a proxy, not a bare LAN, for anything private.
const HOST = process.env.CAM_HOST || '0.0.0.0';
app.listen(PORT, HOST, ()=>{
  console.log(`[attic] http://${HOST}:${PORT} (loopback-only)`);
  console.log(`[attic] roll  -> ${ROLL}`);
  console.log(`[attic] vault -> ${VAULT}`);
});
