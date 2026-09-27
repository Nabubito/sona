'use strict';
//
// Flicker, by Sona: a self-hosted video FX studio.
//
// Drop a video from your own device, then cut it, pull the audio, make a GIF, reframe it for the
// vertical feeds, burn words onto it, or make text follow something in the shot. Everything runs
// on this machine with ffmpeg. Optional helpers (speech to text, the tracker, link import) switch
// on only when they are installed and, for link import, only when you turn it on in config.json.
//
// Plain Node, zero npm dependencies, no build step. One passcode gate in front of everything.

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const CONFIG = require('./lib/config');
const PROC = require('./lib/proc');
const CLIP = require('./lib/clip');
const SUBS = require('./lib/subs');
const LYRICS = require('./lib/lyrics');
const ENGINES = require('./lib/engines');
const { createListen, wavArgs, LYRICS_NAME } = require('./lib/listen');
const { createSongHunt } = require('./lib/songhunt');
const { createSources, SIZES, MODES, ZOOM_MAX, colorOptions } = require('./lib/sources');
const { createFollow } = require('./lib/follow');
const EGRESS = require('./lib/egress');
const LINK = require('./lib/linkimport');
const LABELS = require('./lib/labels');

const cfg = CONFIG.load();
const LIM = cfg.limits;
PROC.setLowPriority(cfg.lowPriority);
CLIP.setThreads(cfg.ffmpegThreads);
LYRICS.setEnabled(cfg.lyrics.enabled);
EGRESS.configureRefused(cfg.linkImport.refuseHosts);

const ROOT = __dirname;
const PUBLIC = path.join(ROOT, 'public');
const DATA_DIR = cfg.dataDir;
const WORK_DIR = cfg.workDir;
const BODY_LIMIT = 16 * 1024;
const TOMBSTONE_MS = 30 * 60_000;
const SWEEP_MS = 5 * 60_000;
const JOBS_MAX = 500;
const FILE_TTL_MS = LIM.fileMinutes * 60_000;
const FOLLOW_TTL_MS = LIM.sourceHours * 3600_000;

/* ================================================================== *
 * Passcode gate
 * ================================================================== */

const SESSION_NAME = 'flicker_session';
const PASS_MIN = 8;
let PASSCODE = '';
let SESSION = '';

function setupSecrets() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  PASSCODE = cfg.passcode;
  const tooShort = !!PASSCODE && PASSCODE.length < PASS_MIN;
  if (tooShort) {
    console.log('[flicker] the configured passcode is shorter than ' + PASS_MIN + ' characters, so it is NOT used.');
    console.log('[flicker] set a longer one in config.json or FLICKER_PASS. Using the generated passcode below until then.');
    PASSCODE = '';
  }
  if (!PASSCODE) {
    // No passcode set: make one up the first time, keep it in the data dir, and say where it is.
    const f = path.join(DATA_DIR, 'passcode.txt');
    try { PASSCODE = fs.readFileSync(f, 'utf8').trim(); } catch { PASSCODE = ''; }
    if (PASSCODE.length >= PASS_MIN) {
      // say it outright when a too short one was refused, so nobody is locked out
      console.log('[flicker] using the generated passcode saved in the data folder as passcode.txt' + (tooShort ? ': ' + PASSCODE : '.'));
    }
    else {
      const abc = 'abcdefghjkmnpqrstuvwxyz23456789';
      const b = crypto.randomBytes(10);
      PASSCODE = Array.from(b, (x) => abc[x % abc.length]).join('');
      try { fs.writeFileSync(f, PASSCODE + '\n', { mode: 0o600 }); } catch { /* printed below anyway */ }
      console.log('[flicker] first run: your passcode is ' + PASSCODE + ' (saved in the data folder as passcode.txt).');
      console.log('[flicker] set your own with "passcode" in config.json or the FLICKER_PASS variable.');
    }
  }
  const tf = path.join(DATA_DIR, 'session.key');
  try { SESSION = fs.readFileSync(tf, 'utf8').trim(); } catch { SESSION = ''; }
  if (!/^[a-f0-9]{48}$/.test(SESSION)) {
    SESSION = crypto.randomBytes(24).toString('hex');
    try { fs.writeFileSync(tf, SESSION, { mode: 0o600 }); } catch { /* sessions just will not survive a restart */ }
  }
}

function safeEq(a, b) {
  const A = crypto.createHash('sha256').update(String(a)).digest();
  const B = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(A, B);
}

// Per address lockout, plus a global one no amount of address rotation can escape.
const fails = new Map();
let globalFails = { n: 0, until: 0 };
const lockState = (ip) => fails.get(ip) || { n: 0, until: 0 };
function noteFail(ip) {
  const s = lockState(ip); s.n++; if (s.n >= 8) { s.until = Date.now() + 15 * 60_000; s.n = 0; } fails.set(ip, s);
  globalFails.n++; if (globalFails.n >= 30) { globalFails.until = Date.now() + 15 * 60_000; globalFails.n = 0; }
}
function noteSuccess(ip) { fails.delete(ip); globalFails.n = 0; }
const locked = (ip) => lockState(ip).until > Date.now() || globalFails.until > Date.now();
setInterval(() => { const now = Date.now(); for (const [k, v] of fails) if (!v.until || v.until < now) fails.delete(k); }, 60_000).unref();

function parseCookies(req) {
  const out = {};
  const h = req.headers.cookie;
  if (!h) return out;
  for (const p of String(h).split(';')) {
    const i = p.indexOf('=');
    if (i < 0) continue;
    try { out[p.slice(0, i).trim()] = decodeURIComponent(p.slice(i + 1).trim()); } catch { /* skip a malformed one */ }
  }
  return out;
}
const isHttps = (req) => cfg.trustProxy && String(req.headers['x-forwarded-proto'] || '').toLowerCase() === 'https';
function setSession(req, res, val, maxAge) {
  let c = SESSION_NAME + '=' + encodeURIComponent(val) + '; Path=/; HttpOnly; SameSite=Strict; Max-Age=' + maxAge;
  if (isHttps(req)) c += '; Secure';
  res.setHeader('Set-Cookie', c);
}
function isAuthed(req) { const c = parseCookies(req)[SESSION_NAME]; return !!c && safeEq(c, SESSION); }

function clientIp(req) {
  const remote = String(req.socket && req.socket.remoteAddress || 'local');
  if (cfg.trustProxy && /^(127\.|::1$|::ffff:127\.)/.test(remote)) {
    const xff = String(req.headers['x-forwarded-for'] || '').split(',').map((x) => x.trim()).filter(Boolean);
    if (xff.length) return xff[xff.length - 1].slice(0, 64);   // the entry our own proxy added
  }
  return remote.slice(0, 64);
}

/* ================================================================== *
 * Engines and modules
 * ================================================================== */

