'use strict';
//
// Text follow: mark something in a clip, type some text, and the text follows it.
//
// The pieces:
//   - prepare(): our ffmpeg cuts the chosen range into a master clip, then pulls small JPEG frames
//     out of it for the tracker.
//   - The tracker is SAM 2.1 in a separate Python worker (py/track.py) on the local NVIDIA GPU. It
//     is started on the first mark, kept warm while you work, and stopped after IDLE_MS so the card
//     is handed back. One request at a time per lane, a short queue.
//   - render(): the tracks become a subtitle script (labels.js) that ffmpeg burns into the clip.
//
// Optional. It needs a Python with torch (CUDA), sam2, opencv and numpy, plus a SAM 2.1 checkpoint.
// When those are missing the page shows how to add them and the rest of Flicker is untouched.
//
// GPU guard (tracker.gpuGuard, on by default): before the worker is started or handed a job, the
// card is sampled with nvidia-smi. If something else is busy on it (a game, another AI app) the
// studio says it is resting rather than competing, and a job running when a game starts is stopped.
//
// What reaches the worker: a frames directory this module created, frame indexes and click points
// that were coerced to numbers here. No typed text, no URL, no path from the page.

const fs = require('fs');
const path = require('path');
const { spawn, execFile } = require('child_process');
const LABELS = require('./labels');
const CLIP = require('./clip');
const PROC = require('./proc');

const FRAME_BUDGET = 900;          // tracked frames per session, sets the tracking frame rate
const FPS_MIN = 10, FPS_MAX = 30;
const FRAME_LONG_SIDE = 854;
const IDLE_MS = 4 * 60_000;        // worker exits after this long with nothing to do
const START_TIMEOUT_MS = 150_000;  // a cold start (loading torch and the model) can take most of a minute
const SEG_TIMEOUT_MS = 30_000;
const TRACK_TIMEOUT_MS = 10 * 60_000;
const SEG_QUEUE_MAX = 12;
const SEG_WAIT_MS = 20_000;        // a mark that cannot start by then is told "busy", not left hanging
const TRACKS_MAX = 2;              // queued plus running
const START_FAILS_MAX = 3;         // worker starts that never came up, in a row ...
const START_BACKOFF_MS = 5 * 60_000; // ... then the tracker rests this long
const GPU_BUSY_UTIL = 55;          // percent, sampled twice
const GPU_MIN_FREE_MB = 2500;
const OWN_GROWTH_MB = 3500;        // most our two workers add over a clean reading (measured peak ~1 GB each)
const WATCH_MS = 5_000;
const MAX_POINTS = 12, MAX_PROMPTS = 8;

// The bundled SAM 2.1 worker. config tracker.worker can name another script that speaks the same
// stdin/stdout protocol (documented at the top of py/track.py), run by tracker.python.
const TRACK_PY = path.join(__dirname, '..', 'py', 'track.py');

