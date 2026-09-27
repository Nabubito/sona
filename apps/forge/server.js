// Forge by Sona: server. Zero external deps (built-in http). The server IS
// the native helper: it calls ffmpeg / 7-Zip (and on Windows, Mount-DiskImage
// and IMAPI2) directly. Files never leave the box.
//
// Security model, plainly: the passcode is the only wall. A signed-in
// session can read and write files as the account running Forge, but only
// inside the allowed roots (lib/paths.js). Every path from the browser is
// checked there before use.
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const cfg = require('./lib/config');
const engines = require('./lib/engines');
const paths = require('./lib/paths');
const sevenzip = require('./lib/sevenzip');
const disc = require('./lib/disc');
const media = require('./lib/media');
const editor = require('./lib/editor');
const { inspect } = require('./lib/inspect');
const gate = require('./lib/gate');

const PORT = cfg.PORT;
const HOST = cfg.HOST;
const PUBLIC = path.join(__dirname, 'public');
const ASSETS = path.join(PUBLIC, 'assets');
const JSON_LIMIT = 1024 * 1024;   // 1 MB for any JSON body
const KEEP_JOBS = 200;

if (cfg.PASSCODE && cfg.PASSCODE.length < gate.MIN_LEN) {
  console.error(`FORGE_PASS must be at least ${gate.MIN_LEN} characters.`);
  process.exit(1);
}

// ---- jobs + SSE ----
const jobs = new Map();
const sseClients = new Set();
function broadcast(evt) {
  const line = `data: ${JSON.stringify(evt)}\n\n`;
  for (const res of sseClients) { try { res.write(line); } catch {} }
}
function pruneJobs() {
  if (jobs.size <= KEEP_JOBS) return;
  for (const [id, j] of jobs) {             // Map keeps insertion order: oldest first
    if (jobs.size <= KEEP_JOBS) break;
    if (j.status !== 'running') jobs.delete(id);
  }
}
function newJob(tool, label) {
  const id = crypto.randomBytes(5).toString('hex');
  const job = { id, tool, label, status: 'running', progress: 0, out: null, error: null, at: Date.now() };
  jobs.set(id, job);
  pruneJobs();
  broadcast({ type: 'job', job });
  return job;
}
function updateJob(job, patch) {
  Object.assign(job, patch);
  broadcast({ type: 'job', job });
  if (job.status !== 'running') pruneJobs();
}
function track(job, promise) {
  promise
    .then(r => updateJob(job, { status: 'done', progress: 100, out: r.out || r.dest }))
    .catch(e => updateJob(job, { status: 'error', error: String(e.message || e) }));
  return job;
}

// ---- helpers ----
function sendJson(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(obj));
}
function httpError(status, msg) { const e = new Error(msg); e.status = status; return e; }
function readBody(req) {
  return new Promise((resolve, reject) => {
    let b = '', size = 0, over = false;
    req.on('data', d => {
      if (over) return;
      size += d.length;
      if (size > JSON_LIMIT) { over = true; reject(httpError(413, 'Request too large.')); req.resume(); return; }
      b += d;
    });
    req.on('end', () => { if (over) return; try { resolve(b ? JSON.parse(b) : {}); } catch { reject(httpError(400, 'Bad JSON.')); } });
    req.on('error', reject);
  });
}
const isJson = req => String(req.headers['content-type'] || '').toLowerCase().split(';')[0].trim() === 'application/json';

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

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2', '.txt': 'text/plain; charset=utf-8' };
// Only the plain spelling of a file name is accepted: no Windows alternate
// streams (name::$DATA), no trailing dots or spaces, no device names, no "..".
const SAFE_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const WIN_RESERVED = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(\.|$)/i;
function safeSegment(s) {
  return !!s && s.length <= 128 && SAFE_SEGMENT.test(s) && !s.endsWith('.') && !s.includes('..') && !WIN_RESERVED.test(s);
}
function serveStatic(res, root, rel) {
  let segs;
  try { segs = decodeURIComponent(rel).split('/'); } catch { res.writeHead(400); return res.end('bad path'); }
  if (!segs.length || !segs.every(safeSegment)) { res.writeHead(404); return res.end('not found'); }
  const file = path.join(root, ...segs);
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); return res.end('not found'); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(data);
  });
}
function securityHeaders(res) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  // Only this server may be contacted or loaded from. Inline script is still
  // allowed because the UI uses inline handlers; see README.
  res.setHeader('Content-Security-Policy',
    "default-src 'self'; img-src 'self' data: blob:; media-src 'self' blob:; " +
    "script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; font-src 'self'; " +
    "connect-src 'self'; object-src 'none'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'");
}

