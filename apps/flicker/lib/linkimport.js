'use strict';
//
// Link import: bring a video in from a link with yt-dlp. OPTIONAL and OFF by default.
//
// Flicker is a studio for your own files. Link import is a convenience the owner can switch on in
// config.json (linkImport.enabled). When it is on, you are responsible for what you download.
//
// The house rules for every engine call, whoever pastes the link:
//   - No cookies, ever. Nothing signs in anywhere. Age gated and private videos fail by design.
//   - --ignore-config on every call, so nothing on disk can add flags, and the URL always sits
//     after --, so it can never be read as a flag.
//   - The engine is not allowed to open its own sockets: every call gets --proxy pointing at the
//     egress guard (egress.js), and the proxy variables in its environment point there too (ffmpeg
//     reads those). The guard refuses private addresses, local names and odd ports, and pins DNS.
//   - The pre-check here (validUrl + a DNS look) exists only to give a fast, friendly error.

const fs = require('fs');
const path = require('path');
const net = require('net');
const dns = require('dns');
const { spawn } = require('child_process');
const { ipBlocked, hostnameRefused } = require('./egress');
const PROC = require('./proc');
const SUBS = require('./subs');
const LYRICS = require('./lyrics');

const URL_MAX = 2048;
const INFO_TIMEOUT_MS = 45_000;
const JOB_TIMEOUT_MS = 60 * 60_000;
const SOCKET_TIMEOUT = '20';
const INFO_CACHE_MS = 5 * 60_000;
const INFO_CACHE_MAX = 20;
const INFO_RAW_MAX_BYTES = 4 * 1024 * 1024;
const INFO_MAX_RUNNING = 2;
const WATCHDOG_MS = 5_000;

const MODES = new Set(['studio', 'video', 'audio']);
const QUALITIES = new Set(['best', 'compat', '2160', '1440', '1080', '720', '480']);
const AUDIO = new Set(['mp3', 'm4a', 'opus']);
// What may be handed on to local ffmpeg. Never a playlist, manifest or script.
const MEDIA_EXT = new Set(['mp4', 'm4v', 'mov', 'webm', 'mkv', 'flv', 'avi', 'ts', 'ogv', '3gp',
  'm4a', 'mp3', 'opus', 'aac', 'ogg', 'oga', 'wav', 'flac', 'weba']);

/* ---- input validation (the fast, friendly pre-check; egress.js is the real wall) ---- */

