'use strict';
//
// What this machine can do, found at boot (and again when you tap "Check again").
//
// Flicker needs Node and ffmpeg. Everything else is optional and switched on only when found:
//   yt-dlp          link import (and only when you turn link import on in config)
//   faster-whisper  words heard from the audio (and lyrics lined up with the audio)
//   SAM 2.1         text follow (tracking on an NVIDIA GPU)
// Nothing is downloaded or installed by the app. The page shows what is missing and how to add it.

const PROC = require('./proc');
const { SCRIPT: TRANSCRIBE_PY } = require('./listen');
const { TRACK_PY } = require('./follow');

const firstLine = (s) => String(s || '').split(/\r?\n/)[0].trim();

async function detectFfmpeg(cfg) {
  const exe = PROC.resolveExe(cfg.ffmpeg, ['ffmpeg']);
  if (!exe) return { ok: false, exe: '', version: '', burn: false };
  const v = await PROC.probeExe(exe, ['-hide_banner', '-version'], 15_000);
  if (!v.ok) return { ok: false, exe: '', version: '', burn: false };
  const m = /ffmpeg version (\S+)/.exec(v.out);
  // Burned in words and follow text need libass (the subtitles and ass filters).
  const f = await PROC.probeExe(exe, ['-hide_banner', '-filters'], 15_000);
  const burn = /\bsubtitles\b/.test(f.out) && /\bass\b/.test(f.out);
  const x264 = /--enable-libx264/.test(v.out) || /libx264/.test((await PROC.probeExe(exe, ['-hide_banner', '-encoders'], 15_000)).out);
  return { ok: x264, exe, version: m ? m[1].slice(0, 40) : 'found', burn, x264 };
}

async function detectYtdlp(cfg) {
  const exe = PROC.resolveExe(cfg.linkImport.ytdlp, ['yt-dlp']);
  if (!exe) return { ok: false, exe: '', version: '' };
  const v = await PROC.probeExe(exe, ['--ignore-config', '--version'], 30_000);
  const ver = firstLine(v.out);
  if (!v.ok || !/^\d{4}\.\d{2}\.\d{2}/.test(ver)) return { ok: false, exe: '', version: '' };
  return { ok: true, exe, version: ver.slice(0, 24) };
}

// The first Python that answers, from the configured one or the usual names.
function pythonCandidates(configured) {
  if (configured) return [configured];
  return process.platform === 'win32' ? ['python', 'py', 'python3'] : ['python3', 'python'];
}

async function runPy(exe, args, env) {
  return new Promise((resolve) => {
    require('child_process').execFile(exe, args, { windowsHide: true, timeout: 120_000, env: Object.assign({}, process.env, env || {}), maxBuffer: 1024 * 1024 },
      (e, so) => {
        const line = String(so || '').trim().split(/\r?\n/).pop() || '';
        try { resolve(JSON.parse(line)); } catch { resolve(null); }
      });
  });
}

async function detectListen(cfg) {
  for (const name of pythonCandidates(cfg.listen.python)) {
    const exe = PROC.which(name);
    if (!exe) continue;
    const r = await runPy(exe, [TRANSCRIBE_PY, '--check', cfg.listen.model], { HF_HUB_OFFLINE: '1', PYTHONIOENCODING: 'utf-8' });
    if (!r) continue;                                      // not a working Python (or the Windows store stub)
    if (r.ok) return { ok: true, python: exe, model: cfg.listen.model, why: '' };
    return { ok: false, python: exe, model: cfg.listen.model, why: r.missing && r.missing.length ? 'package' : 'model' };
  }
  return { ok: false, python: '', model: cfg.listen.model, why: 'python' };
}