// path guards
const readPath = p => paths.check(p, { mustExist: true });
const readFile = p => paths.check(p, { mustExist: true, file: true });
const readDir = p => paths.check(p, { mustExist: true, dir: true });
const writePath = p => paths.check(p);
const cleanName = s => String(s || '').replace(/[\\/:*?"<>|\x00-\x1f]/g, '_').replace(/^[.\s]+|[.\s]+$/g, '').slice(0, 120);

// Every source path inside an editor project must be allowed too.
function guardProject(proj) {
  if (!proj || typeof proj !== 'object' || !Array.isArray(proj.tracks)) throw httpError(400, 'Bad project.');
  for (const t of proj.tracks) for (const c of (t && t.clips) || []) if (c && c.src) c.src = readFile(c.src);
  return proj;
}

// ---- media job runner ----
async function runMediaJob(toolId, input, opts) {
  const m = media.byId[toolId];
  if (!m) throw httpError(400, 'unknown tool');
  const src = readFile(input);
  const job = newJob(toolId, `${m.label}: ${path.basename(src)}`);
  try {
    const { out } = await media.runTool(m, src, opts || {}, job.id, (pct) => updateJob(job, { progress: pct }));
    updateJob(job, { status: 'done', progress: 100, out });
  } catch (e) {
    updateJob(job, { status: 'error', error: String(e.message || e) });
  }
  return job;
}

// ---- upload (drag-drop): raw body, ?filename= ; lands in the inbox ----
function handleUpload(req, res, q) {
  const len = Number(req.headers['content-length'] || 0);
  if (len > cfg.MAX_UPLOAD) { req.resume(); return sendJson(res, 413, { error: 'File is larger than the upload limit.' }); }
  try {
    const st = fs.statfsSync(engines.INBOX);
    const free = Number(st.bavail) * Number(st.bsize);
    if (free - (len || 0) < 512 * 1024 ** 2) { req.resume(); return sendJson(res, 507, { error: 'Not enough free disk space for this upload.' }); }
  } catch {}
  let fn = cleanName(q.filename) || 'file';
  if (WIN_RESERVED.test(fn)) fn = '_' + fn;
  const dir = path.join(engines.INBOX, crypto.randomBytes(4).toString('hex'));
  engines.ensureDir(dir);
  const dest = path.join(dir, fn);
  const ws = fs.createWriteStream(dest, { flags: 'wx' });
  let size = 0, failed = false;
  const fail = (code, msg) => {
    if (failed) return; failed = true;
    req.unpipe(ws); ws.destroy(); req.resume();
    fs.rm(dir, { recursive: true, force: true }, () => {});
    sendJson(res, code, { error: msg });
  };
  req.on('data', d => { size += d.length; if (size > cfg.MAX_UPLOAD) fail(413, 'File is larger than the upload limit.'); });
  req.on('aborted', () => fail(400, 'Upload aborted.'));
  ws.on('error', e => fail(500, String(e.message || e)));
  ws.on('finish', () => { if (!failed) sendJson(res, 200, { path: dest.replace(/\\/g, '/') }); });
  req.pipe(ws);
}

// ---- router ----
const server = http.createServer(async (req, res) => {
  let parsed;
  try { parsed = new URL(req.url, 'http://localhost'); } catch { res.writeHead(400); return res.end('bad url'); }
  const q = Object.fromEntries(parsed.searchParams);
  const p = parsed.pathname;
  securityHeaders(res);
  try {
    // ---- above the wall: everything the lock screen needs to render ----
    if (p === '/health') return sendJson(res, 200, { ok: true, app: 'forge' });
    if (req.method === 'GET' && p === '/gate.html') return serveStatic(res, PUBLIC, 'gate.html');
    if (req.method === 'GET' && p.startsWith('/assets/')) return serveStatic(res, ASSETS, p.slice(8));
    if (req.method === 'GET' && (p === '/favicon.ico' || p === '/icon.png')) return serveStatic(res, PUBLIC, 'icon.png');

    // every state-changing request must come from our own page
    if (req.method !== 'GET' && req.method !== 'HEAD' && !sameOrigin(req)) {
      req.resume(); return sendJson(res, 403, { error: 'Cross-site request refused.' });
    }
    if (await gate.handle(req, res, p)) return;

    // ---- the wall ----
    if (!gate.isAuthed(req)) {
      if (p.startsWith('/api/')) return sendJson(res, 401, { error: 'auth' });
      res.writeHead(302, { Location: '/gate.html' }); return res.end();
    }

    // static app shell
    if (req.method === 'GET' && (p === '/' || p === '/index.html')) return serveStatic(res, PUBLIC, 'index.html');
    if (req.method === 'GET' && p.startsWith('/public/')) return serveStatic(res, PUBLIC, p.slice(8));

    // health / engines
    if (p === '/api/health') return sendJson(res, 200, { ...engines.engineStatus(), roots: paths.ROOTS.map(r => r.replace(/\\/g, '/')) });

    // SSE job stream
    if (p === '/api/jobs/stream') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
      res.write('\n');
      sseClients.add(res);
      for (const job of jobs.values()) res.write(`data: ${JSON.stringify({ type: 'job', job })}\n\n`);
      req.on('close', () => sseClients.delete(res));
      return;
    }

    // ---- editor (timeline video editor) GET ----
    if (p === '/api/editor/projects') return sendJson(res, 200, editor.listProjects());
    if (p === '/api/editor/project') {
      const pr = editor.getProject(q.id);
      return pr ? sendJson(res, 200, pr) : sendJson(res, 404, { error: 'not found' });
    }
    if (p === '/api/editor/probe') return sendJson(res, 200, await editor.probe(readFile(q.path)));
    if (p === '/api/editor/thumb') {
      const t = await editor.thumbnail(readFile(q.path), parseFloat(q.t) || 0);
      if (!t || !fs.existsSync(t)) { res.writeHead(404); return res.end('no thumb'); }
      res.writeHead(200, { 'Content-Type': 'image/jpeg', 'Cache-Control': 'max-age=86400' });
      return fs.createReadStream(t).pipe(res);
    }
    // stream a local media file inline for preview (range-aware-lite)
    if (p === '/api/editor/media') {
      const f = readFile(q.path);
      const stat = fs.statSync(f);
      const ext = path.extname(f).toLowerCase();
      const ctype = { '.mp4': 'video/mp4', '.webm': 'video/webm', '.mov': 'video/quicktime',
        '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.m4a': 'audio/mp4', '.png': 'image/png',
        '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif' }[ext] || 'application/octet-stream';
      const m = /^bytes=(\d+)-(\d*)$/.exec(req.headers.range || '');
      if (m) {
        const start = parseInt(m[1], 10);
        const end = Math.min(m[2] ? parseInt(m[2], 10) : stat.size - 1, stat.size - 1);
        if (start > end) { res.writeHead(416, { 'Content-Range': `bytes */${stat.size}` }); return res.end(); }
        res.writeHead(206, { 'Content-Type': ctype, 'Accept-Ranges': 'bytes',
          'Content-Range': `bytes ${start}-${end}/${stat.size}`, 'Content-Length': end - start + 1 });
        return fs.createReadStream(f, { start, end }).pipe(res);
      }
      res.writeHead(200, { 'Content-Type': ctype, 'Content-Length': stat.size, 'Accept-Ranges': 'bytes' });
      return fs.createReadStream(f).pipe(res);
    }

    // filesystem browser (local folder picking), limited to the allowed roots
    if (p === '/api/fs') {
      const start = paths.allowed(cfg.BROWSE_START) ? cfg.BROWSE_START : paths.ROOTS[0];
      const dir = readDir(q.dir || start);
      const entries = fs.readdirSync(dir, { withFileTypes: true }).map(e => ({
        name: e.name, dir: e.isDirectory(), path: path.join(dir, e.name).replace(/\\/g, '/')
      }));
      entries.sort((a, b) => (b.dir - a.dir) || a.name.localeCompare(b.name));
      const parent = path.dirname(dir);
      return sendJson(res, 200, {
        cwd: dir.replace(/\\/g, '/'),
        parent: parent !== dir && paths.allowed(parent) ? parent.replace(/\\/g, '/') : null,
        roots: paths.ROOTS.map(r => r.replace(/\\/g, '/')), entries
      });
    }

    if (p === '/api/upload' && req.method === 'POST') return handleUpload(req, res, q);

    // download a produced (or any allowed) file
    if (p === '/api/download') {
      const f = readFile(q.path);
      const name = cleanName(path.basename(f)) || 'download';
      res.writeHead(200, { 'Content-Type': 'application/octet-stream',
        'Content-Disposition': `attachment; filename="${name.replace(/[^\x20-\x7e]/g, '_')}"; filename*=UTF-8''${encodeURIComponent(name)}` });
      return fs.createReadStream(f).pipe(res);
    }

    // POST endpoints (JSON only)
    if (req.method === 'POST') {
      if (!isJson(req)) { req.resume(); return sendJson(res, 415, { error: 'Expected application/json.' }); }
      const body = await readBody(req);

      if (p === '/api/inspect') return sendJson(res, 200, inspect(String(body.path || '')));

      // container (disc + archive share this)
      if (p === '/api/container/list') return sendJson(res, 200, await sevenzip.list(readFile(body.path)));
      if (p === '/api/container/test') return sendJson(res, 200, await sevenzip.test(readFile(body.path), body.password ? String(body.password) : undefined));
      if (p === '/api/container/extract') {
        const src = readFile(body.path);
        const dest = writePath(body.dest || path.join(engines.OUTDIR, 'extract', cleanName(path.basename(src, path.extname(src))) || 'archive'));
        const sel = Array.isArray(body.selection) ? body.selection.map(String).filter(s => s && !s.includes('\0')).slice(0, 5000) : [];
        return sendJson(res, 200, { jobId: track(newJob('extract', `Extract ${path.basename(src)}`), sevenzip.extract(src, dest, sel)).id });
      }

      // disc (Windows only)
      if (p.startsWith('/api/disc/') && !engines.DISC_AVAILABLE) return sendJson(res, 501, { error: disc.UNAVAILABLE });
      if (p === '/api/disc/mount') return sendJson(res, 200, await disc.mount(readFile(body.path)));
      if (p === '/api/disc/unmount') return sendJson(res, 200, await disc.unmount(readFile(body.path)));
      if (p === '/api/disc/unmount-drive') {
        if (!/^[A-Za-z]$/.test(String(body.drive || ''))) throw httpError(400, 'Bad drive letter.');
        return sendJson(res, 200, await disc.unmountByDrive(String(body.drive).toUpperCase()));
      }
      if (p === '/api/disc/make') {
        const folder = readDir(body.folder);
        const label = String(body.label || '').replace(/[^A-Za-z0-9 _.-]/g, '').slice(0, 32);
        const out = writePath(body.out || path.join(engines.OUTDIR, (cleanName(label) || 'image') + '.iso'));
        return sendJson(res, 200, { jobId: track(newJob('make-iso', `Make ISO: ${path.basename(out)}`), disc.makeIso({ folder, out, label })).id });
      }

      // archive
      if (p === '/api/archive/create') {
        const inputs = Array.isArray(body.inputs) ? body.inputs.slice(0, 1000).map(readPath) : [];
        if (!inputs.length) throw httpError(400, 'Add at least one file.');
        const format = ['7z', 'zip', 'tar'].includes(body.format) ? body.format : '7z';
        const level = Math.min(9, Math.max(0, parseInt(body.level, 10) || 5));
        const split = body.split && /^\d{1,6}[bkmg]?$/i.test(String(body.split)) ? String(body.split) : undefined;
        const out = writePath(body.out || path.join(engines.OUTDIR, 'archive.' + format));
        const job = newJob('archive', `Create ${path.basename(out)}`);
        return sendJson(res, 200, { jobId: track(job, sevenzip.create({ inputs, out, format, level, split, password: body.password ? String(body.password) : undefined })).id });
      }

      // media
      if (p === '/api/media/run') {
        const job = await runMediaJob(String(body.toolId || ''), body.path, body.options);
        return sendJson(res, 200, { jobId: job.id, status: job.status, out: job.out, error: job.error });
      }

      // ---- editor POST ----
      if (p === '/api/editor/new') return sendJson(res, 200, editor.saveProject(editor.blankProject(String(body.name || '').slice(0, 120))));
      if (p === '/api/editor/save') return sendJson(res, 200, editor.saveProject(body.project || body));
      if (p === '/api/editor/delete') return sendJson(res, 200, { ok: editor.deleteProject(body.id) });
      if (p === '/api/editor/render') {
        const proj = guardProject(body.project || editor.getProject(body.id));
        const job = newJob('render', `Render: ${proj.name || 'movie'}`);
        return sendJson(res, 200, { jobId: track(job, editor.renderProject(proj, job.id, (pct) => updateJob(job, { progress: pct }))).id });
      }
    }

    if (p === '/api/disc/mounted') return sendJson(res, 200, await disc.mounted());
    if (p === '/api/tools') return sendJson(res, 200, media.catalog());

    res.writeHead(404); res.end('not found');
  } catch (e) {
    if (!res.headersSent) sendJson(res, (e && e.status) || 500, { error: String(e && e.message || e) });
    else try { res.end(); } catch {}
  }
});

server.listen(PORT, HOST, () => {
  const s = engines.engineStatus();
  const shown = (HOST === '0.0.0.0' || HOST === '::') ? 'localhost' : HOST;
  console.log(`Forge by Sona on http://${shown}:${PORT}  (bound to ${HOST})`);
  for (const e of s.engines) console.log(`  ${e.present ? 'found  ' : 'MISSING'} ${e.label}${e.present ? '' : '   install: ' + e.install}`);
  console.log(`  disc tools: ${s.disc.available ? 'available' : 'off (' + s.disc.reason + ')'}`);
  console.log(`  output dir: ${s.outdir}`);
  console.log(`  allowed roots: ${paths.ROOTS.join(' | ')}`);
  if (gate.mode() === 'setup') console.log('  first run: open the page on this machine to choose your passcode.');
});
