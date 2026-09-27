'use strict';
//
// Flicker configuration.
//
// Read once at boot from config.json (next to server.js, or the file named by FLICKER_CONFIG),
// then a few environment variables on top. Every value has a safe default, so a missing file is
// fine: the app binds to this machine only, link import stays off, and the optional helpers
// (speech to text, the tracker) are looked for on their own.

const fs = require('fs');
const path = require('path');

const APP_DIR = path.join(__dirname, '..');

const DEFAULTS = {
  port: 4480,
  host: '127.0.0.1',            // this machine only. Set to 0.0.0.0 to reach it over your own private network.
  passcode: '',                 // set one here or in FLICKER_PASS. Empty = one is made up on first run and printed.
  trustProxy: false,            // true only when a reverse proxy on this machine sets X-Forwarded-For
  dataDir: '',                  // default: ./data next to server.js
  workDir: '',                  // default: <dataDir>/work. Uploads and renders live here, and are swept.
  ffmpeg: '',                   // default: ffmpeg on PATH
  lowPriority: true,            // run ffmpeg and helpers below normal priority, so the machine stays usable
  ffmpegThreads: 0,             // 0 lets ffmpeg decide; 2 or 4 keeps a busy machine responsive

  limits: {
    maxUploadMB: 4096,          // one video
    maxSourceMinutes: 240,      // longest video accepted
    maxClipSeconds: 600,        // longest cut, audio clip or reframe
    maxGifSeconds: 20,          // GIFs balloon fast
    maxFollowSeconds: 60,       // text follow clips (tracking is the heavy part)
    maxListenSeconds: 180,      // speech to text runs on the CPU
    openSources: 20,            // videos open in the studio at once
    concurrentRenders: 2,
    queueMax: 20,
    sourceHours: 6,             // an open video is kept this long after its last use
    fileMinutes: 60,            // a finished render can be saved for this long
    workCapGB: 40,              // refuse new work when the work dir holds more than this
    minFreeGB: 2,               // ... or the disk has less than this free
  },

  // Optional: import from a link with yt-dlp. OFF by default.
  linkImport: {
    enabled: false,
    ytdlp: '',                  // default: yt-dlp on PATH
    refuseHosts: [],            // your own domains, so a link can never make the engine fetch them
  },

  // Optional: speech to text for burned in words (faster-whisper, runs on the CPU, offline).
  listen: {
    python: '',                 // default: python3, python, then py on PATH
    model: 'small',
    threads: 4,
  },

  // Optional: the lyrics lookup (one request per song name to a public lyrics service).
  lyrics: { enabled: true },

  // Optional: name a song from its audio (needs a free AcoustID application key and an ffmpeg with chromaprint).
  songId: { acoustidKey: '', ffmpeg: '' },

  // Optional: text follow (SAM 2.1 on an NVIDIA GPU).
  tracker: {
    python: '',                 // a python that has torch (CUDA), sam2, opencv and numpy
    checkpoints: '',            // folder holding sam2.1_hiera_base_plus.pt (or _small.pt)
    model: 'base_plus',         // base_plus or small
    gpuGuard: true,             // give the card back when something else (a game) is using it
    worker: '',                 // optional: a custom tracker script speaking the same protocol as py/track.py
  },
};

function merge(base, over) {
  const out = Array.isArray(base) ? base.slice() : Object.assign({}, base);
  if (!over || typeof over !== 'object' || Array.isArray(over)) return out;
  for (const k of Object.keys(over)) {
    if (k.startsWith('_')) continue;                 // "_note" style comments in the file
    const b = base ? base[k] : undefined;
    const v = over[k];
    if (b && typeof b === 'object' && !Array.isArray(b) && v && typeof v === 'object' && !Array.isArray(v)) out[k] = merge(b, v);
    else if (v !== undefined && v !== null) out[k] = v;
  }
  return out;
}

const num = (v, lo, hi, dflt) => { const n = Number(v); return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : dflt; };
const str = (v) => (typeof v === 'string' ? v.trim() : '');

