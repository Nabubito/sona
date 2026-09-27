// Engine resolution + exec helpers. Zero external deps.
// Forge ships no binaries. It looks for ffmpeg / ffprobe / 7-Zip on PATH
// (or at an explicit path from config) and reports what it found.
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const cfg = require('./config');

const IS_WIN = process.platform === 'win32';

function isFile(p) { try { return fs.statSync(p).isFile(); } catch { return false; } }

// Pure-JS PATH lookup (no `where` / `which` subprocess, works on every OS).
function which(cmd) {
  const dirs = String(process.env.PATH || process.env.Path || '').split(path.delimiter).filter(Boolean);
  const exts = IS_WIN
    ? ['', ...String(process.env.PATHEXT || '.EXE;.CMD;.BAT;.COM').split(';').filter(Boolean)]
    : [''];
  for (const d of dirs) {
    for (const e of exts) {
      const full = path.join(d.replace(/^"|"$/g, ''), cmd + e);
      if (isFile(full)) return full;
    }
  }
  return null;
}

// configured path > PATH candidates > well-known install folders
function resolve(configured, names, extra) {
  if (configured) return isFile(configured) ? { path: configured, via: 'config' } : { path: null, via: 'config-missing', wanted: configured };
  for (const n of names) { const p = which(n); if (p) return { path: p, via: 'PATH' }; }
  for (const p of extra || []) if (p && isFile(p)) return { path: p, via: 'install folder' };
  return { path: null, via: null };
}

const programFiles = [process.env.ProgramFiles, process.env['ProgramFiles(x86)']].filter(Boolean);
const R = {
  ffmpeg: resolve(cfg.ENGINE_PATHS.ffmpeg, ['ffmpeg']),
  sevenzip: resolve(cfg.ENGINE_PATHS.sevenzip, ['7z', '7zz', '7za'],
    IS_WIN ? programFiles.map(d => path.join(d, '7-Zip', '7z.exe')) : [])
};
// ffprobe: explicit, then PATH, then next to whichever ffmpeg we found
R.ffprobe = resolve(cfg.ENGINE_PATHS.ffprobe, ['ffprobe'],
  R.ffmpeg.path ? [path.join(path.dirname(R.ffmpeg.path), IS_WIN ? 'ffprobe.exe' : 'ffprobe')] : []);

const FFMPEG = R.ffmpeg.path;
const FFPROBE = R.ffprobe.path;
const SEVENZIP = R.sevenzip.path;

// Disc pillar (mount / eject / make ISO) uses Windows' built-in
// Mount-DiskImage and IMAPI2, so it only exists on Windows.
const ISO_SCRIPT = path.join(__dirname, 'make-iso.ps1');
const POWERSHELL = IS_WIN ? (which('powershell') || which('pwsh')) : null;
const DISC_AVAILABLE = IS_WIN && !!POWERSHELL;

const OUTDIR = cfg.OUT_DIR;
const INBOX = cfg.INBOX;

function ensureDir(d) { fs.mkdirSync(d, { recursive: true }); }
ensureDir(OUTDIR); ensureDir(INBOX);

// Run an exe, collect stdout/stderr, resolve with {code, stdout, stderr}.
// stdin is closed so a tool that wants to prompt (e.g. for a password) fails
// fast instead of hanging a job forever.
function run(exe, args, opts = {}) {
  return new Promise((resolve) => {
    if (!exe) return resolve({ code: -1, stdout: '', stderr: 'engine not found' });
    const p = spawn(exe, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], ...opts });
    let out = '', err = '';
    p.stdout.on('data', d => out += d);
    p.stderr.on('data', d => err += d);
    p.on('error', e => resolve({ code: -1, stdout: out, stderr: String(e) }));
    p.on('close', code => resolve({ code, stdout: out, stderr: err }));
  });
}

// Run a PowerShell command string, return stdout (throws on nonzero).
async function runPS(script) {
  if (!POWERSHELL) throw new Error('PowerShell is not available on this system');
  const r = await run(POWERSHELL, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', script]);
  if (r.code !== 0) throw new Error(r.stderr.trim() || `powershell exit ${r.code}`);
  return r.stdout.trim();
}

// How to get each engine, per OS. Package-manager commands only.
const INSTALL = {
  ffmpeg: {
    win32: 'winget install Gyan.FFmpeg',
    darwin: 'brew install ffmpeg',
    linux: 'sudo apt install ffmpeg   (or your distro\'s package manager)'
  },
  sevenzip: {
    win32: 'winget install 7zip.7zip',
    darwin: 'brew install sevenzip',
    linux: 'sudo apt install p7zip-full   (or 7zip / p7zip on your distro)'
  }
};
function installHint(id) {
  const h = INSTALL[id]; if (!h) return '';
  return h[process.platform] || h.linux;
}

function engineStatus() {
  const e = (id, label, powers, r) => ({
    id, label, powers, present: !!r.path, via: r.via,
    note: r.via === 'config-missing' ? 'The configured path does not exist.' : '',
    install: installHint(id === 'ffprobe' ? 'ffmpeg' : id)
  });
  return {
    platform: process.platform,
    engines: [
      e('ffmpeg', 'ffmpeg', 'Media tools and the video editor', R.ffmpeg),
      e('ffprobe', 'ffprobe', 'Progress bars and editor clip info (ships with ffmpeg)', R.ffprobe),
      e('sevenzip', '7-Zip', 'Archives, and browsing or extracting disc images', R.sevenzip)
    ],
    disc: {
      available: DISC_AVAILABLE,
      reason: DISC_AVAILABLE ? '' : (IS_WIN ? 'PowerShell was not found.' : 'Mounting and building disc images use Windows-only system features.')
    },
    outdir: OUTDIR.replace(/\\/g, '/'),
    browseStart: ''   // the server picks a start folder inside the allowed roots
  };
}

// Extra output args for ffmpeg jobs (thread cap, if configured).
const FFMPEG_THREAD_ARGS = cfg.FFMPEG_THREADS ? ['-threads', String(cfg.FFMPEG_THREADS)] : [];

module.exports = {
  FFMPEG_THREAD_ARGS, SEVENZIP, FFMPEG, FFPROBE, ISO_SCRIPT, POWERSHELL, DISC_AVAILABLE, OUTDIR, INBOX, IS_WIN,
  which, run, runPS, ensureDir, engineStatus, spawn
};