let FOUND = null;         // raw detection, with paths (never sent to the page)
let FFMPEG = '';
let SONGHUNT = null;
let SOURCES = null;
let LISTEN = null;
let FOLLOW = null;
let LINKIMP = null;
let egress = null;
let songCaps = { fingerprint: false, lyrics: cfg.lyrics.enabled };

const ffEnv = () => LINK.spawnEnv(egress && egress.port ? 'http://127.0.0.1:' + egress.port : '');

async function detect() {
  FOUND = await ENGINES.detectAll(cfg);
  if (LISTEN) LISTEN.set({ python: FOUND.listen.python, ready: FOUND.listen.ok });
  if (FOLLOW) FOLLOW.set({ python: FOUND.tracker.python, ready: FOUND.tracker.ok });
  if (SONGHUNT) songCaps = await SONGHUNT.capabilities();
  return FOUND;
}
const canBurn = () => !!(FOUND && FOUND.ffmpeg.burn);

/* ================================================================== *
 * Errors: stable codes, friendly text, never raw tool output
 * ================================================================== */

const fmtLen = (s) => (s >= 60 ? Math.round(s / 60 * 10) / 10 + ' minutes' : Math.round(s) + ' seconds');
const ERR = {
  badrequest: 'That request did not look right. Reload the page and try again.',
  gone: 'That is no longer here. It may have expired. Open the video again.',
  busy: 'Flicker is busy with other renders. Give it a moment and try again.',
  diskfull: 'The work folder is full or the disk is low on space. Save or clear some renders first.',
  toobig: 'That file is bigger than the upload limit (' + LIM.maxUploadMB + ' MB, set in config.json).',
  toolong: 'That video is longer than the limit (' + fmtLen(LIM.maxSourceMinutes * 60) + ', set in config.json).',
  toomany: 'You have a lot of videos open. Close one first.',
  badmedia: 'That does not look like a video Flicker can read. MP4, MOV, MKV and WebM all work.',
  badoffset: 'The upload lost its place. Drop the video in again.',
  badclip: 'That range does not work for this tool. Clips run up to ' + fmtLen(LIM.maxClipSeconds) + ', GIFs up to ' + fmtLen(LIM.maxGifSeconds) + '.',
  renderfail: 'The render did not work. Try a slightly different range.',
  noffmpeg: 'ffmpeg was not found. See Engines in the menu.',
  noburn: 'This ffmpeg cannot burn in text (it has no libass). See Engines in the menu.',
  nolisten: 'Speech to text is not set up. See Engines in the menu.',
  listenlong: 'Heard words work on clips up to ' + fmtLen(LIM.maxListenSeconds) + '. Shorten the clip.',
  noaudio: 'This video has no sound to listen to.',
  nolyrics: 'No lyrics found for this one yet. Name the song, or use heard words.',
  nolyricslookup: 'Lyrics lookup is switched off in config.json.',
  nocaptions: 'This video has no captions from its link.',
  notext: 'Type at least one line of words first.',
  nowords: 'No words were heard in that range, so the render has none.',
  nofollow: 'Text follow is not set up. See Engines in the menu.',
  followbusy: 'The graphics card is busy with something else right now. Text follow waits until it is free.',
  warming: 'The tracker is warming up. Tap again in a few seconds.',
  followlong: 'Text follow works on clips up to ' + fmtLen(LIM.maxFollowSeconds) + '. Shorten the clip.',
  trackfail: 'Tracking did not work on this one. Mark a bit more of it, or pick a clearer frame.',
  notracked: 'Preview the track first, then render.',
  notags: 'Type the text for at least one marked thing first.',
  ratelimit: 'That is a lot of requests in a short time. Try again in a minute.',
  linkoff: 'Link import is off. It can be turned on in config.json.',
  noengine: 'Link import is on, but yt-dlp was not found. See Engines in the menu.',
  badurl: 'That does not look like a public video link.',
  private_addr: 'That link points somewhere Flicker will not go.',
  blocked: 'That link points somewhere Flicker will not go.',
  drm: 'This one is copy protected. No tool can save it.',
  age: 'Age gated. Flicker never signs in anywhere, so this one stays locked.',
  private: 'Private, members only, or paid. Only public links work.',
  login: 'That site only shows this to people who are signed in. Flicker never signs in anywhere.',
  noformat: 'Nothing saveable here. Usually copy protected or blocked in this region.',
  unavailable: 'That video is gone, private, or blocked in this region.',
  bot: 'The site is asking for a human right now. Give it a few minutes and try again.',
  unsupported: 'That link is not a video page the engine knows. Try the page the video plays on.',
  live: 'That is a live stream. Only finished videos can be imported.',
  filtered: 'That one does not fit the limits: no live streams, nothing longer than the length limit.',
  network: 'Could not reach that site just now. Try again in a moment.',
  cancelled: 'Cancelled.',
  unknown: 'Something went wrong. Try again.',
};
const errText = (code) => ERR[code] || ERR.unknown;

/* ================================================================== *
 * Disk guard
 * ================================================================== */

function dirSize(dir) {
  let total = 0;
  const stack = [dir];
  while (stack.length) {
    const d = stack.pop();
    let ents;
    try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch { continue; }
    for (const e of ents) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) stack.push(p);
      else { try { total += fs.statSync(p).size; } catch { /* vanished */ } }
    }
  }
  return total;
}
let diskAt = 0, diskVerdict = true;
function diskOk() {
  const now = Date.now();
  if (now - diskAt < 5_000) return diskVerdict;
  let v = true;
  try {
    if (dirSize(WORK_DIR) > LIM.workCapGB * 1024 ** 3) v = false;
    else { const st = fs.statfsSync(WORK_DIR); if (st.bsize * st.bavail < LIM.minFreeGB * 1024 ** 3) v = false; }
  } catch { /* if we cannot measure, do not wedge the app */ }
  diskAt = now; diskVerdict = v;
  return v;
}

/* ================================================================== *
 * Jobs: renders, text follow sessions, link imports
 * ================================================================== */

const jobs = new Map();
const queue = [];
const runningCount = () => [...jobs.values()].filter((j) => j.state === 'running').length;
const positionOf = (id) => { const i = queue.indexOf(id); return i < 0 ? 0 : i + 1; };