function load() {
  const file = process.env.FLICKER_CONFIG ? path.resolve(process.env.FLICKER_CONFIG) : path.join(APP_DIR, 'config.json');
  let raw = {};
  let fileNote = 'none';
  try {
    raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    fileNote = 'loaded';
  } catch (e) {
    if (e && e.code !== 'ENOENT') { fileNote = 'unreadable'; console.log('[flicker] config file could not be read, using defaults: ' + String(e.message).slice(0, 120)); }
  }
  const c = merge(DEFAULTS, raw);

  if (process.env.PORT) c.port = process.env.PORT;
  if (process.env.FLICKER_HOST) c.host = process.env.FLICKER_HOST;
  if (process.env.FLICKER_PASS) c.passcode = process.env.FLICKER_PASS;
  if (process.env.FLICKER_DATA_DIR) c.dataDir = process.env.FLICKER_DATA_DIR;
  if (process.env.FLICKER_WORK_DIR) c.workDir = process.env.FLICKER_WORK_DIR;

  c.port = Math.round(num(c.port, 1, 65535, DEFAULTS.port));
  c.host = str(c.host) || DEFAULTS.host;
  c.passcode = typeof c.passcode === 'string' ? c.passcode : String(c.passcode || '');
  c.trustProxy = c.trustProxy === true;
  c.lowPriority = c.lowPriority !== false;
  c.ffmpegThreads = Math.round(num(c.ffmpegThreads, 0, 64, 0));
  c.dataDir = str(c.dataDir) ? path.resolve(APP_DIR, c.dataDir) : path.join(APP_DIR, 'data');
  c.workDir = str(c.workDir) ? path.resolve(APP_DIR, c.workDir) : path.join(c.dataDir, 'work');
  c.ffmpeg = str(c.ffmpeg);

  const L = c.limits, D = DEFAULTS.limits;
  L.maxUploadMB = num(L.maxUploadMB, 1, 1024 * 64, D.maxUploadMB);
  L.maxSourceMinutes = num(L.maxSourceMinutes, 1, 24 * 60, D.maxSourceMinutes);
  L.maxClipSeconds = num(L.maxClipSeconds, 1, 4 * 3600, D.maxClipSeconds);
  L.maxGifSeconds = num(L.maxGifSeconds, 1, 60, D.maxGifSeconds);
  L.maxFollowSeconds = num(L.maxFollowSeconds, 2, 120, D.maxFollowSeconds);
  L.maxListenSeconds = num(L.maxListenSeconds, 5, 1800, D.maxListenSeconds);
  L.openSources = Math.round(num(L.openSources, 1, 200, D.openSources));
  L.concurrentRenders = Math.round(num(L.concurrentRenders, 1, 16, D.concurrentRenders));
  L.queueMax = Math.round(num(L.queueMax, 1, 500, D.queueMax));
  L.sourceHours = num(L.sourceHours, 0.1, 24 * 14, D.sourceHours);
  L.fileMinutes = num(L.fileMinutes, 1, 24 * 60, D.fileMinutes);
  L.workCapGB = num(L.workCapGB, 1, 100000, D.workCapGB);
  L.minFreeGB = num(L.minFreeGB, 0, 100000, D.minFreeGB);

  const LI = c.linkImport;
  LI.enabled = LI.enabled === true;
  LI.ytdlp = str(LI.ytdlp);
  LI.refuseHosts = (Array.isArray(LI.refuseHosts) ? LI.refuseHosts : []).map(str).filter(Boolean).slice(0, 200);

  c.listen.python = str(c.listen.python);
  c.listen.model = /^[A-Za-z0-9._\/-]{1,80}$/.test(str(c.listen.model)) ? str(c.listen.model) : DEFAULTS.listen.model;
  c.listen.threads = Math.round(num(c.listen.threads, 1, 16, DEFAULTS.listen.threads));
  c.lyrics.enabled = c.lyrics.enabled !== false;
  c.songId.acoustidKey = str(c.songId.acoustidKey || process.env.FLICKER_ACOUSTID_KEY || '');
  c.songId.ffmpeg = str(c.songId.ffmpeg);
  c.tracker.python = str(c.tracker.python);
  c.tracker.checkpoints = str(c.tracker.checkpoints) ? path.resolve(APP_DIR, str(c.tracker.checkpoints)) : '';
  c.tracker.model = c.tracker.model === 'small' ? 'small' : 'base_plus';
  c.tracker.gpuGuard = c.tracker.gpuGuard !== false;
  c.tracker.worker = str(c.tracker.worker) ? path.resolve(APP_DIR, str(c.tracker.worker)) : '';

  c.appDir = APP_DIR;
  c.configFile = file;
  c.configNote = fileNote;
  return c;
}

module.exports = { load, DEFAULTS, APP_DIR };
