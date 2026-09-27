// Runtime configuration. Environment variables win, then an optional
// config.json next to server.js (copy config.example.json), then defaults.
// Nothing here points outside the app folder unless you tell it to.
const fs = require('fs');
const os = require('os');
const path = require('path');

const APP_DIR = path.resolve(__dirname, '..');

let file = {};
try { file = JSON.parse(fs.readFileSync(path.join(APP_DIR, 'config.json'), 'utf8')); }
catch (e) { if (e.code !== 'ENOENT') console.warn('config.json ignored:', e.message); }
const eng = file.engines || {};

function pick(envNames, fileVal, def) {
  for (const n of [].concat(envNames)) if (process.env[n]) return process.env[n];
  return (fileVal !== undefined && fileVal !== null && fileVal !== '') ? fileVal : def;
}

const DATA_DIR = path.resolve(APP_DIR, String(pick('FORGE_DATA', file.dataDir, 'data')));
const OUT_DIR = path.resolve(APP_DIR, String(pick('FORGE_OUT', file.outDir, path.join(DATA_DIR, 'out'))));

// Folders Forge may read from or write to on your behalf. Everything a
// browser sends (source files, output paths, folders to browse) must resolve
// inside one of these. Default: your home folder + Forge's own out/inbox.
let ROOTS = process.env.FORGE_ROOTS
  ? process.env.FORGE_ROOTS.split(path.delimiter).map(s => s.trim()).filter(Boolean)
  : (Array.isArray(file.roots) && file.roots.length ? file.roots.map(String) : [os.homedir(), OUT_DIR, path.join(DATA_DIR, 'inbox')]);
// Forge's own output and inbox are always usable.
ROOTS = [...ROOTS, OUT_DIR, path.join(DATA_DIR, 'inbox')];

module.exports = {
  APP_DIR,
  ROOTS,
  // Largest single upload accepted (bytes). Default 8 GiB.
  MAX_UPLOAD: Number(pick('FORGE_MAX_UPLOAD', file.maxUpload, 8 * 1024 ** 3)),
  // Loopback by default: Forge is a local workshop. Set FORGE_HOST=0.0.0.0
  // only if you put it behind a private mesh VPN or your own TLS proxy.
  HOST: String(pick('FORGE_HOST', file.host, '127.0.0.1')),
  PORT: parseInt(pick(['FORGE_PORT', 'PORT'], file.port, 4470), 10),
  DATA_DIR,
  OUT_DIR,
  INBOX: path.join(DATA_DIR, 'inbox'),
  PROJECTS_DIR: path.join(DATA_DIR, 'projects'),
  // Where the folder picker opens when nothing else is chosen.
  BROWSE_START: String(pick('FORGE_BROWSE_START', file.browseStart, os.homedir())).replace(/\\/g, '/'),
  // Optional explicit engine paths. Empty means "find it on PATH".
  ENGINE_PATHS: {
    ffmpeg: pick('FORGE_FFMPEG', eng.ffmpeg, ''),
    ffprobe: pick('FORGE_FFPROBE', eng.ffprobe, ''),
    sevenzip: pick('FORGE_7Z', eng.sevenzip, '')
  },
  // Optional cap on ffmpeg threads per job (0 = let ffmpeg decide).
  FFMPEG_THREADS: Math.max(0, parseInt(pick('FORGE_FFMPEG_THREADS', file.ffmpegThreads, 0), 10) || 0),
  // Optional font file for editor titles. Empty means auto-detect.
  TITLE_FONT: pick('FORGE_FONT', file.titleFont, ''),
  // Optional fixed passcode. If unset, Forge asks you to choose one on first
  // run (from this machine only) and stores a salted hash in the data dir.
  PASSCODE: process.env.FORGE_PASS || ''
};
