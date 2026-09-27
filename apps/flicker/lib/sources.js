'use strict';
//
// Sources: the videos open in the studio. Every tool (cut, audio, GIF, reframe, words, text
// follow) works on a source.
//
// A source arrives one of two ways: dropped from your device (uploaded in parts), or brought in
// from a link when the optional link import is on. Either way the shape is the same:
//
//   1. The bytes land in a folder this app names, under a file name this app names (src.bin).
//      ffmpeg picks demuxers by file NAME for the dangerous ones (a .m3u8 name switches HLS on,
//      and HLS then reads local file: segments from anywhere), so the name you gave never
//      reaches the disk. It is only ever used, sanitised, for the download file name.
//   2. Every number in a render request is clamped and re-printed by us before it goes near a
//      filtergraph. Shapes, fills and colours are table lookups, never values.
//   3. ffmpeg runs with -protocol_whitelist file, cwd = the job dir, through runClip().
//   4. Caps (from config): bytes and minutes per source, open sources, a time to live.

const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const SUBS = require('./subs');

const PART_MAX = 8 * 1024 * 1024;        // one upload request
const MIN_SRC_SEC = 0.5;
const UPLOAD_IDLE_MS = 5 * 60_000;       // an upload with no part arriving for this long is dropped
const STRIP_N = 16;                      // filmstrip frames
const STRIP_W = 160;                     // px per frame
const PROBE_TIMEOUT_MS = 30_000;
const NAME_MAX = 120;
const PART_FAILS_MAX = 40;
const PREP_MAX = 2;                      // probes + filmstrips running at once
const STRIP_KEYFRAMES_OVER_SEC = 120;    // a long source is skimmed from keyframes only

// Output frames for reframe. Keys are what the page sends; nothing else is accepted.
const SIZES = {
  '9:16': [1080, 1920],
  '4:5': [1080, 1350],
  '1:1': [1080, 1080],
  '3:4': [1080, 1440],
  '16:9': [1920, 1080],
};
const MODES = ['crop', 'blur', 'pad'];
// Solid background colours: names in, ffmpeg colour literals out.
const COLORS = {
  black: { label: 'Black', ff: '0x000000' },
  charcoal: { label: 'Charcoal', ff: '0x161311' },
  white: { label: 'White', ff: '0xFFFFFF' },
  cream: { label: 'Warm white', ff: '0xF4EEE6' },
  ember: { label: 'Ember', ff: '0xE7A94C' },
  sage: { label: 'Sage', ff: '0x8FA96A' },
};
const BLUR = 24;                         // boxblur radius for the blurred background
const FPS_CAP = 60;
// Zoom is relative to "cover" (the video just filling the frame): 1 = fill, below 1 pulls back to
// show more of the picture over the background, above 1 pushes in. Crop cannot go below 1 (nothing
// is behind it); blur and solid can pull back to "fit" (the whole picture) and no further.
const ZOOM_MAX = 2.5;

const MIME_BY_FORMAT = [
  [/matroska|webm/, 'video/webm'],
  [/mov|mp4|m4a|3gp|mj2/, 'video/mp4'],
  [/ogg/, 'video/ogg'],
];

const sec = (v) => { const n = Number(v); return (Number.isFinite(n) && n >= 0 ? Math.round(n * 10) / 10 : 0).toFixed(1); };
const frac = (v, dflt) => { const n = Number(v); if (!Number.isFinite(n)) return dflt.toFixed(3); return Math.min(1, Math.max(0, n)).toFixed(3); };