function safeName(title, ext) {
  let t = String(title || '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/[\\/:*?"<>|]/g, ' ').replace(/\s+/g, ' ').replace(/^\.+/, '').trim();
  if (t.length > 120) t = t.slice(0, 120).trim();
  if (!t) t = 'flicker';
  return t + '.' + String(ext || 'mp4').replace(/[^A-Za-z0-9]/g, '').slice(0, 8);
}

function clearTimers(j) { if (j.reap) { clearTimeout(j.reap); j.reap = null; } }
function dropDir(j) {
  if (!j.dir) return;
  const d = j.dir;
  j.dir = '';
  fs.rm(d, { recursive: true, force: true, maxRetries: 3 }, () => { /* best effort */ });
}
function reapLater(j, ms) {
  clearTimers(j);
  j.reap = setTimeout(() => {
    dropDir(j);
    j.state = j.state === 'ready' ? 'gone' : j.state;
    j.file = '';
    j.reap = setTimeout(() => jobs.delete(j.id), TOMBSTONE_MS);
  }, Math.max(1_000, ms));
}
function failJob(j, code) {
  if (j.state === 'error' || j.state === 'cancelled') return;
  j.state = code === 'cancelled' ? 'cancelled' : 'error';
  j.code = code; j.error = errText(code); j.percent = 0; j.file = '';
  dropDir(j);
  clearTimers(j);
  j.reap = setTimeout(() => jobs.delete(j.id), TOMBSTONE_MS);
}

function newJob(kind, title, run, extra) {
  if (jobs.size >= JOBS_MAX) {
    for (const [k, old] of jobs) {
      if (jobs.size < JOBS_MAX) break;
      if (old.state === 'error' || old.state === 'cancelled' || old.state === 'gone') { clearTimers(old); jobs.delete(k); }
    }
  }
  const id = crypto.randomBytes(16).toString('hex');
  const j = Object.assign({
    id, kind, title, run, state: 'queued', stage: '', percent: 0, speed: '', eta: '',
    name: '', size: 0, file: '', ext: '', code: '', error: '', dir: path.join(WORK_DIR, id),
    proc: null, cancelled: false, createdAt: Date.now(), readyAt: 0, reap: null,
    subs: '', subsFrom: '', source: '', follow: null, track: null,
  }, extra || {});
  jobs.set(id, j);
  queue.push(id);
  pump();
  return j;
}

function pump() {
  while (runningCount() < LIM.concurrentRenders && queue.length) {
    const id = queue.shift();
    const j = jobs.get(id);
    if (!j || j.state !== 'queued') continue;
    start(j);
  }
}

async function start(j) {
  j.state = 'running';
  try { fs.mkdirSync(j.dir, { recursive: true }); } catch { failJob(j, 'busy'); return pump(); }
  let r;
  try { r = await j.run(j); } catch { r = { ok: false, code: 'renderfail' }; }
  if (j.cancelled) { failJob(j, 'cancelled'); return pump(); }
  if (!r || !r.ok) { failJob(j, (r && r.code) || 'renderfail'); return pump(); }
  j.state = 'ready'; j.stage = ''; j.percent = 100; j.speed = ''; j.eta = '';
  j.readyAt = Date.now();
  if (r.source) { j.source = r.source; dropDir(j); reapLater(j, TOMBSTONE_MS); }
  else {
    j.file = r.file; j.size = r.size; j.ext = r.ext;
    j.name = safeName(r.name || j.title, r.ext);
    reapLater(j, j.follow ? FOLLOW_TTL_MS : FILE_TTL_MS);
  }
  pump();
}

function cancelJob(j) {
  if (j.state === 'ready' || j.state === 'gone') { clearTimers(j); dropDir(j); j.state = 'cancelled'; j.reap = setTimeout(() => jobs.delete(j.id), TOMBSTONE_MS); return; }
  if (j.state === 'error' || j.state === 'cancelled') return;
  j.cancelled = true;
  const qi = queue.indexOf(j.id);
  if (qi >= 0) { queue.splice(qi, 1); failJob(j, 'cancelled'); return; }
  if (j.proc) PROC.killTree(j.proc);
}

function sweepWork() {
  let names;
  try { names = fs.readdirSync(WORK_DIR); } catch { return; }
  for (const n of names) {
    if (n === 'warm' || n === 'cache') continue;
    if (/^[a-f0-9]{32}$/.test(n) && jobs.has(n)) continue;
    if (/^sr[a-f0-9]{30}$/.test(n) && SOURCES && SOURCES.get(n)) continue;
    if (!/^([a-f0-9]{32}|sr[a-f0-9]{30})$/.test(n)) continue;      // only ever touch our own folders
    const d = path.join(WORK_DIR, n);
    fs.stat(d, (e, st) => {
      if (e || !st) return;
      if (Date.now() - st.mtimeMs > 10 * 60_000) fs.rm(d, { recursive: true, force: true }, () => { /* best effort */ });
    });
  }
}

/* ---- words: build subs.srt in the job dir, from whichever source was asked for ---- */

// Checked before a job is created. Returns { ok, words } or { ok:false, code }.
function normWords(s, body, range, kind) {
  const w = body && body.words && typeof body.words === 'object' ? body.words : {};
  const mode = ['typed', 'listen', 'lyrics', 'captions'].includes(w.mode) ? w.mode : '';
  if (!mode || kind === 'audio') return { ok: true, words: null };
  if (!canBurn()) return { ok: false, code: 'noburn' };
  const style = SUBS.normStyle(w.style);
  if (mode === 'typed') {
    const text = typeof w.text === 'string' ? w.text.slice(0, SUBS.TYPED_MAX_CHARS) : '';
    if (!SUBS.typedCues(text, range.len).length) return { ok: false, code: 'notext' };
    return { ok: true, words: { mode, text, style } };
  }
  if (mode === 'captions') {
    if (!s.captions) return { ok: false, code: 'nocaptions' };
    return { ok: true, words: { mode, style } };
  }
  if (!LISTEN || !LISTEN.available()) return { ok: false, code: 'nolisten' };
  if (!s.meta.audio) return { ok: false, code: 'noaudio' };
  if (range.len > LIM.maxListenSeconds + 0.05) return { ok: false, code: 'listenlong' };
  if (mode === 'lyrics' && !(s.song && s.song.lyrics)) return { ok: false, code: 'nolyrics' };
  return { ok: true, words: { mode, style } };
}

// Runs inside the job. Resolves true when subs.srt is on disk.
async function makeWords(j, s, range, words) {
  let made = { cues: 0, srt: '' };
  if (words.mode === 'typed') {
    made = SUBS.cuesToSrt(SUBS.typedCues(words.text, range.len), range.len);
    j.subsFrom = 'typed';
  } else if (words.mode === 'captions') {
    try { made = SUBS.buildClipSrt(fs.readFileSync(s.captions.file, 'utf8'), range.start, range.end); } catch { made = { cues: 0 }; }
    j.subsFrom = 'captions';
  } else {
    j.stage = 'listening';
    const w = await CLIP.runClip(FFMPEG, wavArgs(s.file, range.start, range.len), range.len, ffEnv(), j, null, j.dir);
    if (j.cancelled) return false;
    if (w.code === 0) {
      if (words.mode === 'lyrics' && s.song && s.song.lyrics) { try { fs.writeFileSync(path.join(j.dir, LYRICS_NAME), s.song.lyrics.join('\n') + '\n'); } catch { /* heard words then */ } }
      const heard = await LISTEN.transcribe(j.dir, j, () => j.cancelled);
      if (j.cancelled) return false;
      j.subsFrom = heard.source === 'lyrics' ? 'lyrics' : 'heard';
      made = SUBS.cuesToSrt(heard, range.len);
    }
  }
  if (made.cues > 0) {
    try { fs.writeFileSync(path.join(j.dir, SUBS.SRT_NAME), made.srt); j.subs = 'burned'; return true; } catch { /* fall through */ }
  }
  j.subs = 'missing';
  return false;
}

/* ================================================================== *
 * HTTP plumbing
 * ================================================================== */

const CSP = "default-src 'self'; img-src 'self' data: blob:; media-src 'self' blob:; style-src 'self'; script-src 'self'; " +
  "font-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'";
const PERMISSIONS = 'camera=(), microphone=(), geolocation=(), payment=(), usb=(), midi=(), serial=()';

function secHeaders(res) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Content-Security-Policy', CSP);
  res.setHeader('Permissions-Policy', PERMISSIONS);
}
function sendJson(res, code, data) {
  const body = Buffer.from(JSON.stringify(data));
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': body.length, 'Cache-Control': 'no-store' });
  res.end(body);
}
const fail = (res, status, code) => sendJson(res, status, { ok: false, code, error: errText(code) });

