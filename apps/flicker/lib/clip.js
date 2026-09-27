'use strict';
//
// Cut a video to a range, pull the audio out of a range, or turn a range into a GIF.
//
// Two rules hold for every ffmpeg run in Flicker:
//   1. Every value that reaches a filter string is a number we clamped and printed ourselves,
//      or a constant from a table. A raw string in a filtergraph is an injection path (the
//      movie= filter reads local files).
//   2. ffmpeg only ever opens a file this app wrote, under a name this app chose, and it is
//      pinned to the file protocol. A file that is secretly a playlist cannot make it open a URL
//      or wander off into other folders.

const { spawn } = require('child_process');
const PROC = require('./proc');
const SUBS = require('./subs');

const GIF_WIDTHS = [320, 480, 640];
const GIF_FPS = 12;
const CLIP_TIMEOUT_MS = 30 * 60_000;
const AUDIO_FORMATS = ['mp3', 'm4a', 'opus'];

const clampInt = (v, lo, hi, dflt) => {
  const n = Math.round(Number(v));
  if (!Number.isFinite(n)) return dflt;
  return Math.min(hi, Math.max(lo, n));
};
// Times are kept to 0.1 s. Number() then toFixed() means only digits and one dot can
// ever reach argv, whatever the page sent.
const sec = (v) => { const n = Number(v); return (Number.isFinite(n) && n >= 0 ? Math.round(n * 10) / 10 : 0).toFixed(1); };

// Returns { ok, start, end, len } or { ok:false }. duration is the probed length in seconds.
function validRange(body, duration, maxLen) {
  if (!body || typeof body !== 'object') return { ok: false };
  const start = Number(body.start), end = Number(body.end);
  if (!Number.isFinite(start) || !Number.isFinite(end)) return { ok: false };
  const dur = Number(duration) || 0;
  if (dur <= 0) return { ok: false };
  if (start < 0 || end <= start) return { ok: false };
  if (end > dur + 0.5) return { ok: false };
  const e = Math.min(end, dur);
  const len = e - start;
  if (len < 0.5) return { ok: false };
  if (len > maxLen + 0.05) return { ok: false };
  return { ok: true, start: Number(sec(start)), end: Number(sec(e)), len: Number(sec(len)) };
}

// ffmpeg args, without the exe. -ss before -i seeks fast; re-encoding (rather than a stream
// copy) makes the cut land on the exact frame instead of the nearest keyframe.
//
// -t sits BEFORE -i on purpose, which makes it an input option: the input itself ends after
// len seconds. As an output option it only trims what is written, and palettegen cannot emit
// its palette until its input ends, so ffmpeg would decode the whole rest of the video
// (buffering frames in memory) before writing a 6 second GIF.
function buildClipArgs(o) {
  const head = ['-y', '-nostdin', '-v', 'error', '-protocol_whitelist', 'file',
    '-ss', sec(o.start), '-t', sec(o.len), '-i', o.src];
  const tail = ['-progress', 'pipe:1', '-nostats', o.out];
  // Burned in words. The filter text is NOT built here and never from a request: the only value
  // accepted is the exact constant subs.js produces, checked character for character.
  const sub = (o.subFilter && o.kind !== 'audio' && o.subFilter === SUBS.subtitleFilter(o.kind, o.subStyle)) ? o.subFilter + ',' : '';
  if (o.kind === 'gif') {
    const w = GIF_WIDTHS.includes(Number(o.gifWidth)) ? Number(o.gifWidth) : 480;
    const fps = clampInt(o.fps, 5, 20, GIF_FPS);
    return [...head, '-an',
      '-vf', sub + 'fps=' + fps + ',scale=' + w + ':-1:flags=lanczos,split[s0][s1];[s0]palettegen[p];[s1][p]paletteuse',
      '-loop', '0', ...tail];
  }
  if (o.kind === 'audio') {
    const fmt = o.audioFormat;
    const codec = fmt === 'm4a' ? ['-c:a', 'aac', '-b:a', '192k']
      : fmt === 'opus' ? ['-c:a', 'libopus', '-b:a', '128k']
      : ['-c:a', 'libmp3lame', '-q:a', '2'];
    return [...head, '-vn', ...codec, ...tail];
  }
  const audio = o.mute ? ['-an'] : ['-c:a', 'aac', '-b:a', '160k'];
  return [...head, '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-pix_fmt', 'yuv420p',
    '-vf', sub + 'scale=trunc(iw/2)*2:trunc(ih/2)*2',
    ...audio, '-movflags', '+faststart', ...tail];
}

const outExt = (kind, audioFormat) => kind === 'gif' ? 'gif' : kind === 'audio' ? (audioFormat === 'm4a' ? 'm4a' : audioFormat === 'opus' ? 'opus' : 'mp3') : 'mp4';

// config ffmpegThreads: 0 lets ffmpeg decide; a small number keeps a busy machine usable.
let THREADS = 0;
const setThreads = (n) => { const v = Math.round(Number(n)); THREADS = Number.isFinite(v) && v > 0 ? Math.min(64, v) : 0; };

// Runs one ffmpeg job. onProgress(0..99). hold.proc is set so a cancel can kill it.
// Resolves { code }.
function runClip(ffmpeg, args, lenSec, env, hold, onProgress, cwd) {
  if (THREADS) {
    // an output option, placed just before -progress (every command here has one)
    const i = args.indexOf('-progress');
    if (i > 0) args = args.slice(0, i).concat(['-threads', String(THREADS)], args.slice(i));
  }
  return new Promise((resolve) => {
    let p;
    try { p = spawn(ffmpeg, args, { windowsHide: true, env, cwd: cwd || undefined, stdio: ['ignore', 'pipe', 'pipe'] }); }
    catch { return resolve({ code: -1 }); }
    PROC.lower(p);
    if (hold) hold.proc = p;
    let done = false;
    const fin = (code) => { if (done) return; done = true; clearTimeout(killer); if (hold) hold.proc = null; resolve({ code }); };
    const killer = setTimeout(() => { try { p.kill(); } catch { /* gone */ } fin(-2); }, CLIP_TIMEOUT_MS);
    p.stdout.on('data', (d) => {
      const m = String(d).match(/out_time_ms=(\d+)/g);
      if (m && lenSec > 0 && onProgress) {
        const at = Number(m[m.length - 1].split('=')[1]) / 1e6;
        onProgress(Math.min(99, Math.max(0, Math.round((at / lenSec) * 100))));
      }
    });
    p.stderr.on('data', () => { /* never surfaced to the page: it names local paths */ });
    p.on('error', () => fin(-1));
    p.on('close', (code) => fin(code));
  });
}

// "1.23-1.29" style tag for the download name. Digits and dots only.
function rangeTag(start, end) {
  const f = (s) => { s = Math.floor(s); const m = Math.floor(s / 60), r = s % 60; return m + '.' + String(r).padStart(2, '0'); };
  return f(start) + '-' + f(end);
}

module.exports = { validRange, buildClipArgs, runClip, setThreads, outExt, rangeTag, sec, GIF_WIDTHS, AUDIO_FORMATS };