async function detectTracker(cfg) {
  const t = cfg.tracker;
  if (!t.python) return { ok: false, python: '', why: 'unset' };
  const exe = PROC.which(t.python);
  if (!exe) return { ok: false, python: '', why: 'python' };
  const r = await runPy(exe, [t.worker || TRACK_PY, '--check'], { FLICKER_TRACK_CKPT: t.checkpoints || '', FLICKER_TRACK_MODEL: t.model });
  if (!r) return { ok: false, python: exe, why: 'python' };
  if (r.ok) return { ok: true, python: exe, why: '' };
  const why = r.missing && r.missing.length ? 'package' : !r.cuda ? 'cuda' : 'checkpoint';
  return { ok: false, python: exe, why, missing: (r.missing || []).slice(0, 4) };
}

async function detectAll(cfg) {
  const [ffmpeg, ytdlp, listen, tracker] = await Promise.all([detectFfmpeg(cfg), detectYtdlp(cfg), detectListen(cfg), detectTracker(cfg)]);
  return { ffmpeg, ytdlp, listen, tracker, at: Date.now() };
}

// What the page is told. No paths: only what works, and how to fix what does not.
function publicView(found, cfg, extra) {
  const f = found.ffmpeg, y = found.ytdlp, l = found.listen, t = found.tracker;
  const listenHelp = {
    python: 'Install Python 3.9 or newer, then: pip install faster-whisper',
    package: 'Install the speech to text package into your Python: pip install faster-whisper',
    model: 'Download the "' + cfg.listen.model + '" model once while online: python -c "from faster_whisper import WhisperModel; WhisperModel(\'' + cfg.listen.model + '\')"',
  };
  const trackHelp = {
    unset: 'Point tracker.python and tracker.checkpoints in config.json at a Python with PyTorch (CUDA), SAM 2 (from the facebookresearch/sam2 project), opencv-python and numpy, and a folder holding sam2.1_hiera_base_plus.pt.',
    python: 'tracker.python in config.json does not point at a working Python.',
    package: 'That Python is missing: ' + ((t.missing || []).join(', ') || 'a package') + '. Install PyTorch with CUDA, SAM 2, opencv-python and numpy into it.',
    cuda: 'That Python has PyTorch but cannot see a CUDA GPU. Text follow needs an NVIDIA graphics card and the CUDA build of PyTorch.',
    checkpoint: 'The SAM 2.1 checkpoint was not found. Put sam2.1_hiera_' + (cfg.tracker.model === 'small' ? 'small' : 'base_plus') + '.pt in the folder named by tracker.checkpoints.',
  };
  return {
    ffmpeg: {
      ok: f.ok, version: f.version, burn: !!f.burn,
      help: f.ok ? (f.burn ? '' : 'This ffmpeg has no libass, so words and follow text cannot be burned in. Most full builds include it.')
        : 'Install ffmpeg and make sure it is on PATH (or set "ffmpeg" in config.json). Windows: winget install Gyan.FFmpeg. macOS: brew install ffmpeg. Linux: your package manager.',
    },
    linkImport: {
      enabled: !!cfg.linkImport.enabled, ok: !!cfg.linkImport.enabled && y.ok, engine: y.ok ? y.version : '',
      help: !cfg.linkImport.enabled ? 'Off. Turn it on in config.json (linkImport.enabled). You are responsible for what you download.'
        : y.ok ? '' : 'yt-dlp was not found. Install it (pip install yt-dlp, or your package manager) and keep it updated.',
    },
    listen: { ok: l.ok, model: l.model, help: l.ok ? '' : listenHelp[l.why] || listenHelp.python },
    follow: { ok: t.ok, help: t.ok ? '' : trackHelp[t.why] || trackHelp.unset },
    lyrics: { ok: !!(extra && extra.lyrics), help: extra && extra.lyrics ? '' : 'Lyrics lookup is switched off in config.json (lyrics.enabled).' },
    songId: { ok: !!(extra && extra.fingerprint), help: extra && extra.fingerprint ? '' : 'Optional. Add a free AcoustID application key (songId.acoustidKey) and an ffmpeg with chromaprint (songId.ffmpeg) to name songs from their audio.' },
  };
}

module.exports = { detectAll, detectFfmpeg, detectYtdlp, detectListen, detectTracker, publicView, TRACK_PY, TRANSCRIBE_PY };