// A browser posting from our own page only. Anything explicitly cross site is out.
function sameOrigin(req) {
  const sfs = String(req.headers['sec-fetch-site'] || '').toLowerCase();
  if (sfs === 'cross-site') return false;
  const origin = req.headers.origin;
  if (origin && origin !== 'null') {
    let oh;
    try { oh = new URL(origin).host.toLowerCase(); } catch { return false; }
    const host = String(req.headers.host || '').toLowerCase();
    if (!host || oh !== host) return false;
  }
  return true;
}
const jsonRequest = (req) => String(req.headers['content-type'] || '').toLowerCase().split(';')[0].trim() === 'application/json';

function readBody(req) {
  return new Promise((resolve) => {
    let size = 0, over = false;
    const chunks = [];
    req.on('data', (c) => { size += c.length; if (size > BODY_LIMIT) { over = true; return; } chunks.push(c); });
    req.on('end', () => {
      if (over) return resolve({ over: true });
      try { resolve({ body: JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') }); } catch { resolve({ bad: true }); }
    });
    req.on('error', () => resolve({ bad: true }));
  });
}
async function jsonBody(req, res) {
  if (!jsonRequest(req)) { req.resume(); fail(res, 415, 'badrequest'); return null; }
  if (Number(req.headers['content-length'] || 0) > BODY_LIMIT) { req.resume(); fail(res, 413, 'badrequest'); return null; }
  const r = await readBody(req);
  if (r.over) { fail(res, 413, 'badrequest'); return null; }
  if (r.bad || !r.body || typeof r.body !== 'object') { fail(res, 400, 'badrequest'); return null; }
  return r.body;
}
const drain = (req) => { if (req.method !== 'GET' && req.method !== 'HEAD') req.resume(); };

// small local rate limits (the gate already keeps strangers out; these stop a runaway page)
const buckets = new Map();
function hit(key, max, windowMs) {
  const now = Date.now();
  const arr = (buckets.get(key) || []).filter((t) => now - t < windowMs);
  if (arr.length >= max) { buckets.set(key, arr); return false; }
  arr.push(now); buckets.set(key, arr);
  return true;
}

/* --- static ---------------------------------------------------------------- */

const MIME = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.txt': 'text/plain; charset=utf-8',
};

let buildToken = '0', buildAt = 0;
function computeBuild() {
  if (Date.now() - buildAt < 10_000 && buildToken !== '0') return buildToken;
  let max = 0;
  const stack = [PUBLIC];
  while (stack.length) {
    const d = stack.pop();
    let ents;
    try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch { continue; }
    for (const e of ents) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) stack.push(p);
      else { try { const s = fs.statSync(p); if (s.mtimeMs > max) max = s.mtimeMs; } catch { /* vanished */ } }
    }
  }
  buildToken = Math.floor(max / 1000).toString(36) || '0';
  buildAt = Date.now();
  return buildToken;
}
// HTML pages get versioned asset URLs, so a browser or proxy cache never serves a stale script.
const shellCache = new Map();
function renderPage(name) {
  const v = computeBuild();
  const c = shellCache.get(name);
  if (c && c.token === v) return c.body;
  let html;
  try { html = fs.readFileSync(path.join(PUBLIC, name), 'utf8'); } catch { return null; }
  html = html.replace(/(href|src)="([^":?]+\.(?:css|js|webmanifest|svg|png))"/g, (m, attr, file) => attr + '="' + file + '?v=' + v + '"');
  const body = Buffer.from(html, 'utf8');
  shellCache.set(name, { token: v, body });
  return body;
}
function servePage(res, name) {
  const body = renderPage(name);
  if (!body) { res.writeHead(500); return res.end(); }
  res.writeHead(200, { 'Content-Type': MIME['.html'], 'Content-Length': body.length, 'Cache-Control': 'no-store' });
  res.end(body);
}

// Only the plain spelling of a file name is accepted: no Windows alternate streams (name::$DATA),
// no trailing dots or spaces, no 8.3 aliases, no device names.
const SAFE_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const WIN_RESERVED = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(\.|$)/i;
function safeSegment(s) {
  if (!s || s.length > 128) return false;
  if (!SAFE_SEGMENT.test(s)) return false;
  if (s.endsWith('.')) return false;
  if (s.includes('..')) return false;
  if (WIN_RESERVED.test(s)) return false;
  return true;
}
function serveStatic(req, res, rawPath) {
  let rel;
  try { rel = decodeURIComponent(rawPath); } catch { res.writeHead(400); return res.end(); }
  if (rel.includes('\u0000')) { res.writeHead(400); return res.end(); }
  if (rel === '/' || rel === '') return servePage(res, 'index.html');
  const segs = rel.replace(/^\/+/, '').split('/');
  if (!segs.length || !segs.every(safeSegment)) { res.writeHead(404); return res.end('not found'); }
  const fp = path.normalize(path.join(PUBLIC, segs.join(path.sep)));
  if (fp !== PUBLIC && !fp.startsWith(PUBLIC + path.sep)) { res.writeHead(403); return res.end(); }
  let st;
  try { st = fs.statSync(fp); } catch { res.writeHead(404); return res.end('not found'); }
  if (!st.isFile()) { res.writeHead(404); return res.end('not found'); }
  const ext = path.extname(fp).toLowerCase();
  if (ext === '.html') return servePage(res, path.relative(PUBLIC, fp));
  const cache = (ext === '.woff2' || ext === '.png' || ext === '.ico') ? 'public, max-age=604800' : 'no-store';
  res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream', 'Content-Length': st.size, 'Cache-Control': cache });
  if (req.method === 'HEAD') return res.end();
  const s = fs.createReadStream(fp);
  s.on('error', () => { try { res.destroy(); } catch { /* raced */ } });
  s.pipe(res);
}