function validUrl(u) {
  if (typeof u !== 'string') return null;
  const s = u.trim();
  if (!s || s.length > URL_MAX) return null;
  if (/[\u0000-\u001f\u007f]/.test(s)) return null;
  if (!/^https?:\/\//i.test(s)) return null;
  let p;
  try { p = new URL(s); } catch { return null; }
  if (p.protocol !== 'http:' && p.protocol !== 'https:') return null;
  if (p.username || p.password) return null;
  let host = p.hostname.toLowerCase();
  if (host.startsWith('[') && host.endsWith(']')) host = host.slice(1, -1);
  if (!host) return null;
  if (p.port && !['', '80', '443', '8080', '8443'].includes(p.port)) return null;
  if (net.isIP(host)) { if (ipBlocked(host)) return null; }
  else if (hostnameRefused(host)) return null;
  return p.href;
}

// Second gate for the friendly error only: a public name whose address points home.
function hostResolvesPublic(u) {
  let host;
  try { host = new URL(u).hostname.replace(/^\[|\]$/g, ''); } catch { return Promise.resolve(false); }
  if (net.isIP(host)) return Promise.resolve(!ipBlocked(host));
  return new Promise((resolve) => {
    dns.lookup(host, { all: true }, (err, addrs) => {
      if (err || !addrs || !addrs.length) return resolve(false);
      resolve(!addrs.some((a) => ipBlocked(a.address)));
    });
  });
}

/* ---- error codes (never raw engine output) ---- */

function classify(raw) {
  const e = String(raw || '').toLowerCase();
  if (/drm|only images are available/.test(e)) return 'drm';
  if (/sign in to confirm your age|age.?restricted|inappropriate for some users/.test(e)) return 'age';
  if (/private video|video is private|members-only|join this channel|requires payment|purchase/.test(e)) return 'private';
  // The bot wall is tested before the login wall: its message also mentions cookies, but it is
  // temporary and deserves "try again in a few minutes".
  if (/sign in to confirm.*not a bot|confirm you.?re not a bot/.test(e)) return 'bot';
  if (/rate.?limit/.test(e)) return 'bot';
  if (/only works when logged.?in|login required|log in to|logged.?in|use --cookies|account credentials/.test(e)) return 'login';
  if (/is not a valid url|unsupported url|unable to extract|no suitable extractor/.test(e)) return 'unsupported';
  if (/requested format is not available|no video formats found|only images/.test(e)) return 'noformat';
  if (/video unavailable|has been removed|not available in your country|geo.?restricted|blocked it/.test(e)) return 'unavailable';
  if (/failed to extract any player response/.test(e)) return 'bot';
  if (/file is larger than max|max.?filesize/.test(e)) return 'toobig';
  if (/is live|live event will begin/.test(e)) return 'live';
  if (/does not pass filter/.test(e)) return 'filtered';
  if (/proxy|403 forbidden.*proxy|tunnel connection failed|blocked/.test(e)) return 'blocked';
  if (/timed out|timeout|connection reset|unable to connect|network is unreachable|name or service not known|getaddrinfo/.test(e)) return 'network';
  return 'unknown';
}

/* ---- the engine ---- */

// Every engine spawn gets this environment: the proxy variables all point at the guard (ffmpeg
// reads them), and NO_PROXY is cleared so nothing is exempt.
function spawnEnv(proxy) {
  const env = Object.assign({}, process.env);
  for (const k of ['http_proxy', 'https_proxy', 'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'all_proxy', 'no_proxy', 'NO_PROXY']) delete env[k];
  if (proxy) {
    env.http_proxy = proxy;
    env.https_proxy = proxy;
    env.HTTP_PROXY = proxy;
    env.HTTPS_PROXY = proxy;
    env.ALL_PROXY = proxy;
    env.NO_PROXY = '';
    env.no_proxy = '';
  }
  return env;
}

// The single place a URL meets the engine.
function buildInfoArgs(url, proxy, cacheDir) {
  const args = [
    '--ignore-config',
    '-J',
    '--no-playlist', '--playlist-items', '1',
    '--no-warnings',
    '--cache-dir', cacheDir,
    '--socket-timeout', SOCKET_TIMEOUT,
    '--retries', '2',
  ];
  if (proxy) args.push('--proxy', proxy);
  args.push('--', url);
  return args;
}

// Protocols yt-dlp hands to outside programs (rtmpdump for rtmp and rtmpe, mpv or mplayer for rtsp
// and mms) or fetches without the proxy (ftp). Those programs ignore --proxy and the proxy variables,
// so they would walk straight past the egress guard. Every format term in every selector refuses them.
// (A format without a protocol field gets one derived from its URL before the filter runs.)
// HLS, DASH, f4m, ISM and plain http(s) are untouched and still go through the proxy.
const UNPROXIED = /rtmp|rtsp|mms|ftp/i;
const PROTOCOL_GUARD = '[protocol!*=rtmp][protocol!*=rtsp][protocol!*=mms][protocol!*=ftp]';
const guardFormats = (sel) => sel.split('/').map((alt) => alt.split('+').map((t) => t + PROTOCOL_GUARD).join('+')).join('/');

// A format is NOT media when the engine says so outright: both codecs 'none' (storyboards) or an
// mhtml image sheet. Streams the engine would hand to an outside player (rtmp, rtsp, mms, ftp) do
// not count either: those players ignore the proxy, and the download never picks them (guardFormats).
function isMediaFormat(f) {
  return !!f && !(f.vcodec === 'none' && f.acodec === 'none') && f.ext !== 'mhtml' && f.format_note !== 'storyboard' &&
    !UNPROXIED.test(String(f.protocol || String(f.url || '').split(':')[0]));
}

function buildDownloadArgs(o) {
  const mode = MODES.has(o.mode) ? o.mode : 'studio';
  const quality = QUALITIES.has(String(o.quality)) ? String(o.quality) : 'best';
  const audioFormat = AUDIO.has(o.audioFormat) ? o.audioFormat : 'mp3';
  const args = [
    '--ignore-config',
    '--no-playlist', '--playlist-items', '1',
    '--newline', '--progress', '--no-warnings', '--no-mtime',
    '--cache-dir', o.cacheDir,
    '--socket-timeout', SOCKET_TIMEOUT,
    '--max-filesize', String(o.maxMB) + 'M',
    '--match-filters', '!is_live & duration<=?' + String(Math.round(o.maxSec)),
    '--retries', '3', '--fragment-retries', '3',
    '-N', '4',
    '-o', path.join(o.dir, 'media.%(ext)s'),
  ];
  if (o.ffmpeg) args.push('--ffmpeg-location', o.ffmpeg);
  if (o.proxy) args.push('--proxy', o.proxy);
  if (mode === 'studio') {
    // Opened in the studio: 1080p is plenty to cut, reframe and follow, and a lot less to fetch.
    args.push('-f', guardFormats('bv*[height<=1080]+ba/b[height<=1080]/bv*+ba/b'), '--merge-output-format', 'mp4');
  } else if (mode === 'audio') {
    args.push('-f', guardFormats('bestaudio/best'), '-x', '--audio-format', audioFormat, '--audio-quality', '0');
  } else if (quality === 'compat') {
    args.push('-f', guardFormats('bv*+ba/b'), '-S', 'res:1080,vcodec:h264,acodec:aac', '--merge-output-format', 'mp4');
  } else if (quality === 'best') {
    args.push('-f', guardFormats('bv*+ba/b'), '--merge-output-format', 'mp4');
  } else {
    args.push('-f', guardFormats('bv*[height<=' + quality + ']+ba/b[height<=' + quality + ']/bv*+ba/b'), '--merge-output-format', 'mp4');
  }
  // Captions for words on the video. Fetched RAW and never converted by the engine; subs.js parses
  // them into a clean file of our own later. The code was checked against the probe's own list.
  if (mode === 'studio' && o.subLang && SUBS.validLang(o.subLang)) {
    args.push(o.subAuto ? '--write-auto-subs' : '--write-subs', '--sub-langs', o.subLang, '--sub-format', 'vtt/srt');
  }
  // The fast way in replays the JSON our own probe produced moments ago (the URL never reaches
  // argv then). The slow way is the URL, pinned after --.
  if (o.infoFile) args.push('--load-info-json', o.infoFile);
  else args.push('--', o.url);
  return args;
}

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

function findOutput(dir) {
  let ents;
  try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return null; }
  let best = null, bestSize = -1;
  for (const e of ents) {
    if (!e.isFile()) continue;
    if (!/^media\.[A-Za-z0-9]{1,8}$/.test(e.name)) continue;   // skips media.f137.mp4 and .part
    try {
      const s = fs.statSync(path.join(dir, e.name));
      if (s.size > bestSize) { bestSize = s.size; best = e.name; }
    } catch { /* vanished */ }
  }
  if (!best) return null;
  return { file: path.join(dir, best), size: bestSize, ext: best.split('.').pop().toLowerCase() };
}

function createLinkImport(deps) {
  // deps: { ytdlp, ffmpeg, cacheDir, egress, limits }
  const { ytdlp, ffmpeg, cacheDir, egress, limits } = deps;
  const maxSec = limits.maxSourceMinutes * 60;
  const maxMB = Math.round(limits.maxUploadMB);
  const hardBytes = Math.round(maxMB * 1024 * 1024 * 1.1);
  const proxyUrl = () => (egress && egress.port ? 'http://127.0.0.1:' + egress.port : '');

  function spawnEngine(args) {
    // No proxy, no spawn: an engine without the guard in front of it never runs.
    if (!proxyUrl()) throw new Error('egress guard not running');
    const p = spawn(ytdlp, args, { windowsHide: true, env: spawnEnv(proxyUrl()), stdio: ['ignore', 'pipe', 'pipe'] });
    PROC.lower(p);
    return p;
  }

  function runEngine(args, timeoutMs) {
    return new Promise((resolve) => {
      let p;
      try { p = spawnEngine(args); } catch (e) { return resolve({ code: -1, out: '', err: String(e && e.message) }); }
      let out = '', err = '', done = false;
      const finish = (r) => { if (!done) { done = true; resolve(r); } };
      const killer = setTimeout(() => { PROC.killTree(p); finish({ code: -2, out, err: 'timed out' }); }, timeoutMs);
      p.stdout.on('data', (d) => { out += d; if (out.length > 16 * 1024 * 1024) out = out.slice(-4 * 1024 * 1024); });
      p.stderr.on('data', (d) => { err += d; if (err.length > 256 * 1024) err = err.slice(-64 * 1024); });
      p.on('close', (code) => { clearTimeout(killer); finish({ code, out, err }); });
      p.on('error', (e) => { clearTimeout(killer); finish({ code: -1, out: '', err: String(e && e.message) }); });
    });
  }

  /* ---- info probe, with a short cache so an import does not re-probe what the page just probed ---- */
  const cache = new Map();   // url -> { at, value, raw }
  const inFlight = new Map();
  let running = 0;

  function cacheGet(url) {
    const e = cache.get(url);
    if (!e) return null;
    if (Date.now() - e.at > INFO_CACHE_MS) { cache.delete(url); return null; }
    return e;
  }
  function cachePut(url, value, raw) {
    cache.delete(url);
    cache.set(url, { at: Date.now(), value, raw: typeof raw === 'string' && raw.length <= INFO_RAW_MAX_BYTES ? raw : '' });
    while (cache.size > INFO_CACHE_MAX) cache.delete(cache.keys().next().value);
  }

  async function fetchInfo(url) {
    const r = await runEngine(buildInfoArgs(url, proxyUrl(), cacheDir), INFO_TIMEOUT_MS);
    if (r.code !== 0) return { ok: false, code: classify(r.err) };
    let info;
    try { info = JSON.parse(r.out); } catch { return { ok: false, code: 'unsupported' }; }
    if (!info) return { ok: false, code: 'unsupported' };
    let raw = String(r.out || '').trim();
    if (info._type === 'playlist') {
      const first = Array.isArray(info.entries) ? info.entries[0] : null;
      if (!first) return { ok: false, code: 'noformat' };
      info = first;
      try { raw = JSON.stringify(first); } catch { raw = ''; }
    }
    const fmts = Array.isArray(info.formats) ? info.formats : [];
    // A format is NOT media only when the engine says so outright: both codecs 'none'
    // (storyboards) or an mhtml image sheet. Plain file hosts report no codec fields at all.
    const isMedia = isMediaFormat;
    const hasMedia = fmts.some(isMedia) || (!fmts.length && typeof info.url === 'string' && /^https?:/i.test(info.url));
    const drm = !!info._has_drm || fmts.some((f) => f.has_drm);
    const live = !!info.is_live || info.live_status === 'is_live' || info.live_status === 'is_upcoming';
    const duration = Number(info.duration) || 0;
    const tooLong = duration > maxSec;
    const heights = [...new Set(fmts.filter((f) => f.vcodec !== 'none' && Number(f.height) > 0).map((f) => Number(f.height)))].sort((a, b) => b - a).slice(0, 12);
    const value = {
      ok: true,
      details: {
        title: SUBS.cleanLine(String(info.title || '').slice(0, 300)) || 'video',
        uploader: SUBS.cleanLine(String(info.uploader || info.channel || info.creator || '').slice(0, 200)),
        duration, downloadable: hasMedia && !drm && !live && !tooLong, drm, live, tooLong, heights,
        subs: SUBS.pickLangs(info),
        song: LYRICS.guessSong(info),
      },
    };
    cachePut(url, value, value.details.downloadable ? raw : '');
    return value;
  }

  function probe(url) {
    const c = cacheGet(url);
    if (c) return Promise.resolve(c.value);
    const flying = inFlight.get(url);
    if (flying) return flying;
    if (running >= INFO_MAX_RUNNING) return Promise.resolve({ ok: false, code: 'busy' });
    running++;
    const p = fetchInfo(url).catch(() => ({ ok: false, code: 'unknown' })).then((v) => { running--; inFlight.delete(url); return v; });
    inFlight.set(url, p);
    return p;
  }

  // One import, into job.dir. job: { dir, url, mode, quality, audioFormat, subLang, cancelled, percent, speed, eta, proc }.
  // Resolves { ok, file, ext, title, captionsFile, captionsLabel, song } or { ok:false, code }.
  async function download(job) {
    const probed = await probe(job.url);
    if (job.cancelled) return { ok: false, code: 'cancelled' };
    if (!probed.ok) return { ok: false, code: probed.code || 'unknown' };
    const info = probed.details;
    if (info.live) return { ok: false, code: 'live' };
    if (info.tooLong) return { ok: false, code: 'toolong' };
    if (info.drm) return { ok: false, code: 'drm' };
    if (!info.downloadable) return { ok: false, code: 'noformat' };
    let subAuto = false, subLabel = '';
    if (job.subLang) {
      const track = info.subs.find((s) => s.code === job.subLang);
      if (track) { subAuto = !!track.auto; subLabel = track.label; } else job.subLang = '';
    }
    let infoFile = '';
    const c = cacheGet(job.url);
    if (c && c.raw) { const f = path.join(job.dir, 'info.json'); try { fs.writeFileSync(f, c.raw); infoFile = f; } catch { infoFile = ''; } }

    const attempt = (useInfo) => new Promise((resolve) => {
      const args = buildDownloadArgs({
        dir: job.dir, url: job.url, mode: job.mode, quality: job.quality, audioFormat: job.audioFormat,
        proxy: proxyUrl(), ffmpeg, cacheDir, maxMB, maxSec, infoFile: useInfo ? infoFile : '', subLang: job.subLang, subAuto,
      });
      let p;
      try { p = spawnEngine(args); } catch { return resolve({ code: -1, err: '', moved: false }); }
      job.proc = p;
      let errBuf = '', moved = false;
      const timeout = setTimeout(() => { job.timedOut = true; PROC.killTree(p); }, JOB_TIMEOUT_MS);
      const watchdog = setInterval(() => { if (dirSize(job.dir) > hardBytes) { job.overSize = true; PROC.killTree(p); } }, WATCHDOG_MS);
      p.stdout.on('data', (d) => {
        if (job.cancelled || job.timedOut || job.overSize) return;
        for (const line of String(d).split(/\r?\n/)) {
          const m = line.match(/\[download\]\s+([\d.]+)%\s+of\s+~?\s*([\d.]+\s*\w+)(?:\s+at\s+([\d.]+\s*\w+\/s))?(?:\s+ETA\s+([\d:]+))?/);
          if (m) { moved = true; job.percent = Math.min(100, parseFloat(m[1]) || 0); job.speed = (m[3] || '').trim(); job.eta = (m[4] || '').trim(); continue; }
          if (/^\[(Merger|ExtractAudio|VideoConvertor|VideoRemuxer|FixupM3u8|Fixup)/.test(line)) { moved = true; job.stage = 'merging'; job.percent = 100; job.speed = ''; job.eta = ''; }
        }
      });
      p.stderr.on('data', (d) => { errBuf += d; if (errBuf.length > 256 * 1024) errBuf = errBuf.slice(-64 * 1024); });
      const done = (code) => { clearTimeout(timeout); clearInterval(watchdog); job.proc = null; resolve({ code, err: errBuf, moved }); };
      p.on('error', () => done(-1));
      p.on('close', (code) => done(code));
    });

    const bail = () => {
      if (job.cancelled) return { ok: false, code: 'cancelled' };
      if (job.overSize) return { ok: false, code: 'toobig' };
      if (job.timedOut) return { ok: false, code: 'network' };
      return null;
    };

    let r = await attempt(!!infoFile);
    let b = bail(); if (b) return b;
    let found = findOutput(job.dir);
    // Cached format URLs go stale and start answering 403. If the fast path died before a single
    // byte moved, take the slow path once.
    if (!(r.code === 0 && found && found.size > 0) && infoFile && !r.moved) {
      cache.delete(job.url);
      job.percent = 0; job.speed = ''; job.eta = '';
      r = await attempt(false);
      b = bail(); if (b) return b;
      found = findOutput(job.dir);
    }
    if (!(r.code === 0 && found && found.size > 0)) {
      let cls = classify(r.err);
      if (cls === 'unknown' && r.code === 0) cls = 'filtered';
      return { ok: false, code: cls };
    }
    // Only real media containers are ever handed on to local ffmpeg (a file NAMED .m3u8 would switch
    // ffmpeg's HLS reader on, and that one follows local file: segments anywhere).
    if (!MEDIA_EXT.has(found.ext)) return { ok: false, code: 'noformat' };
    let captionsFile = '';
    if (job.subLang) {
      try {
        const capt = fs.readdirSync(job.dir).find((n) => /^media\.[A-Za-z0-9-]{2,24}\.(vtt|srt)$/i.test(n));
        if (capt) captionsFile = path.join(job.dir, capt);
      } catch { captionsFile = ''; }
    }
    return { ok: true, file: found.file, size: found.size, ext: found.ext, title: info.title, captionsFile, captionsLabel: subLabel, song: info.song };
  }

  return { probe, download, proxyUrl };
}

module.exports = { guardFormats, PROTOCOL_GUARD, isMediaFormat, createLinkImport, validUrl, hostResolvesPublic, classify, buildInfoArgs, buildDownloadArgs, spawnEnv, MODES, QUALITIES, AUDIO };