function createFollow(deps) {
  // deps: { FFMPEG, WORK_DIR, python, checkpoints, model, gpuGuard, ready, maxSec }
  const { FFMPEG, WORK_DIR } = deps;
  const WORKER = deps.worker || TRACK_PY;
  let cfg = { python: deps.python || '', checkpoints: deps.checkpoints || '', model: deps.model || 'base_plus', gpuGuard: deps.gpuGuard !== false, ready: !!deps.ready };
  const NVSMI = PROC.which('nvidia-smi') || (process.platform === 'win32' ? path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'nvidia-smi.exe') : '');
  const set = (next) => { cfg = Object.assign({}, cfg, next); };

  const available = () => {
    try { return cfg.ready && !!cfg.python && fs.existsSync(WORKER) && !!cfg.checkpoints && fs.existsSync(cfg.checkpoints); }
    catch { return false; }
  };

  /* ---- GPU guard ------------------------------------------------------------------------------ */
  // Per process utilisation is often not available (nvidia-smi pmon shows "-" on many systems), so
  // the guard samples the whole card right before each job is handed to a worker, at a moment none
  // of OUR workers is computing; any load seen then is someone else's.
  let nvsmiMissing = false;
  function sampleGpu() {
    return new Promise((resolve) => {
      if (!NVSMI || nvsmiMissing) return resolve({ unknown: true });
      execFile(NVSMI, ['--query-gpu=utilization.gpu,memory.total,memory.used', '--format=csv,noheader,nounits'],
        { windowsHide: true, timeout: 5_000 }, (err, stdout) => {
          if (err && err.code === 'ENOENT') { nvsmiMissing = true; return resolve({ unknown: true }); }
          if (err) return resolve(null);
          const v = String(stdout).split('\n')[0].split(',').map((x) => Number(x.trim()));
          if (v.length < 3 || v.some((x) => !Number.isFinite(x))) return resolve(null);
          resolve({ util: v[0], free: v[1] - v[2], used: v[2] });
        });
    });
  }
  let gpuCache = { at: 0, ok: false, used: 0 };
  const computing = () => lanes.some((l) => l.current);
  async function sampleFree() {
    if (!cfg.gpuGuard) { gpuCache = { at: Date.now(), ok: true, used: 0 }; return true; }
    const a = await sampleGpu();
    if (a && a.unknown) { gpuCache = { at: Date.now(), ok: true, used: 0, unknown: true }; return true; }   // no nvidia-smi: nothing to guard with
    let ok = !!a && a.free >= GPU_MIN_FREE_MB;
    if (ok && a.util >= GPU_BUSY_UTIL) {
      // utilisation is averaged over the last moment, which can still hold our own finished job
      await new Promise((r) => setTimeout(r, 700));
      const b = await sampleGpu();
      ok = !!b && (b.util < GPU_BUSY_UTIL || computing()) && b.free >= GPU_MIN_FREE_MB;
    }
    gpuCache = { at: Date.now(), ok, used: a ? a.used : 0 };
    return ok;
  }
  // While our own worker computes, utilisation cannot tell us from a game, but memory can: a game
  // takes gigabytes, our workers grow by at most OWN_GROWTH_MB over the last clean reading.
  let busyCheck = { at: 0, ok: true };
  async function stillFreeWhileComputing() {
    if (!cfg.gpuGuard || gpuCache.unknown) return true;
    if (!gpuCache.ok) return false;
    if (Date.now() - busyCheck.at < 3_000) return busyCheck.ok;
    const a = await sampleGpu();
    const ok = !!a && a.free >= GPU_MIN_FREE_MB && a.used - gpuCache.used <= OWN_GROWTH_MB;
    busyCheck = { at: Date.now(), ok };
    return ok;
  }
  async function gpuFree() {
    if (computing()) return stillFreeWhileComputing();
    if (Date.now() - gpuCache.at < 4_000) return gpuCache.ok;
    return sampleFree();
  }

  /* ---- two lanes, one worker each ------------------------------------------------------------- */
  // Marks are small and you are waiting on each; tracks take a minute. So marks get their own worker
  // and never wait behind a track. Each worker holds about 1 GB of VRAM and exits when idle.
  let seq = 0, startFails = 0, offUntil = 0;
  // Cold starts are serialised: two lanes booting the model at once can each take so long that
  // both time out.
  let starting = Promise.resolve();
  const lane = (name, max) => ({ name, max, q: [], worker: null, current: null, pumping: false });
  const segLane = lane('seg', SEG_QUEUE_MAX), trackLane = lane('track', TRACKS_MAX);
  const lanes = [segLane, trackLane];

  function startWorker(L) {
    const env = Object.assign({}, process.env, {
      FLICKER_TRACK_CKPT: cfg.checkpoints, FLICKER_TRACK_MODEL: cfg.model, FLICKER_TRACK_WARM: path.join(WORK_DIR, 'warm'),
      PYTHONIOENCODING: 'utf-8', PYTHONUNBUFFERED: '1', HF_HUB_OFFLINE: '1',
      // it has no reason to touch the network; if anything in it ever tried, it would hit a dead port
      HTTP_PROXY: 'http://127.0.0.1:9', HTTPS_PROXY: 'http://127.0.0.1:9', http_proxy: 'http://127.0.0.1:9', https_proxy: 'http://127.0.0.1:9', NO_PROXY: '', no_proxy: '',
    });
    let p;
    try { p = spawn(cfg.python, [WORKER], { cwd: path.dirname(WORKER), env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] }); }
    catch { return null; }
    PROC.lower(p);
    const w = { p, ready: false, buf: '', waiters: [], idle: null };
    w.readyP = new Promise((resolve) => { w.waiters.push(resolve); });
    const startT = setTimeout(() => stopWorker(w, 'start'), START_TIMEOUT_MS);
    p.stdout.on('data', (d) => {
      w.buf += d;
      if (w.buf.length > 64 * 1024 * 1024) { stopWorker(w, 'overflow'); return; }
      let i;
      while ((i = w.buf.indexOf('\n')) >= 0) {
        const line = w.buf.slice(0, i).trim();
        w.buf = w.buf.slice(i + 1);
        if (!line) continue;
        let msg;
        try { msg = JSON.parse(line); } catch { continue; }
        if (msg.ready) { clearTimeout(startT); w.ready = true; startFails = 0; w.waiters.splice(0).forEach((r) => r(true)); continue; }
        const c = L.current;
        if (!c || c.w !== w || msg.id !== c.id) continue;
        if (msg.progress !== undefined) { if (c.onProgress) c.onProgress(Number(msg.progress) || 0); continue; }
        finish(L, msg.ok ? { ok: true, result: msg.result } : { ok: false, code: msg.code === 'gpumem' ? 'followbusy' : 'trackfail' });
      }
    });
    let errTail = '';
    p.stderr.on('data', (d) => { errTail = (errTail + d).slice(-2000); });
    p.on('error', () => stopWorker(w, 'error'));
    p.on('close', () => {
      clearTimeout(startT);
      if (/Error|Traceback/.test(errTail) && !w.stopping) console.log('[flicker] tracker exited: ' + String(errTail.split('\n').filter((l) => /Error/.test(l)).slice(-1)[0] || '').slice(0, 200));
      w.dead = true;
      if (!w.ready && w.stopping !== 'owner' && w.stopping !== 'shutdown') {
        // Never came up (CUDA error, driver reset, no VRAM). Three in a row and the tracker rests.
        startFails++;
        if (startFails >= START_FAILS_MAX) { offUntil = Date.now() + START_BACKOFF_MS; startFails = 0; failAll('followbusy'); }
      }
      w.waiters.splice(0).forEach((r) => r(false));
      if (L.worker === w) L.worker = null;
      if (L.current && L.current.w === w) finish(L, { ok: false, code: w.stopping === 'owner' ? 'followbusy' : 'trackfail' });
      else pump(L);
    });
    return w;
  }
  function stopWorker(w, why) {
    if (!w || w.dead) return;
    w.stopping = why || 'stop';
    try { w.p.stdin.end(); } catch { /* gone */ }
    setTimeout(() => { if (!w.dead) PROC.killTree(w.p); }, why === 'timeout' ? 0 : 3_000).unref();
  }
  function armIdle(L) {
    const w = L.worker;
    if (!w) return;
    if (w.idle) clearTimeout(w.idle);
    w.idle = setTimeout(() => { if (!L.current && !L.q.length) stopWorker(w, 'idle'); }, IDLE_MS);
    w.idle.unref();
  }
  function failAll(code) {
    for (const L of lanes) for (const q of L.q.splice(0)) { clearTimeout(q.waitT); q.resolve({ ok: false, code }); }
  }
  function finish(L, res) {
    const c = L.current;
    if (!c) return;
    clearTimeout(c.timer);
    clearInterval(c.watch);
    L.current = null;
    c.resolve(res);
    pump(L);
  }
  // Something else needs the card: refuse what waits and hand the memory back.
  function rest() {
    failAll('followbusy');
    for (const L of lanes) if (L.worker && !L.current) stopWorker(L.worker, 'owner');
  }

  function ensureWorker(L) {
    if (L.worker && !L.worker.dead) return L.worker.ready ? Promise.resolve(true) : L.worker.readyP;
    if (L.booting) return L.booting;
    const before = starting;
    let release;
    starting = new Promise((r) => { release = r; });
    L.booting = (async () => {
      await before;
      L.worker = startWorker(L);
      const ok = L.worker ? await L.worker.readyP : false;
      release();
      L.booting = null;
      return ok;
    })();
    return L.booting;
  }

  async function pump(L) {
    if (L.pumping || L.current) return;
    L.pumping = true;
    try {
      for (;;) {
        let c = null;
        while (!c && L.q.length) {
          const q = L.q.shift();
          clearTimeout(q.waitT);
          if (q.gone && q.gone()) { q.resolve({ ok: false, code: 'gone' }); continue; }
          c = q;
        }
        if (!c) { armIdle(L); return; }
        const free = computing() ? await stillFreeWhileComputing() : await sampleFree();
        if (Date.now() < offUntil || !free) {
          c.resolve({ ok: false, code: 'followbusy' });
          rest();
          return;
        }
        // A mark never waits out a cold start past its deadline: it is told the tracker is warming
        // up, and the boot carries on in the background so the next mark is instant.
        const left = c.op === 'seg' ? Math.max(0, c.deadline - Date.now()) : START_TIMEOUT_MS * 2 + 5_000;
        const up = await Promise.race([ensureWorker(L), new Promise((r) => setTimeout(() => r('late'), left))]);
        if (up === 'late') { c.resolve({ ok: false, code: 'warming' }); continue; }
        const w = L.worker;
        if (!w) { c.resolve({ ok: false, code: 'nofollow' }); continue; }
        if (!up) { L.q.unshift(c); continue; }
        if (w.idle) { clearTimeout(w.idle); w.idle = null; }
        if (c.gone && c.gone()) { c.resolve({ ok: false, code: 'gone' }); continue; }
        c.w = w;
        c.id = ++seq;
        c.startedAt = Date.now();
        L.current = c;
        c.timer = setTimeout(() => { stopWorker(w, 'timeout'); }, c.timeoutMs);
        c.watch = setInterval(async () => {
          if (L.current !== c) return;
          if (!(await stillFreeWhileComputing())) { stopWorker(w, 'owner'); rest(); }
        }, WATCH_MS);
        try { w.p.stdin.write(JSON.stringify(Object.assign({ id: c.id, op: c.op }, c.body)) + '\n'); }
        catch { stopWorker(w, 'write'); }
        return;
      }
    } finally { L.pumping = false; }
  }

  // Admission. Answers at once: { ok:false, code } when refused, or { ok:true, done } where done
  // resolves with the worker's answer.
  async function enqueue(op, body, timeoutMs, opts) {
    opts = opts || {};
    const L = op === 'seg' ? segLane : trackLane;
    if (!available()) return { ok: false, code: 'nofollow' };
    if (Date.now() < offUntil) return { ok: false, code: 'followbusy' };
    if (L.q.length + (L.current ? 1 : 0) >= L.max) return { ok: false, code: 'busy' };
    if (!(await gpuFree())) return { ok: false, code: 'followbusy' };
    let resolve;
    const done = new Promise((r) => { resolve = r; });
    const q = { op, body, timeoutMs, onProgress: opts.onProgress, gone: opts.gone, resolve };
    if (op === 'seg') {
      q.deadline = Date.now() + SEG_WAIT_MS;
      q.waitT = setTimeout(() => {
        const i = L.q.indexOf(q);
        if (i >= 0) { L.q.splice(i, 1); resolve({ ok: false, code: 'busy' }); }
      }, SEG_WAIT_MS);
    }
    L.q.push(q);
    pump(L);
    return { ok: true, done };
  }
  async function call(op, body, timeoutMs, opts) {
    const a = await enqueue(op, body, timeoutMs, opts);
    return a.ok ? a.done : a;
  }

  /* ---- sessions ------------------------------------------------------------------------------- */
  function probeClip(file) {
    return new Promise((resolve) => {
      execFile(FFMPEG, ['-hide_banner', '-nostdin', '-protocol_whitelist', 'file', '-i', file], { windowsHide: true, timeout: 20_000 }, (err, so, se) => {
        const s = String(se || '');
        const v = /Stream #\d+:\d+[^\n]*Video:[^\n]*?\b(\d{2,5})x(\d{2,5})\b[^\n]*?([\d.]+) fps/.exec(s);
        const d = /Duration: (\d+):(\d+):([\d.]+)/.exec(s);
        if (!v) return resolve(null);
        resolve({ w: Number(v[1]), h: Number(v[2]), fps: Number(v[3]) || 30, dur: d ? Number(d[1]) * 3600 + Number(d[2]) * 60 + Number(d[3]) : 0 });
      });
    });
  }

  // Cut the range into the session's master clip, then frames for the tracker.
  // j: the session job ({ dir, percent, proc }). Returns { ok, meta } and never throws.
  async function prepare(j, srcFile, range, env) {
    const master = path.join(j.dir, 'master.mp4');
    j.stage = 'cutting';
    const cut = await CLIP.runClip(FFMPEG, CLIP.buildClipArgs({ src: srcFile, out: master, kind: 'video', start: range.start, len: range.len }), range.len, env, j, (pct) => { j.percent = pct * 0.5; }, j.dir);
    if (cut.code !== 0) return { ok: false };
    if (j.cancelled) return { ok: false };
    const info = await probeClip(master);
    if (!info || info.w < 16 || info.h < 16) return { ok: false };
    const len = range.len;
    const fps = Math.max(FPS_MIN, Math.min(FPS_MAX, Math.floor(info.fps + 0.01), Math.floor(FRAME_BUDGET / Math.max(1, len))));
    const dir = path.join(j.dir, 'frames');
    try { fs.mkdirSync(dir, { recursive: true }); } catch { return { ok: false }; }
    const L = FRAME_LONG_SIDE;
    const args = ['-y', '-nostdin', '-v', 'error', '-protocol_whitelist', 'file', '-i', master,
      '-vf', 'fps=' + fps + ",scale='if(gt(iw,ih),min(" + L + ",iw),-2)':'if(gt(iw,ih),-2,min(" + L + ",ih))'",
      '-frames:v', String(FRAME_BUDGET + 30), '-q:v', '3', '-progress', 'pipe:1', '-nostats', path.join(dir, 'f%05d.jpg')];
    j.stage = 'frames';
    const r = await CLIP.runClip(FFMPEG, args, len, env, j, (pct) => { j.percent = 50 + pct * 0.5; }, j.dir);
    if (r.code !== 0) return { ok: false };
    let n = 0;
    try { n = fs.readdirSync(dir).filter((x) => /^f\d{5}\.jpg$/.test(x)).length; } catch { n = 0; }
    if (n < 2) return { ok: false };
    let size = 0;
    try { size = fs.statSync(master).size; } catch { size = 0; }
    return { ok: true, file: master, size, meta: { n, fps, w: info.w, h: info.h, len: Math.round(n / fps * 10) / 10 } };
  }

  // Click points from the page, down to numbers: [[x, y, 1|0], ...] with x, y fractions of the frame.
  function cleanPoints(list) {
    if (!Array.isArray(list)) return null;
    const out = [];
    for (const p of list.slice(0, MAX_POINTS)) {
      if (!Array.isArray(p) || p.length < 3) continue;
      const x = Number(p[0]), y = Number(p[1]), l = Number(p[2]);
      if (!Number.isFinite(x) || !Number.isFinite(y) || x < 0 || x > 1 || y < 0 || y > 1 || (l !== 0 && l !== 1)) continue;
      out.push([Math.round(x * 1e4) / 1e4, Math.round(y * 1e4) / 1e4, l]);
    }
    return out.some((p) => p[2] === 1) ? out : null;
  }
  const cleanFrame = (f, n) => { const v = Math.round(Number(f)); return Number.isInteger(v) && v >= 0 && v < n ? v : -1; };

  async function seg(j, body, opts) {
    const meta = j.follow;
    const frame = cleanFrame(body && body.frame, meta.n);
    const points = cleanPoints(body && body.points);
    if (frame < 0 || !points) return { ok: false, code: 'badrequest' };
    const r = await call('seg', { dir: path.join(j.dir, 'frames'), frame, points }, SEG_TIMEOUT_MS, { gone: () => j.state !== 'ready' || !!(opts && opts.gone && opts.gone()) });
    if (!r.ok) return r;
    return { ok: true, box: r.result.box || null, outline: Array.isArray(r.result.outline) ? r.result.outline : [] };
  }

  function cleanObjects(list, n) {
    if (!Array.isArray(list)) return null;
    const out = [], seen = new Set();
    for (const o of list.slice(0, 16)) {
      if (out.length >= LABELS.TAGS_MAX) break;
      const id = Math.round(Number(o && o.id));
      if (!Number.isInteger(id) || id < 0 || id >= LABELS.TAGS_MAX || seen.has(id)) continue;
      const prompts = [];
      for (const pr of Array.isArray(o.prompts) ? o.prompts.slice(0, MAX_PROMPTS) : []) {
        const frame = cleanFrame(pr && pr.frame, n);
        const points = cleanPoints(pr && pr.points);
        if (frame >= 0 && points) prompts.push({ frame, points });
      }
      if (!prompts.length) continue;
      seen.add(id);
      out.push({ id, prompts });
    }
    return out.length ? out : null;
  }

  // Starts tracking and returns at once; progress and the result land on j.track.
  async function track(j, body) {
    const objects = cleanObjects(body && body.objects, j.follow.n);
    if (!objects) return { ok: false, code: 'badrequest' };
    if (j.track && j.track.state === 'running') return { ok: false, code: 'busy' };
    const run = { state: 'running', progress: 0, result: null, code: '', at: Date.now() };
    const before = j.track;
    j.track = run;
    const adm = await enqueue('track', { dir: path.join(j.dir, 'frames'), objects }, TRACK_TIMEOUT_MS,
      { gone: () => j.state !== 'ready' || j.track !== run, onProgress: (p) => { run.progress = p; } });
    if (!adm.ok) { if (j.track === run) j.track = before; return adm; }
    adm.done.then((r) => {
      if (j.track !== run) return;
      if (!r.ok) { run.state = 'error'; run.code = r.code; return; }
      const res = r.result || {};
      run.result = { fps: j.follow.fps, n: Number(res.n) || j.follow.n, objects: Array.isArray(res.objects) ? res.objects : [] };
      run.state = 'done';
      run.progress = 100;
    });
    return { ok: true };
  }

  // What the page gets back: the guarded tracks and the lost stretches per marked thing.
  function trackView(j) {
    const t = j.track;
    if (!t) return { state: 'none' };
    const v = { state: t.state, progress: Math.round(t.progress) };
    if (t.state === 'error') v.code = t.code;
    if (t.state === 'done') {
      v.fps = t.result.fps; v.n = t.result.n;
      v.objects = t.result.objects.map((o) => ({ id: o.id, f: o.f, lost: Array.isArray(o.lost) ? o.lost.slice(0, 50) : [] }));
    }
    return v;
  }

  function precheckRender(j, body, gifMax) {
    if (!j.track || j.track.state !== 'done') return { ok: false, code: 'notracked' };
    if (body && body.kind === 'gif' && j.follow.len > gifMax + 0.5) return { ok: false, code: 'badclip' };
    const made = LABELS.buildAss(j.track.result, body && body.tags, body && body.look, j.follow.w, j.follow.h);
    if (!made.events) return { ok: false, code: 'notags' };
    return { ok: true };
  }

  // Burn the labels into the session's clip. out: a fresh render job ({ dir }). Resolves { ok, file, size, ext }.
  async function render(j, body, out, env, onProgress, gifMax) {
    if (!j.track || j.track.state !== 'done') return { ok: false, code: 'notracked' };
    const kind = body && body.kind === 'gif' ? 'gif' : 'video';
    if (kind === 'gif' && j.follow.len > gifMax + 0.5) return { ok: false, code: 'badclip' };
    const made = LABELS.buildAss(j.track.result, body && body.tags, body && body.look, j.follow.w, j.follow.h);
    if (!made.events) return { ok: false, code: 'notags' };
    try { fs.writeFileSync(path.join(out.dir, LABELS.ASS_NAME), made.ass); } catch { return { ok: false, code: 'renderfail' }; }
    const vf = LABELS.tagsFilter();
    const master = j.file;
    const gw = CLIP.GIF_WIDTHS.includes(Number(body && body.gifWidth)) ? Number(body.gifWidth) : 480;
    const file = path.join(out.dir, 'followed.' + (kind === 'gif' ? 'gif' : 'mp4'));
    const head = ['-y', '-nostdin', '-v', 'error', '-protocol_whitelist', 'file', '-i', master];
    const args = kind === 'gif'
      ? [...head, '-an', '-vf', vf + ',fps=12,scale=' + gw + ':-1:flags=lanczos,split[s0][s1];[s0]palettegen[p];[s1][p]paletteuse', '-loop', '0']
      : [...head, '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-pix_fmt', 'yuv420p', '-vf', vf,
        '-c:a', 'copy', '-movflags', '+faststart'];
    args.push('-progress', 'pipe:1', '-nostats', file);
    const r = await CLIP.runClip(FFMPEG, args, j.follow.len, env, out, onProgress, out.dir);
    let size = 0;
    try { size = fs.statSync(file).size; } catch { size = 0; }
    if (r.code !== 0 || size <= 0) return { ok: false, code: 'renderfail' };
    return { ok: true, file, size, ext: kind === 'gif' ? 'gif' : 'mp4' };
  }

  function shutdown() { failAll('followbusy'); for (const L of lanes) if (L.worker) stopWorker(L.worker, 'shutdown'); }

  return { available, set, prepare, seg, track, trackView, precheckRender, render, shutdown, gpuFree };
}

module.exports = { createFollow, TRACK_PY };