// Everything the lock screen needs, served ABOVE the auth wall.
const OPEN_PATHS = new Set(['/gate.html', '/gate.js', '/icon.svg', '/manifest.webmanifest']);
const isOpenAsset = (p) => OPEN_PATHS.has(p) || p.startsWith('/assets/');

/* --- file delivery --------------------------------------------------------- */

function enc5987(s) { return encodeURIComponent(s).replace(/['()*]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase()); }
function disposition(name) {
  const ascii = (name.replace(/[^\u0020-\u007e]/g, '_').replace(/["\\]/g, '_') || 'flicker').slice(0, 120);
  return 'attachment; filename="' + ascii + '"; filename*=UTF-8\'\'' + enc5987(name);
}
const MEDIA_MIME = { mp4: 'video/mp4', gif: 'image/gif', mp3: 'audio/mpeg', m4a: 'audio/mp4', opus: 'audio/ogg', webm: 'video/webm' };

// Range + HEAD aware. inline = played in the page (a source, a follow clip, a render preview).
function serveMedia(req, res, file, size, opts) {
  if (!file || !fs.existsSync(file)) { res.writeHead(404); return res.end('gone'); }
  const common = {
    'Content-Type': opts.inline ? (opts.mime || 'video/mp4') : 'application/octet-stream',
    'Content-Disposition': opts.inline ? 'inline' : disposition(opts.name || 'flicker.mp4'),
    'Accept-Ranges': 'bytes', 'Cache-Control': 'no-store',
  };
  const range = req.headers.range;
  let start = 0, end = size - 1, partial = false;
  if (range) {
    const m = /^bytes=(\d*)-(\d*)$/.exec(String(range).trim());
    if (!m || (m[1] === '' && m[2] === '')) { res.writeHead(416, Object.assign({}, common, { 'Content-Range': 'bytes */' + size })); return res.end(); }
    if (m[1] === '') { start = Math.max(0, size - Number(m[2])); end = size - 1; }
    else { start = Number(m[1]); end = m[2] === '' ? size - 1 : Math.min(Number(m[2]), size - 1); }
    if (!Number.isFinite(start) || !Number.isFinite(end) || start > end || start >= size) { res.writeHead(416, Object.assign({}, common, { 'Content-Range': 'bytes */' + size })); return res.end(); }
    partial = true;
  }
  const head = Object.assign({}, common, { 'Content-Length': end - start + 1 });
  if (partial) head['Content-Range'] = 'bytes ' + start + '-' + end + '/' + size;
  res.writeHead(partial ? 206 : 200, head);
  if (req.method === 'HEAD') return res.end();
  const stream = fs.createReadStream(file, { start, end });
  stream.on('error', () => { try { res.destroy(); } catch { /* raced */ } });
  res.on('close', () => { try { stream.destroy(); } catch { /* raced */ } });
  stream.pipe(res);
}

/* ================================================================== *
 * Routes
 * ================================================================== */

function statePayload() {
  const view = ENGINES.publicView(FOUND, cfg, songCaps);
  return {
    ok: true,
    engines: view,
    limits: {
      maxUploadMB: LIM.maxUploadMB, maxSourceSec: LIM.maxSourceMinutes * 60, clip: LIM.maxClipSeconds, gif: LIM.maxGifSeconds,
      follow: LIM.maxFollowSeconds, listen: LIM.maxListenSeconds, fileMinutes: LIM.fileMinutes, sourceHours: LIM.sourceHours,
      part: SOURCES ? SOURCES.PART_MAX : 0,
    },
    styles: SUBS.styleOptions(),
    reframe: { sizes: SIZES, modes: MODES, colors: colorOptions(), zoomMax: ZOOM_MAX },
    gifWidths: CLIP.GIF_WIDTHS,
    tags: { max: LABELS.TAGS_MAX, nameMax: LABELS.NAME_MAX, places: LABELS.PLACES, colors: LABELS.DEFAULT_COLORS },
  };
}

function jobView(j) {
  return {
    ok: true, id: j.id, kind: j.kind, state: j.state, position: j.state === 'queued' ? positionOf(j.id) : 0,
    stage: j.stage || '', percent: Math.round((j.percent || 0) * 10) / 10, speed: j.speed || '', eta: j.eta || '',
    name: j.name || j.title || '', size: j.size || 0, ext: j.ext || '',
    subs: j.subs || '', subsFrom: j.subs === 'burned' ? j.subsFrom : '',
    source: j.source || undefined,
    follow: j.follow && j.state === 'ready' ? j.follow : undefined,
    code: j.code || '', error: j.error || '',
  };
}

async function sourceRoute(req, res, urlPath) {
  if (urlPath === '/api/upload') {
    if (req.method !== 'POST') { drain(req); res.writeHead(405); return res.end(); }
    const b = await jsonBody(req, res); if (!b) return;
    if (!diskOk()) return fail(res, 503, 'diskfull');
    const r = SOURCES.begin(b.size, b.name, crypto.randomBytes(16));
    if (!r.ok) return fail(res, r.code === 'toobig' ? 413 : r.code === 'toomany' ? 429 : r.code === 'busy' ? 503 : 400, r.code);
    return sendJson(res, 200, { ok: true, id: r.src.id, part: SOURCES.PART_MAX });
  }
  if (urlPath === '/api/sources') {
    if (req.method !== 'GET' && req.method !== 'HEAD') { drain(req); res.writeHead(405); return res.end(); }
    return sendJson(res, 200, { ok: true, sources: SOURCES.list() });
  }
  const m = /^\/api\/source\/(sr[a-f0-9]{30})(?:\/(part|finish|video|strip|song|drop|render|follow))?$/.exec(urlPath);
  if (!m) { drain(req); return fail(res, 404, 'gone'); }
  const s = SOURCES.get(m[1]);
  const action = m[2] || '';
  if (!s) { drain(req); return fail(res, 404, 'gone'); }

  if (req.method === 'GET' || req.method === 'HEAD') {
    if (action === '') return sendJson(res, 200, Object.assign({ ok: true }, SOURCES.view(s), { song: SONGHUNT.view(s) }));
    if (action === 'video') {
      if (s.state !== 'ready') { res.writeHead(404); return res.end('gone'); }
      return serveMedia(req, res, s.file, s.bytes, { inline: true, mime: s.mime });
    }
    if (action === 'strip') {
      if (s.state !== 'ready' || !s.strip || !s.dir) return sendJson(res, 404, { ok: false, code: 'notyet' });
      const fp = path.join(s.dir, 'strip.jpg');
      let st;
      try { st = fs.statSync(fp); } catch { return sendJson(res, 404, { ok: false, code: 'notyet' }); }
      res.writeHead(200, { 'Content-Type': 'image/jpeg', 'Content-Length': st.size, 'Cache-Control': 'no-store' });
      if (req.method === 'HEAD') return res.end();
      const rs = fs.createReadStream(fp);
      rs.on('error', () => { try { res.destroy(); } catch { /* raced */ } });
      return rs.pipe(res);
    }
    if (action === 'song') return sendJson(res, 200, Object.assign({ ok: true }, SONGHUNT.view(s)));
    res.writeHead(405); return res.end();
  }
  if (req.method !== 'POST') { drain(req); res.writeHead(405); return res.end(); }

  if (action === 'part') {
    const ct = String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
    if (ct !== 'application/octet-stream') { req.resume(); return fail(res, 415, 'badrequest'); }
    if (!diskOk()) { req.resume(); return fail(res, 503, 'diskfull'); }
    const r = await SOURCES.part(s, req, req.headers['x-part-offset'], req.headers['content-length']);
    if (!r.ok) return fail(res, r.status || 400, r.code);
    return sendJson(res, 200, { ok: true, bytes: r.bytes });
  }
  if (action === 'finish') {
    req.resume();
    const r = await SOURCES.finish(s, ffEnv());
    if (!r.ok) return fail(res, r.code === 'gone' ? 404 : r.code === 'busy' ? 409 : 400, r.code);
    return sendJson(res, 200, { ok: true, source: r.meta });
  }
  if (action === 'drop') { req.resume(); SOURCES.drop(s); return sendJson(res, 200, { ok: true }); }

  const b = await jsonBody(req, res); if (!b) return;
  if (s.state !== 'ready') return fail(res, 404, 'gone');
  SOURCES.touch(s);

  if (action === 'song') {
    if (!hit('song', 30, 10 * 60_000)) return fail(res, 429, 'ratelimit');
    const out = await SONGHUNT.manual(s, b);
    if (!out.ok) return fail(res, out.code === 'ratelimit' ? 429 : 400, out.code);
    return sendJson(res, 200, Object.assign({ ok: true }, out.song));
  }

  if (!FFMPEG) return fail(res, 503, 'noffmpeg');
  if (!diskOk()) return fail(res, 503, 'diskfull');
  if (queue.length >= LIM.queueMax) return fail(res, 503, 'busy');

  if (action === 'follow') {
    if (!FOLLOW || !FOLLOW.available()) return fail(res, 503, 'nofollow');
    if (!canBurn()) return fail(res, 503, 'noburn');
    const range = CLIP.validRange(b, s.meta.dur, LIM.maxFollowSeconds);
    if (!range.ok) {
      const asked = Number(b.end) - Number(b.start);
      return fail(res, 400, Number.isFinite(asked) && asked > LIM.maxFollowSeconds ? 'followlong' : 'badclip');
    }
    const j = newJob('follow', s.name + ' (follow ' + CLIP.rangeTag(range.start, range.end) + ')', async (job) => {
      const prep = await FOLLOW.prepare(job, s.file, range, ffEnv());
      if (job.cancelled) return { ok: false, code: 'cancelled' };
      if (!prep.ok) return { ok: false, code: 'renderfail' };
      job.follow = prep.meta;
      return { ok: true, file: prep.file, size: prep.size, ext: 'mp4', name: job.title };
    }, { sourceId: s.id });
    return sendJson(res, 200, { ok: true, id: j.id, position: positionOf(j.id) });
  }

  // render: cut (video or audio), gif, or reframe
  const tool = ['cut', 'gif', 'reframe'].includes(b.tool) ? b.tool : '';
  if (!tool) return fail(res, 400, 'badrequest');
  const kind = tool === 'gif' ? 'gif' : tool === 'cut' && b.output === 'audio' ? 'audio' : 'video';
  if (kind === 'audio' && !s.meta.audio) return fail(res, 400, 'noaudio');
  const range = CLIP.validRange(b, s.meta.dur, kind === 'gif' ? LIM.maxGifSeconds : LIM.maxClipSeconds);
  if (!range.ok) return fail(res, 400, 'badclip');
  const nw = normWords(s, b, range, kind);
  if (!nw.ok) return fail(res, nw.code === 'noburn' || nw.code === 'nolisten' ? 503 : 400, nw.code);
  const words = nw.words;
  const audioFormat = CLIP.AUDIO_FORMATS.includes(b.audioFormat) ? b.audioFormat : 'mp3';
  const rf = tool === 'reframe' ? SOURCES.normReframe(s, b, range) : null;
  const tag = tool === 'reframe' ? SOURCES.ratioTag(rf.opts.ratio) : tool === 'gif' ? '(GIF ' + CLIP.rangeTag(range.start, range.end) + ')' : '(clip ' + CLIP.rangeTag(range.start, range.end) + ')';
  const title = s.name + ' ' + tag;
  const j = newJob(tool, title, async (job) => {
    s.rendering++;
    try {
      let burn = false;
      if (words) {
        burn = await makeWords(job, s, range, words);
        if (job.cancelled) return { ok: false, code: 'cancelled' };
        if (!burn && words.mode === 'typed') return { ok: false, code: 'notext' };
      }
      job.stage = 'rendering';
      job.percent = 0;
      const onProgress = (pct) => { job.percent = pct; };
      if (tool === 'reframe') {
        const o = Object.assign({}, rf.opts, { burn, subStyle: words ? words.style : rf.opts.subStyle });
        return await SOURCES.renderReframe(s, o, job, ffEnv(), onProgress);
      }
      const ext = CLIP.outExt(kind, audioFormat);
      const out = path.join(job.dir, 'render.' + ext);
      const args = CLIP.buildClipArgs({
        src: s.file, out, kind, start: range.start, len: range.len, audioFormat,
        gifWidth: b.gifWidth, mute: b.mute === true,
        subStyle: words ? words.style : null, subFilter: burn ? SUBS.subtitleFilter(kind, words.style) : '',
      });
      const c = await CLIP.runClip(FFMPEG, args, range.len, ffEnv(), job, onProgress, job.dir);
      let size = 0;
      try { size = fs.statSync(out).size; } catch { size = 0; }
      if (c.code !== 0 || size <= 0) return { ok: false, code: job.cancelled ? 'cancelled' : 'renderfail' };
      return { ok: true, file: out, size, ext };
    } finally { s.rendering = Math.max(0, s.rendering - 1); }
  }, { sourceId: s.id });
  return sendJson(res, 200, { ok: true, id: j.id, position: positionOf(j.id) });
}

async function followRoute(req, res, j, action) {
  if (!j || j.kind !== 'follow' || !j.follow || j.state !== 'ready') { drain(req); return fail(res, 404, 'gone'); }
  if (action === 'video') {
    if (req.method !== 'GET' && req.method !== 'HEAD') { drain(req); res.writeHead(405); return res.end(); }
    return serveMedia(req, res, j.file, j.size, { inline: true, mime: 'video/mp4' });
  }
  if (action === 'track' && (req.method === 'GET' || req.method === 'HEAD')) return sendJson(res, 200, FOLLOW.trackView(j));
  if (req.method !== 'POST') { drain(req); res.writeHead(405); return res.end(); }
  const b = await jsonBody(req, res); if (!b) return;
  if (!j.follow || j.state !== 'ready' || !j.dir) return fail(res, 404, 'gone');
  reapLater(j, FOLLOW_TTL_MS);    // every use pushes the session's expiry out again
  const status = (code) => (code === 'followbusy' || code === 'nofollow' || code === 'warming' ? 503 : code === 'busy' ? 429 : code === 'gone' ? 404 : 400);

  if (action === 'seg') {
    if (!hit('seg', 240, 10 * 60_000)) return fail(res, 429, 'ratelimit');
    const out = await FOLLOW.seg(j, b, { gone: () => res.destroyed || !!(req.socket && req.socket.destroyed) });
    if (!out.ok) return fail(res, status(out.code), out.code || 'trackfail');
    return sendJson(res, 200, out);
  }
  if (action === 'track') {
    const out = await FOLLOW.track(j, b);
    if (!out.ok) return fail(res, status(out.code), out.code || 'trackfail');
    return sendJson(res, 200, { ok: true });
  }
  // render: a new ordinary job whose file is the clip with the text burned in
  const pre = FOLLOW.precheckRender(j, b, LIM.maxGifSeconds);
  if (!pre.ok) return fail(res, 400, pre.code);
  if (!diskOk()) return fail(res, 503, 'diskfull');
  if (queue.length >= LIM.queueMax) return fail(res, 503, 'busy');
  const kind = b.kind === 'gif' ? 'gif' : 'video';
  const session = j;
  const o = newJob('followrender', session.title.replace(/\(follow /, '(followed ') + (kind === 'gif' ? ' GIF' : ''), async (job) => {
    job.stage = 'rendering';
    return FOLLOW.render(session, b, job, ffEnv(), (pct) => { job.percent = pct; }, LIM.maxGifSeconds);
  });
  return sendJson(res, 200, { ok: true, id: o.id, position: positionOf(o.id) });
}

async function linkRoute(req, res, urlPath) {
  if (req.method !== 'POST') { drain(req); res.writeHead(405); return res.end(); }
  if (!cfg.linkImport.enabled) { req.resume(); return fail(res, 403, 'linkoff'); }
  if (!LINKIMP) { req.resume(); return fail(res, 503, 'noengine'); }
  const b = await jsonBody(req, res); if (!b) return;
  if (urlPath === '/api/link/info') {
    if (!hit('info', 60, 10 * 60_000)) return fail(res, 429, 'ratelimit');
    const u = LINK.validUrl(b.u);
    if (!u) return fail(res, 400, 'badurl');
    if (!await LINK.hostResolvesPublic(u)) return fail(res, 400, 'private_addr');
    const info = await LINKIMP.probe(u);
    if (!info.ok) return fail(res, info.code === 'busy' ? 429 : 400, info.code || 'unknown');
    return sendJson(res, 200, info);
  }
  if (urlPath === '/api/link/import') {
    if (!hit('import', 30, 60 * 60_000)) return fail(res, 429, 'ratelimit');
    const u = LINK.validUrl(b.url);
    if (!u) return fail(res, 400, 'badurl');
    if (!await LINK.hostResolvesPublic(u)) return fail(res, 400, 'private_addr');
    if (!diskOk()) return fail(res, 503, 'diskfull');
    if (queue.length >= LIM.queueMax) return fail(res, 503, 'busy');
    const mode = LINK.MODES.has(b.mode) ? b.mode : 'studio';
    const job = newJob('import', 'import', async (jb) => {
      const r = await LINKIMP.download(jb);
      if (!r.ok) return r;
      jb.title = r.title;
      if (mode !== 'studio') return { ok: true, file: r.file, size: r.size, ext: r.ext, name: r.title };
      jb.stage = 'opening';
      const a = await SOURCES.adopt(r.file, r.title, crypto.randomBytes(16), ffEnv(), { captionsFile: r.captionsFile, captionsLabel: r.captionsLabel, songHint: r.song ? { artist: r.song.artist, track: r.song.track } : null });
      if (!a.ok) return a;
      return { ok: true, source: a.src.id };
    }, {
      url: u, mode,
      quality: LINK.QUALITIES.has(String(b.quality)) ? String(b.quality) : 'best',
      audioFormat: LINK.AUDIO.has(b.audioFormat) ? b.audioFormat : 'mp3',
      subLang: mode === 'studio' && SUBS.validLang(b.subs) ? b.subs : '',
    });
    return sendJson(res, 200, { ok: true, id: job.id, position: positionOf(job.id) });
  }
  return fail(res, 404, 'gone');
}

let lastDetect = 0;
const server = http.createServer(async (req, res) => {
  secHeaders(res);
  res.on('error', () => { /* client vanished */ });
  const qi = req.url.indexOf('?');
  const urlPath = qi >= 0 ? req.url.slice(0, qi) : req.url;
  const ip = clientIp(req);

  try {
    if (urlPath === '/healthz') { res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' }); return res.end('ok'); }

    // ---- above the wall: the lock screen and what it needs ----
    if (urlPath === '/api/auth') {
      if (req.method !== 'POST') { drain(req); res.writeHead(405); return res.end(); }
      if (!sameOrigin(req)) { req.resume(); return fail(res, 403, 'badrequest'); }
      if (locked(ip)) { req.resume(); return sendJson(res, 429, { ok: false, error: 'locked' }); }
      const b = await jsonBody(req, res); if (!b) return;
      const pass = typeof b.passcode === 'string' ? b.passcode.slice(0, 200) : '';
      if (pass && safeEq(pass, PASSCODE)) { setSession(req, res, SESSION, 60 * 60 * 24 * 30); noteSuccess(ip); return sendJson(res, 200, { ok: true }); }
      noteFail(ip);
      return sendJson(res, 401, { ok: false, error: 'denied' });
    }
    if (urlPath === '/api/logout' && req.method === 'POST') {
      req.resume();
      if (!sameOrigin(req)) return fail(res, 403, 'badrequest');
      setSession(req, res, '', 0);
      return sendJson(res, 200, { ok: true });
    }
    if ((req.method === 'GET' || req.method === 'HEAD') && isOpenAsset(urlPath)) return serveStatic(req, res, urlPath);

    // ---- the wall ----
    if (!isAuthed(req)) {
      drain(req);
      if (urlPath.startsWith('/api/')) return sendJson(res, 401, { ok: false, code: 'auth', error: 'Locked.' });
      res.writeHead(302, { Location: '/gate.html', 'Cache-Control': 'no-store' });
      return res.end();
    }

    if (urlPath.startsWith('/api/')) {
      if (req.method === 'POST' && !sameOrigin(req)) { req.resume(); return fail(res, 403, 'badrequest'); }

      if (urlPath === '/api/state' && (req.method === 'GET' || req.method === 'HEAD')) return sendJson(res, 200, statePayload());
      if (urlPath === '/api/engines/check' && req.method === 'POST') {
        req.resume();
        if (Date.now() - lastDetect > 10_000) { lastDetect = Date.now(); await detect(); }
        return sendJson(res, 200, statePayload());
      }
      if (urlPath === '/api/upload' || urlPath === '/api/sources' || urlPath.startsWith('/api/source/')) return sourceRoute(req, res, urlPath);
      if (urlPath.startsWith('/api/link/')) return linkRoute(req, res, urlPath);

      let m = /^\/api\/job\/([a-f0-9]{32})(?:\/(cancel|file|preview))?$/.exec(urlPath);
      if (m) {
        const j = jobs.get(m[1]);
        const action = m[2] || '';
        if (!action && (req.method === 'GET' || req.method === 'HEAD')) return j ? sendJson(res, 200, jobView(j)) : sendJson(res, 404, { ok: false, state: 'gone', code: 'gone', error: errText('gone') });
        if (action === 'cancel' && req.method === 'POST') { req.resume(); if (j) cancelJob(j); return sendJson(res, 200, { ok: true }); }
        if ((action === 'file' || action === 'preview') && (req.method === 'GET' || req.method === 'HEAD')) {
          // a follow session's clip is only ever previewed through /api/follow, never handed out as a file
          if (!j || j.state !== 'ready' || !j.file || j.kind === 'follow') { res.writeHead(404); return res.end('gone'); }
          return serveMedia(req, res, j.file, j.size, action === 'preview' ? { inline: true, mime: MEDIA_MIME[j.ext] || 'application/octet-stream' } : { name: j.name });
        }
        drain(req); res.writeHead(405); return res.end();
      }
      m = /^\/api\/follow\/([a-f0-9]{32})\/(video|seg|track|render)$/.exec(urlPath);
      if (m) return followRoute(req, res, jobs.get(m[1]), m[2]);
      drain(req);
      return fail(res, 404, 'gone');
    }

    if (req.method !== 'GET' && req.method !== 'HEAD') { drain(req); res.writeHead(405); return res.end(); }
    return serveStatic(req, res, urlPath);
  } catch (e) {
    if (!res.headersSent) return fail(res, 500, 'unknown');
    try { res.end(); } catch { /* raced */ }
  }
});
server.on('clientError', (err, sock) => { try { sock.destroy(); } catch { /* gone */ } });
server.headersTimeout = 30_000;
server.requestTimeout = 120_000;

/* ================================================================== *
 * Boot
 * ================================================================== */

async function boot() {
  setupSecrets();
  fs.mkdirSync(WORK_DIR, { recursive: true });
  await detect();
  FFMPEG = FOUND.ffmpeg.ok ? FOUND.ffmpeg.exe : '';
  SONGHUNT = createSongHunt({ key: cfg.songId.acoustidKey, ffmpeg: PROC.resolveExe(cfg.songId.ffmpeg, []) || FFMPEG });
  songCaps = await SONGHUNT.capabilities();
  SOURCES = createSources({ FFMPEG, WORK_DIR, runClip: CLIP.runClip, songhunt: SONGHUNT, limits: LIM });
  LISTEN = createListen({ python: FOUND.listen.python, model: cfg.listen.model, threads: cfg.listen.threads, ready: FOUND.listen.ok });
  FOLLOW = createFollow({ FFMPEG, WORK_DIR, python: FOUND.tracker.python, checkpoints: cfg.tracker.checkpoints, model: cfg.tracker.model, gpuGuard: cfg.tracker.gpuGuard, worker: cfg.tracker.worker, ready: FOUND.tracker.ok });

  if (cfg.linkImport.enabled) {
    // The guard starts before the engine is ever allowed to run, and the engine never runs without it.
    egress = EGRESS.createEgressProxy();
    await egress.start();
    if (FOUND.ytdlp.ok) {
      const cacheDir = path.join(WORK_DIR, 'cache');
      fs.mkdirSync(cacheDir, { recursive: true });
      LINKIMP = LINK.createLinkImport({ ytdlp: FOUND.ytdlp.exe, ffmpeg: FFMPEG, cacheDir, egress, limits: LIM });
    }
  }
  sweepWork();

  server.listen(cfg.port, cfg.host, () => {
    console.log('[flicker] open http://' + (cfg.host === '0.0.0.0' ? 'localhost' : cfg.host) + ':' + cfg.port);
    const e = FOUND;
    console.log('[flicker] ffmpeg: ' + (e.ffmpeg.ok ? 'ok' : 'NOT FOUND, renders are off') +
      ' | words burn: ' + (e.ffmpeg.burn ? 'ok' : 'off') +
      ' | speech to text: ' + (e.listen.ok ? 'ok' : 'off') +
      ' | text follow: ' + (e.tracker.ok ? 'ok' : 'off') +
      ' | link import: ' + (cfg.linkImport.enabled ? (e.ytdlp.ok ? 'on' : 'on, yt-dlp missing') : 'off'));
  });

  setInterval(sweepWork, SWEEP_MS).unref();
  setInterval(() => { if (SOURCES) SOURCES.sweep(); }, 60_000).unref();
  setInterval(() => { const now = Date.now(); for (const [k, arr] of buckets) if (!arr.some((t) => now - t < 3600_000)) buckets.delete(k); }, SWEEP_MS).unref();
}

function shutdown() {
  for (const j of jobs.values()) if (j.proc) PROC.killTree(j.proc);
  if (FOLLOW) FOLLOW.shutdown();
  try { server.close(); } catch { /* already down */ }
  if (egress) egress.stop().catch(() => {});
  setTimeout(() => process.exit(0), 200).unref();
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
process.on('uncaughtException', (e) => { console.log('[flicker] uncaught: ' + String(e && e.message).slice(0, 200)); });
process.on('unhandledRejection', () => { /* a failed render must never take the app down */ });

if (require.main === module) {
  boot().catch((e) => { console.log('[flicker] boot failed: ' + String(e && e.message).slice(0, 200)); process.exit(1); });
}

module.exports = { safeSegment, disposition, CSP, errText };