function createSources(deps) {
  // deps: { FFMPEG, WORK_DIR, runClip, songhunt, limits }
  const { FFMPEG, WORK_DIR, runClip, songhunt, limits } = deps;
  const MAX_BYTES = Math.round(limits.maxUploadMB * 1024 * 1024);
  const MAX_SRC_SEC = limits.maxSourceMinutes * 60;
  const SRC_TTL_MS = limits.sourceHours * 3600_000;
  const sources = new Map();

  let prepRunning = 0;
  const prepQueue = [];
  function withPrep(fn) {
    return new Promise((resolve) => {
      const start = () => {
        prepRunning++;
        Promise.resolve().then(fn).catch(() => null).then((v) => {
          prepRunning--;
          resolve(v);
          const next = prepQueue.shift();
          if (next) next();
        });
      };
      if (prepRunning < PREP_MAX) start(); else prepQueue.push(start);
    });
  }

  const live = () => [...sources.values()].filter((s) => s.state !== 'gone');
  function touch(s) { s.lastAt = Date.now(); }

  function drop(s) {
    if (s.state === 'gone') return;
    s.state = 'gone';
    if (s.stripProc) { try { s.stripProc.kill(); } catch { /* gone */ } }
    const d = s.dir;
    s.dir = '';
    if (d) fs.rm(d, { recursive: true, force: true, maxRetries: 3 }, () => { /* best effort */ });
    setTimeout(() => sources.delete(s.id), 60_000).unref();
  }

  function newSource(idBytes, rawName) {
    sweep();
    if (live().length >= limits.openSources) return { ok: false, code: 'toomany' };
    const id = 'sr' + idBytes.toString('hex').slice(0, 30);
    const dir = path.join(WORK_DIR, id);
    try { fs.mkdirSync(dir, { recursive: false }); } catch { return { ok: false, code: 'busy' }; }
    const s = {
      id, dir, file: path.join(dir, 'src.bin'), total: 0, bytes: 0,
      name: cleanName(rawName), state: 'uploading', writing: false, failed: 0,
      meta: null, mime: 'video/mp4', strip: false, stripProc: null, rendering: 0,
      captions: null, songHint: null, origin: 'upload',
      createdAt: Date.now(), lastAt: Date.now(),
    };
    sources.set(id, s);
    return { ok: true, src: s };
  }

  // Opens a new upload. Returns { ok, src } or { ok:false, code }.
  function begin(total, rawName, idBytes) {
    total = Number(total);
    if (!Number.isInteger(total) || total <= 0) return { ok: false, code: 'badrequest' };
    if (total > MAX_BYTES) return { ok: false, code: 'toobig' };
    const r = newSource(idBytes, rawName);
    if (r.ok) r.src.total = total;
    return r;
  }

  // Your file name, made safe for a Content-Disposition. Never used on disk.
  function cleanName(raw) {
    let t = '';
    try { t = decodeURIComponent(String(raw || '')); } catch { t = String(raw || ''); }
    t = t.replace(/\.[A-Za-z0-9]{1,5}$/, '');      // drop the extension
    t = t.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/[\\/:*?"<>|]/g, ' ').replace(/\s+/g, ' ').trim();
    if (t.length > NAME_MAX) t = t.slice(0, NAME_MAX).trim();
    return t || 'video';
  }

  // Appends one part. The part must start exactly where the file ends (no gaps, no overlaps, no
  // second writer). Resolves { ok, bytes } or { ok:false, code, status }.
  function part(s, req, offset, declared) {
    return new Promise((resolve) => {
      if (!s || s.state !== 'uploading') { req.resume(); return resolve({ ok: false, code: 'gone', status: 404 }); }
      if (s.writing) { req.resume(); return resolve({ ok: false, code: 'busy', status: 409 }); }
      offset = Number(offset); declared = Number(declared);
      if (!Number.isInteger(offset) || offset !== s.bytes) { req.resume(); return resolve({ ok: false, code: 'badoffset', status: 409 }); }
      if (!Number.isInteger(declared) || declared <= 0 || declared > PART_MAX) { req.resume(); return resolve({ ok: false, code: 'badrequest', status: 400 }); }
      if (s.bytes + declared > s.total) { req.resume(); return resolve({ ok: false, code: 'toobig', status: 413 }); }
      s.writing = true;
      touch(s);
      // The file on disk must be exactly the bytes accounted for before anything is appended: an
      // aborted part must not leave bytes behind for the next part to append after.
      try { const st = fs.statSync(s.file); if (st.size !== s.bytes) fs.truncateSync(s.file, s.bytes); }
      catch (e) { if (!(e && e.code === 'ENOENT')) { s.writing = false; req.resume(); return resolve({ ok: false, code: 'busy', status: 503 }); } }
      let got = 0, over = false, done = false;
      const out = fs.createWriteStream(s.file, { flags: 'a' });
      const settle = (r) => {
        s.writing = false;
        if (r.ok) { s.bytes += got; return resolve(r); }
        s.failed++;
        if (s.failed > PART_FAILS_MAX) drop(s);
        resolve(r);
      };
      const fin = (r) => {
        if (done) return; done = true;
        if (r.ok) return settle(r);
        const fix = () => { if (s.state === 'gone') return settle(r); fs.truncate(s.file, s.bytes, () => settle(r)); };
        if (out.closed) fix();
        else { out.once('close', fix); if (!out.destroyed) out.destroy(); }
      };
      req.on('data', (c) => {
        got += c.length;
        if (got > declared) { over = true; try { req.destroy(); } catch { /* raced */ } return fin({ ok: false, code: 'toobig', status: 413 }); }
        if (!over) out.write(c);
      });
      req.on('end', () => {
        if (over) return;
        out.end(() => {
          if (got !== declared) return fin({ ok: false, code: 'badrequest', status: 400 });
          fin({ ok: true, bytes: s.bytes + got });
        });
      });
      req.on('error', () => fin({ ok: false, code: 'badrequest', status: 400 }));
      req.on('aborted', () => fin({ ok: false, code: 'badrequest', status: 400 }));
      out.on('error', () => { try { req.destroy(); } catch { /* raced */ } fin({ ok: false, code: 'busy', status: 503 }); });
    });
  }

  // All bytes in: probe it, decide, start the filmstrip. Resolves { ok, meta } or { ok:false, code }.
  async function finish(s, env) {
    if (!s || s.state !== 'uploading') return { ok: false, code: 'gone' };
    if (s.writing) return { ok: false, code: 'busy' };
    if (s.total && s.bytes !== s.total) return { ok: false, code: 'badrequest' };
    s.state = 'probing';
    const meta = await withPrep(() => probe(s.file));
    if (s.state === 'gone') return { ok: false, code: 'gone' };
    if (!meta || !meta.video) { drop(s); return { ok: false, code: 'badmedia' }; }
    if (meta.dur < MIN_SRC_SEC) { drop(s); return { ok: false, code: 'badmedia' }; }
    if (meta.dur > MAX_SRC_SEC) { drop(s); return { ok: false, code: 'toolong' }; }
    if (meta.w < 16 || meta.h < 16) { drop(s); return { ok: false, code: 'badmedia' }; }
    s.meta = meta;
    s.mime = meta.mime;
    s.state = 'ready';
    try { s.bytes = fs.statSync(s.file).size; } catch { /* keep the count we have */ }
    touch(s);
    makeStrip(s, env);
    // for every video with sound, go find out what song it is (background, never blocks)
    if (songhunt && meta.audio) songhunt.hunt(s, withPrep).catch(() => { /* the hunt never throws, belt and braces */ });
    return { ok: true, meta: view(s) };
  }

  // A file that link import already downloaded into its own job dir: move it in as a source.
  // Resolves { ok, src } or { ok:false, code }.
  async function adopt(file, rawName, idBytes, env, extra) {
    const r = newSource(idBytes, rawName);
    if (!r.ok) return r;
    const s = r.src;
    s.origin = 'link';
    try { fs.renameSync(file, s.file); }
    catch { try { fs.copyFileSync(file, s.file); } catch { drop(s); return { ok: false, code: 'busy' }; } }
    if (extra && extra.captionsFile) {
      try {
        const st = fs.statSync(extra.captionsFile);
        if (st.isFile() && st.size > 0 && st.size <= SUBS.MAX_INPUT_BYTES) {
          fs.copyFileSync(extra.captionsFile, path.join(s.dir, 'captions.txt'));
          s.captions = { file: path.join(s.dir, 'captions.txt'), label: extra.captionsLabel || '' };
        }
      } catch { s.captions = null; }
    }
    if (extra && extra.songHint) s.songHint = extra.songHint;
    const f = await finish(s, env);
    return f.ok ? { ok: true, src: s } : f;
  }

  // What the page gets to know about a source. Effective width and height (after the rotation
  // ffmpeg applies on decode, which is what the filters and the browser both see).
  function view(s) {
    const m = s.meta || {};
    return {
      id: s.id, name: s.name, dur: m.dur || 0, w: m.w || 0, h: m.h || 0, fps: m.fps || 0, audio: !!m.audio,
      strip: !!s.strip, mime: s.mime, bytes: s.bytes, origin: s.origin,
      captions: s.captions ? (s.captions.label || 'Captions') : '',
      state: s.state, lastAt: s.lastAt,
    };
  }

  // ffmpeg -i and read its own description. Only ever a file this app wrote, under a name this
  // app chose, pinned to the file protocol.
  function probe(file) {
    return new Promise((resolve) => {
      execFile(FFMPEG, ['-hide_banner', '-nostdin', '-protocol_whitelist', 'file', '-i', file], { windowsHide: true, timeout: PROBE_TIMEOUT_MS, maxBuffer: 1024 * 1024 }, (err, so, se) => {
        const s = String(se || '');
        const v = /Stream #\d+:\d+[^\n]*Video:[^\n]*?\b(\d{2,5})x(\d{2,5})\b[^\n]*?(?:,\s*([\d.]+) fps)?/.exec(s);
        const d = /Duration: (\d+):(\d+):([\d.]+)/.exec(s);
        const f = /Input #0, ([a-z0-9_,]+),/i.exec(s);
        if (!v || !d) return resolve(null);
        let w = Number(v[1]), h = Number(v[2]);
        // Phones record sideways and store a rotation. ffmpeg turns the frames upright on decode,
        // so what the filters see is the swapped size.
        const rot = /rotation of (-?[\d.]+) degrees/.exec(s) || /rotate\s*:\s*(-?\d+)/.exec(s);
        if (rot) { const r = Math.abs(Math.round(Number(rot[1]))) % 180; if (r === 90) { const t = w; w = h; h = t; } }
        let mime = 'video/mp4';
        const fmt = f ? f[1].toLowerCase() : '';
        for (const [re, m] of MIME_BY_FORMAT) if (re.test(fmt)) { mime = m; break; }
        resolve({
          video: true, w, h,
          fps: Math.min(240, Number(v[3]) || 30),
          dur: Number(d[1]) * 3600 + Number(d[2]) * 60 + Number(d[3]),
          audio: /Stream #\d+:\d+[^\n]*Audio:/.test(s),
          mime,
        });
      });
    });
  }

  // One JPEG, STRIP_N frames side by side, for the trim rail. Best effort, in the background.
  function makeStrip(s, env) {
    const dur = s.meta.dur;
    const n = dur < 2 ? 4 : STRIP_N;
    const rate = (n / dur).toFixed(4);
    const skim = dur > STRIP_KEYFRAMES_OVER_SEC ? ['-skip_frame', 'nokey'] : [];
    const args = ['-y', '-nostdin', '-v', 'error', '-protocol_whitelist', 'file', ...skim, '-i', s.file,
      '-vf', 'fps=' + rate + ',scale=' + STRIP_W + ':-2:flags=bilinear,tile=' + n + 'x1', '-frames:v', '1', '-q:v', '4',
      '-progress', 'pipe:1', '-nostats', path.join(s.dir, 'strip.jpg')];
    withPrep(() => {
      if (s.state === 'gone') return null;
      const hold = {};
      const p = runClip(FFMPEG, args, dur, env, hold, null, s.dir);
      s.stripProc = hold.proc || null;
      return p;
    }).then((r) => {
      s.stripProc = null;
      if (!r || s.state === 'gone') return;
      let ok = false;
      try { ok = r.code === 0 && fs.statSync(path.join(s.dir, 'strip.jpg')).size > 0; } catch { ok = false; }
      s.strip = ok;
    });
  }

  /* ---- reframe ---- */

  // Body from the page, down to numbers and table keys. Returns { ok, opts } or { ok:false, code }.
  function normReframe(s, body, range) {
    const ratio = Object.prototype.hasOwnProperty.call(SIZES, body.ratio) ? String(body.ratio) : '9:16';
    const mode = MODES.includes(body.mode) ? String(body.mode) : 'crop';
    const color = Object.prototype.hasOwnProperty.call(COLORS, body.color) ? String(body.color) : 'black';
    const opts = {
      start: range.start, end: range.end, len: range.len,
      ratio, mode, color,
      panX: frac(body.panX, 0.5), panY: frac(body.panY, 0.5),
      zoom: Number(body.zoom),
      mute: body.mute === true || !s.meta.audio,
      fps: s.meta.fps > FPS_CAP ? FPS_CAP : 0,
      burn: false, subStyle: SUBS.normStyle(null),
    };
    Object.assign(opts, layout(opts, s.meta));
    return { ok: true, opts };
  }

  // Where the picture lands in the new frame, in output pixels. The same arithmetic the page's
  // canvas uses: k = cover * zoom; the picture is dw x dh; it sits at (W-dw)*panX, (H-dh)*panY.
  function layout(o, meta) {
    const [W, H] = SIZES[o.ratio];
    const vw = Math.max(16, Number(meta.w) || 16), vh = Math.max(16, Number(meta.h) || 16);
    const cover = Math.max(W / vw, H / vh), fit = Math.min(W / vw, H / vh);
    const zmin = o.mode === 'crop' ? 1 : fit / cover;
    let zoom = Number.isFinite(o.zoom) ? o.zoom : zmin;
    zoom = Math.min(ZOOM_MAX, Math.max(zmin, zoom));
    const k = cover * zoom;
    let dw = Math.round(vw * k), dh = Math.round(vh * k);
    if (dw % 2) dw++;
    if (dh % 2) dh++;
    if (o.mode === 'crop') { dw = Math.max(dw, W); dh = Math.max(dh, H); }
    const x = 2 * Math.round((W - dw) * Number(o.panX) / 2), y = 2 * Math.round((H - dh) * Number(o.panY) / 2);
    return { W, H, dw, dh, x, y, zoom: Math.round(zoom * 1000) / 1000 };
  }

  // The ffmpeg command, without the exe. Every interpolated value is a table key or a number this
  // file computed and printed. One chain for every fill: a background the size of the new frame,
  // then the picture scaled to dw x dh laid on top at its offset. overlay clips the overflow.
  function buildReframeArgs(o, src, out) {
    const { W, H, dw, dh, x, y } = o;
    const head = ['-y', '-nostdin', '-v', 'error', '-protocol_whitelist', 'file',
      '-ss', sec(o.start), '-t', sec(o.len), '-i', src];
    const fpsTail = o.fps ? ',fps=' + o.fps : '';
    const enc = ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-pix_fmt', 'yuv420p', '-movflags', '+faststart'];
    const audio = o.mute ? ['-an'] : ['-c:a', 'aac', '-b:a', '160k'];
    const tail = ['-progress', 'pipe:1', '-nostats', out];
    const bg = o.mode === 'blur'
      ? 'scale=' + W + ':' + H + ':force_original_aspect_ratio=increase,crop=' + W + ':' + H + ',boxblur=' + BLUR + ':2,setsar=1'
      : 'scale=' + W + ':' + H + ':flags=neighbor,drawbox=x=0:y=0:w=iw:h=ih:color=' + (o.mode === 'pad' ? COLORS[o.color].ff : COLORS.black.ff) + ':t=fill,setsar=1';
    // Burned in words, last: the filter text is built from subs.js tables only and names its file
    // relatively (ffmpeg runs with the job dir as cwd).
    const words = o.burn ? ',' + SUBS.subtitleFilter('video', o.subStyle) : '';
    const fc = '[0:v]split[a][b];' +
      '[a]' + bg + '[bg];' +
      '[b]scale=' + dw + ':' + dh + ':flags=lanczos,setsar=1[fg];' +
      '[bg][fg]overlay=' + x + ':' + y + ':format=yuv420,format=yuv420p' + fpsTail + words + '[v]';
    return [...head, '-filter_complex', fc, '-map', '[v]', ...(o.mute ? [] : ['-map', '0:a:0?']), ...enc, ...audio, ...tail];
  }

  async function renderReframe(s, o, out, env, onProgress) {
    if (!s || s.state !== 'ready') return { ok: false, code: 'gone' };
    touch(s);
    s.rendering++;
    const file = path.join(out.dir, 'reframed.mp4');
    const args = buildReframeArgs(o, s.file, file);
    let r;
    try { r = await runClip(FFMPEG, args, o.len, env, out, onProgress, out.dir); }
    finally { s.rendering = Math.max(0, s.rendering - 1); }
    let size = 0;
    try { size = fs.statSync(file).size; } catch { size = 0; }
    if (r.code !== 0 || size <= 0) return { ok: false, code: 'renderfail' };
    return { ok: true, file, size, ext: 'mp4' };
  }

  const ratioTag = (ratio) => '(' + String(ratio).replace(':', 'x') + ')';

  /* ---- housekeeping ---- */

  function sweep() {
    const now = Date.now();
    for (const s of sources.values()) {
      if (s.state === 'gone') continue;
      if (s.state === 'uploading' && !s.writing && now - s.lastAt > UPLOAD_IDLE_MS) { drop(s); continue; }
      if (s.state === 'ready' && !s.rendering && now - s.lastAt > SRC_TTL_MS) { drop(s); continue; }
    }
  }

  function shutdown() { /* sources are kept on disk only while the app runs; the boot sweep clears leftovers */ }

  const get = (id) => { const s = sources.get(String(id)); return s && s.state !== 'gone' ? s : null; };
  const list = () => live().filter((s) => s.state === 'ready').sort((a, b) => b.lastAt - a.lastAt).map(view);

  return {
    begin, part, finish, adopt, view, normReframe, layout, buildReframeArgs, renderReframe, drop, get, list, touch, sweep, shutdown, ratioTag, cleanName, withPrep,
    MAX_BYTES, PART_MAX, MAX_SRC_SEC, SIZES, MODES, COLORS, ZOOM_MAX,
  };
}

const colorOptions = () => Object.keys(COLORS).map((id) => ({ id, label: COLORS[id].label, hex: '#' + COLORS[id].ff.slice(2) }));

module.exports = { createSources, SIZES, MODES, COLORS, ZOOM_MAX, PART_MAX, colorOptions };
