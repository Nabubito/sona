// ═══════════════════════════════════════════════════════════════
//  Kin — private fleet messenger for two.
//  Passcode gate · saved history · attachments · WebRTC voice/video.
//  Security: per-IP brute-force lock, random session tokens (in-memory,
//  cold-start on restart), auth-gated file access, strict headers, CSP.
// ═══════════════════════════════════════════════════════════════
'use strict';
const express = require('express');
const http    = require('http');
const path    = require('path');
const fs      = require('fs');
const crypto  = require('crypto');
const multer  = require('multer');
const { WebSocketServer } = require('ws');
const db = require('./db');
const push = require('./push');

const APP      = __dirname;
const PORT     = process.env.PORT || 3095;
const UPLOADS  = path.join(APP, 'uploads');
const CONFIG_PATH = path.join(APP, 'config.json');
const MAX_UPLOAD = 250 * 1024 * 1024;           // 250 MB
const TOKEN_TTL  = 1000 * 60 * 60 * 12;          // 12h session token life
const HISTORY_PAGE = 50;

function loadConfig() {
  // Prefer your private config.json; fall back to the shipped example so a fresh
  // clone runs out of the box. Copy config.example.json -> config.json and edit it.
  for (const p of [CONFIG_PATH, path.join(APP, 'config.example.json')]) {
    try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { }
  }
  return { users: {}, iceServers: [{ urls: 'stun:stun.l.google.com:19302' }], turn: {} };
}
let CONFIG = loadConfig();

// passcode -> user object.  Never sent to client.
function userForPasscode(pc) { return CONFIG.users[String(pc || '').trim()] || null; }
function userById(id) {
  for (const pc of Object.keys(CONFIG.users)) if (CONFIG.users[pc].id === id) return CONFIG.users[pc];
  return null;
}
function iceConfig() {
  const list = Array.isArray(CONFIG.iceServers) ? CONFIG.iceServers.slice() : [];
  const t = CONFIG.turn;
  if (t && t.urls) list.push({ urls: t.urls, username: t.username, credential: t.credential });
  return list;
}
function rosterPublic() {
  return Object.values(CONFIG.users).map(u => ({ id: u.id, name: u.name, avatar: u.avatar || u.name?.[0] || '?' }));
}

// ── Sessions (in-memory ⇒ a server restart is a true cold start) ──
const tokens = new Map();   // token -> { userId, exp }
function mintToken(userId) {
  const token = crypto.randomBytes(32).toString('hex');
  tokens.set(token, { userId, exp: Date.now() + TOKEN_TTL });
  return token;
}
function validateToken(token) {
  const t = tokens.get(token);
  if (!t) return null;
  if (Date.now() > t.exp) { tokens.delete(token); return null; }
  return t.userId;
}
setInterval(() => { const now = Date.now(); for (const [k, v] of tokens) if (now > v.exp) tokens.delete(k); }, 60_000).unref();

// ── Brute-force lock per IP ──
const attempts = new Map();  // ip -> { count, until }
const MAX_ATTEMPTS = 5, LOCK_MS = 60_000;
function ipOf(req) {
  return (req.headers['cf-connecting-ip'] || req.headers['x-forwarded-for'] || req.socket.remoteAddress || '')
    .toString().split(',')[0].trim();
}
function isLocked(ip) { const a = attempts.get(ip); return a && a.until > Date.now(); }
function recordFail(ip) {
  const a = attempts.get(ip) || { count: 0, until: 0 };
  a.count++;
  if (a.count >= MAX_ATTEMPTS) { a.until = Date.now() + LOCK_MS; a.count = 0; }
  attempts.set(ip, a);
}
function clearFail(ip) { attempts.delete(ip); }

// ── App ──
const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '1mb' }));

// Security headers (CSP tuned for our own inline bootstrap + wss + blob media).
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Permissions-Policy', 'microphone=(self), camera=(self), geolocation=()');
  res.setHeader('Content-Security-Policy', [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "media-src 'self' blob:",
    "connect-src 'self' ws: wss:",
    "font-src 'self'",
    "object-src 'none'",
    "base-uri 'none'",
    "frame-ancestors 'none'"
  ].join('; '));
  next();
});

// Auth middleware for API (token via header or query).
function authApi(req, res, next) {
  const token = req.headers['x-kin-token'] || req.query.token || '';
  const userId = validateToken(String(token));
  if (!userId) return res.status(401).json({ error: 'unauthorized' });
  req.userId = userId;
  next();
}

// ── Auth endpoints ──
app.post('/api/login', (req, res) => {
  const ip = ipOf(req);
  if (isLocked(ip)) return res.status(429).json({ error: 'Too many attempts. Wait a minute.' });
  const u = userForPasscode(req.body && req.body.passcode);
  if (!u) { recordFail(ip); return res.status(401).json({ error: 'Wrong passcode' }); }
  clearFail(ip);
  const token = mintToken(u.id);
  res.json({ token, user: { id: u.id, name: u.name, avatar: u.avatar || u.name[0], owner: u.id === CONFIG.owner }, roster: rosterPublic(), ice: iceConfig() });
});

app.post('/api/logout', authApi, (req, res) => {
  const token = req.headers['x-kin-token'] || req.query.token || '';
  tokens.delete(String(token));
  res.json({ ok: true });
});

app.get('/api/session', authApi, (req, res) => {
  const u = userById(req.userId);
  res.json({ user: { id: u.id, name: u.name, avatar: u.avatar || u.name[0], owner: u.id === CONFIG.owner }, roster: rosterPublic(), ice: iceConfig() });
});

// ── Web Push subscription ──
app.get('/api/push/pubkey', authApi, (_req, res) => res.json({ key: push.publicKey }));
app.post('/api/push/subscribe', authApi, (req, res) => { push.subscribe(req.userId, req.body && req.body.sub); res.json({ ok: true }); });
app.post('/api/push/unsubscribe', authApi, (req, res) => { push.unsubscribe(req.body && req.body.endpoint); res.json({ ok: true }); });

// ── GIFs & animated stickers (Giphy proxy; self-hosted on send) ──
const GIPHY_KEY = process.env.GIPHY_KEY || 'dc6zaTOxFJmzC';   // public free beta key
const GIF_HOST = /(^|\.)giphy\.com$/;
app.get('/api/gif/search', authApi, async (req, res) => {
  const kind = req.query.kind === 'stickers' ? 'stickers' : 'gifs';
  const query = (req.query.q || '').toString().slice(0, 80);
  const path2 = query
    ? `${kind}/search?q=${encodeURIComponent(query)}&limit=24&rating=pg-13&bundle=messaging_non_clips`
    : `${kind}/trending?limit=24&rating=pg-13`;
  try {
    const j = await fetch(`https://api.giphy.com/v1/${path2}&api_key=${GIPHY_KEY}`, { signal: AbortSignal.timeout(8000) }).then(r => r.json());
    const items = (j.data || []).map(g => {
      const im = g.images || {};
      const thumbUrl = (im.fixed_width_small && (im.fixed_width_small.webp || im.fixed_width_small.url)) || (im.fixed_width && im.fixed_width.url) || '';
      return { id: g.id, thumb: '/api/gif/thumb?u=' + encodeURIComponent(thumbUrl), w: +((im.fixed_width || {}).width) || 160, h: +((im.fixed_width || {}).height) || 160 };
    }).filter(x => x.thumb.length > 20);
    res.json({ items, kind });
  } catch { res.status(502).json({ error: 'gif search failed' }); }
});
app.get('/api/gif/thumb', authApi, async (req, res) => {
  let u; try { u = new URL(req.query.u); } catch { return res.status(400).end(); }
  if (!GIF_HOST.test(u.hostname)) return res.status(400).end();
  try {
    const r = await fetch(u, { signal: AbortSignal.timeout(8000) });
    res.setHeader('Content-Type', r.headers.get('content-type') || 'image/webp');
    res.setHeader('Cache-Control', 'public, max-age=86400');
    res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox");
    res.end(Buffer.from(await r.arrayBuffer()));
  } catch { res.status(502).end(); }
});
app.post('/api/gif/send', authApi, async (req, res) => {
  const id = String((req.body && req.body.id) || '').replace(/[^a-zA-Z0-9]/g, '').slice(0, 64);
  const kind = req.body && req.body.kind === 'stickers' ? 'stickers' : 'gifs';
  if (!id) return res.status(400).json({ error: 'no id' });
  try {
    const meta = await fetch(`https://api.giphy.com/v1/${kind}/${id}?api_key=${GIPHY_KEY}`, { signal: AbortSignal.timeout(8000) }).then(r => r.json());
    const orig = meta.data && meta.data.images && meta.data.images.original;
    const url = orig && orig.url;
    if (!url) throw new Error('no original');
    const gu = new URL(url);
    if (!GIF_HOST.test(gu.hostname)) throw new Error('bad host');
    const buf = Buffer.from(await fetch(gu, { signal: AbortSignal.timeout(12000) }).then(r => r.arrayBuffer()));
    if (buf.length > 15 * 1024 * 1024) throw new Error('too big');
    const disk = crypto.randomBytes(20).toString('hex');
    fs.writeFileSync(path.join(UPLOADS, disk), buf);
    const aid = crypto.randomBytes(12).toString('hex');
    db.addAttachment({ id: aid, orig_name: (kind === 'stickers' ? 'sticker' : 'gif') + '.gif', mime: 'image/gif', size: buf.length, disk_name: disk, owner: req.userId });
    res.json({ id: aid, kind: kind === 'stickers' ? 'sticker' : 'image', url: `/api/file/${aid}` });
  } catch { res.status(502).json({ error: 'gif fetch failed' }); }
});

// ── Static map proxy for location messages (OSM, with SVG fallback) ──
function fallbackMapSVG(lat, lng) {
  const gx = i => 20 + i * 60;
  let grid = '';
  for (let i = 0; i < 9; i++) grid += `<line x1="${gx(i)}" y1="0" x2="${gx(i)}" y2="260" stroke="rgba(0,0,0,.08)"/>`;
  for (let i = 0; i < 5; i++) grid += `<line x1="0" y1="${20 + i * 60}" x2="520" y2="${20 + i * 60}" stroke="rgba(0,0,0,.08)"/>`;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="520" height="260">
    <rect width="520" height="260" fill="#e8eef3"/>${grid}
    <path d="M0 170 Q 130 120 260 160 T 520 150" fill="none" stroke="#b8cbd8" stroke-width="10"/>
    <circle cx="260" cy="130" r="10" fill="#c0392b"/><circle cx="260" cy="130" r="20" fill="#c0392b" opacity="0.2"/>
    <text x="260" y="235" text-anchor="middle" font-family="Segoe UI,sans-serif" font-size="13" fill="#5a6678">${lat.toFixed(5)}, ${lng.toFixed(5)}</text>
  </svg>`;
}
app.get('/api/staticmap', authApi, async (req, res) => {
  const lat = parseFloat(req.query.lat), lng = parseFloat(req.query.lng);
  if (!isFinite(lat) || !isFinite(lng)) return res.status(400).end();
  const z = Math.min(18, Math.max(1, parseInt(req.query.z, 10) || 15));
  const url = `https://staticmap.openstreetmap.de/staticmap.php?center=${lat},${lng}&zoom=${z}&size=520x260&markers=${lat},${lng},red-pushpin`;
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(6000) });
    if (!r.ok) throw new Error('map ' + r.status);
    res.setHeader('Content-Type', 'image/png');
    res.setHeader('Cache-Control', 'public, max-age=3600');
    res.end(Buffer.from(await r.arrayBuffer()));
  } catch {
    res.setHeader('Content-Type', 'image/svg+xml');
    res.end(fallbackMapSVG(lat, lng));
  }
});

// ── Schedule send ──
app.post('/api/schedule', authApi, (req, res) => {
  const b = req.body || {};
  const kind = ['text', 'image', 'video', 'file', 'audio', 'location', 'sticker'].includes(b.kind) ? b.kind : 'text';
  const sendAt = parseInt(b.send_at, 10);
  if (!sendAt || sendAt < Date.now() + 3000) return res.status(400).json({ error: 'Pick a future time' });
  if (!b.text && !b.att_id) return res.status(400).json({ error: 'Nothing to schedule' });
  const row = db.addScheduled({ sender: req.userId, kind, text: b.text ? String(b.text).slice(0, 8000) : null, att_id: b.att_id || null, reply_to: b.reply_to || null, send_at: sendAt });
  res.json({ scheduled: row });
});
app.get('/api/scheduled', authApi, (req, res) => res.json({ items: db.listScheduled(req.userId) }));
app.delete('/api/scheduled/:id', authApi, (req, res) => res.json({ ok: db.cancelScheduled(parseInt(req.params.id, 10), req.userId) }));

// ── Clear whole conversation (owner only) ──
app.post('/api/clear', authApi, (req, res) => {
  if (req.userId !== CONFIG.owner) return res.status(403).json({ error: 'Only the owner can clear the chat' });
  const files = db.clearConversation();
  for (const f of files) { try { fs.unlinkSync(path.join(UPLOADS, path.basename(f))); } catch {} }
  broadcast({ t: 'cleared' });
  res.json({ ok: true });
});

// ── History paging ──
app.get('/api/history', authApi, (req, res) => {
  const before = parseInt(req.query.before, 10);
  const rows = before ? db.before(before, HISTORY_PAGE) : db.recent(HISTORY_PAGE);
  res.json({ messages: rows });
});

// ── Attachments ──
const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, UPLOADS),
  filename: (_req, _file, cb) => cb(null, crypto.randomBytes(20).toString('hex'))
});
const upload = multer({ storage, limits: { fileSize: MAX_UPLOAD } });

app.post('/api/upload', authApi, upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'no file' });
  const id = crypto.randomBytes(12).toString('hex');
  const orig = path.basename(req.file.originalname || 'file').slice(0, 200);
  db.addAttachment({
    id, orig_name: orig, mime: req.file.mimetype || 'application/octet-stream',
    size: req.file.size, disk_name: req.file.filename, owner: req.userId
  });
  const mime = req.file.mimetype || '';
  const kind = mime.startsWith('image/') ? 'image'
    : mime.startsWith('video/') ? 'video'
    : mime.startsWith('audio/') ? 'audio' : 'file';
  res.json({ id, name: orig, mime, size: req.file.size, kind, url: `/api/file/${id}` });
});

app.get('/api/file/:id', authApi, (req, res) => {
  const a = db.getAttachment(req.params.id);
  if (!a) return res.status(404).end();
  const disk = path.join(UPLOADS, path.basename(a.disk_name));   // basename ⇒ no traversal
  if (!disk.startsWith(UPLOADS) || !fs.existsSync(disk)) return res.status(404).end();
  res.setHeader('Content-Type', a.mime);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  // Neutralize any active content (e.g. a booby-trapped SVG/HTML) even if a peer
  // opens it top-level: this CSP forbids scripts and same-origin access.
  res.setHeader('Content-Security-Policy', "default-src 'none'; img-src 'self'; media-src 'self'; style-src 'unsafe-inline'; sandbox");
  // Inline only inert, browser-native media. SVG can carry script ⇒ force download.
  const base = String(a.mime).split(';')[0].trim();
  const inline = /^(image\/(png|jpe?g|gif|webp|bmp|avif)|video\/[\w.+-]+|audio\/[\w.+-]+)$/.test(base);
  res.setHeader('Content-Disposition',
    `${inline ? 'inline' : 'attachment'}; filename="${encodeURIComponent(a.orig_name)}"`);
  fs.createReadStream(disk).pipe(res);
});

// ── Cache-busting: stamp every asset URL with a content hash so a changed
// file is always a NEW url (guaranteed miss past Cloudflare's 4h edge cache),
// while an unchanged file keeps its long cache. Hash is recomputed only when
// the file's mtime moves, so serving stays cheap.
const PUB = path.join(APP, 'public');
const _verCache = new Map(); // file -> { mtime, hash }
function assetVer(file) {
  try {
    const full = path.join(PUB, file);
    const mtime = fs.statSync(full).mtimeMs;
    const hit = _verCache.get(file);
    if (hit && hit.mtime === mtime) return hit.hash;
    const hash = crypto.createHash('md5').update(fs.readFileSync(full)).digest('hex').slice(0, 8);
    _verCache.set(file, { mtime, hash });
    return hash;
  } catch { return '0'; }
}
// Serve the app shell dynamically: never cached, asset links freshly stamped.
app.get(['/', '/index.html'], (_req, res) => {
  let html;
  try { html = fs.readFileSync(path.join(PUB, 'index.html'), 'utf8'); }
  catch { return res.status(500).send('shell missing'); }
  html = html
    .replace(/\/style\.css(\?v=[^"']*)?/g, `/style.css?v=${assetVer('style.css')}`)
    .replace(/\/emoji\.js(\?v=[^"']*)?/g,  `/emoji.js?v=${assetVer('emoji.js')}`)
    .replace(/\/app\.js(\?v=[^"']*)?/g,    `/app.js?v=${assetVer('app.js')}`);
  // Expose the sw version so app.js can register /sw.js?v=… and pick up SW changes.
  html = html.replace('</head>', `<script>window.__SWV='${assetVer('sw.js')}'</script></head>`);
  res.setHeader('Cache-Control', 'no-store, must-revalidate');
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(html);
});
// The service worker script must also never be pinned stale by the edge.
app.get('/sw.js', (_req, res) => {
  res.setHeader('Cache-Control', 'no-store, must-revalidate');
  res.setHeader('Service-Worker-Allowed', '/');
  res.setHeader('Content-Type', 'application/javascript; charset=utf-8');
  res.send(fs.readFileSync(path.join(PUB, 'sw.js')));
});

// PWA + static
app.use(express.static(path.join(APP, 'public'), { index: 'index.html', maxAge: '5m' }));
app.get('/healthz', (_req, res) => res.json({ ok: true, up: process.uptime() }));

// ── HTTP + WS ──
const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 2 * 1024 * 1024 });

// userId -> Set<ws>
const online = new Map();
function addClient(userId, ws) {
  if (!online.has(userId)) online.set(userId, new Set());
  online.get(userId).add(ws);
}
function removeClient(userId, ws) {
  const set = online.get(userId);
  if (set) { set.delete(ws); if (!set.size) online.delete(userId); }
}
function onlineIds() { return [...online.keys()]; }
function sendTo(userId, obj) {
  const set = online.get(userId);
  if (!set) return;
  const s = JSON.stringify(obj);
  for (const ws of set) if (ws.readyState === ws.OPEN) ws.send(s);
}
function broadcast(obj, exceptWs) {
  const s = JSON.stringify(obj);
  for (const set of online.values()) for (const ws of set)
    if (ws !== exceptWs && ws.readyState === ws.OPEN) ws.send(s);
}
function relayToOthers(fromUserId, obj) {
  for (const uid of online.keys()) if (uid !== fromUserId) sendTo(uid, obj);
}
function everyoneElse(fromUserId) { return Object.values(CONFIG.users).map(u => u.id).filter(id => id !== fromUserId); }
function previewFor(m) {
  if (m.kind === 'image') return '🖼️ Photo' + (m.text ? ' · ' + m.text : '');
  if (m.kind === 'video') return '🎬 Video' + (m.text ? ' · ' + m.text : '');
  if (m.kind === 'audio') return '🎤 Voice message';
  if (m.kind === 'sticker') return '✨ Sticker';
  if (m.kind === 'location') return '📍 Location';
  if (m.kind === 'file') return '📎 ' + (m.att ? m.att.name : 'File');
  return (m.text || '').slice(0, 140);
}
function pushToOthers(fromUserId, payload) {
  for (const uid of new Set(everyoneElse(fromUserId))) push.sendToUser(uid, payload).catch(() => {});
}

function originAllowed(origin) {
  if (!origin) return true;                    // native apps / non-browser clients send none
  try {
    const h = new URL(origin).hostname;
    if (h === 'localhost' || h === '127.0.0.1' || h === '::1') return true;
    if (/\.ts\.net$/.test(h)) return true;                          // Tailscale MagicDNS (default ingress)
    if (/^10\./.test(h) || /^192\.168\./.test(h)) return true;      // LAN
    if (/^172\.(1[6-9]|2\d|3[01])\./.test(h)) return true;          // LAN (172.16/12)
    if (/^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(h)) return true; // Tailscale CGNAT 100.64/10
    const extra = (process.env.SONA_HOSTS || '').split(',').map(s => s.trim()).filter(Boolean);
    if (extra.includes(h)) return true;          // optional custom domain(s) the user runs behind
    return false;
  } catch { return false; }
}

wss.on('connection', (ws, req) => {
  if (!originAllowed(req.headers.origin)) { ws.close(4003, 'forbidden origin'); return; }
  const url = new URL(req.url, 'http://x');
  const userId = validateToken(url.searchParams.get('token') || '');
  if (!userId) { ws.close(4001, 'unauthorized'); return; }
  ws.userId = userId;
  ws.isAlive = true;
  addClient(userId, ws);

  // announce presence + hand over current roster of online ids
  ws.send(JSON.stringify({ t: 'welcome', you: userId, online: onlineIds() }));
  broadcast({ t: 'presence', online: onlineIds() });

  ws.on('pong', () => { ws.isAlive = true; });

  ws.on('message', (raw) => {
    let m; try { m = JSON.parse(raw); } catch { return; }
    switch (m.t) {
      case 'msg': {
        const kind = ['text', 'image', 'video', 'file', 'audio', 'location', 'sticker'].includes(m.kind) ? m.kind : 'text';
        const text = typeof m.text === 'string' ? m.text.slice(0, 8000) : null;
        const attId = m.att_id ? String(m.att_id) : null;
        const replyTo = m.reply_to ? parseInt(m.reply_to, 10) : null;
        if (!text && !attId) return;
        const saved = db.addMessage(userId, kind, text, attId, replyTo);
        broadcast({ t: 'msg', message: saved });
        pushToOthers(userId, { title: (userById(userId) || {}).name || 'Kin', body: previewFor(saved), tag: 'kin-msg', url: '/' });
        break;
      }
      case 'typing':
        relayToOthers(userId, { t: 'typing', user: userId, on: !!m.on });
        break;
      case 'delivered': {
        // peer's device received the message — tell the sender (transient, not stored)
        const id = parseInt(m.id, 10);
        if (!id) return;
        relayToOthers(userId, { t: 'delivered', id, by: userId });
        break;
      }
      case 'read': {
        const id = parseInt(m.id, 10);
        if (!id) return;
        const updated = db.markRead(id, userId);
        if (updated) broadcast({ t: 'read', id, by: userId, read_by: updated.read_by });
        break;
      }
      case 'geo': {                       // live-location update to an existing location message
        const id = parseInt(m.id, 10);
        const lat = +m.lat, lng = +m.lng;
        if (!id || !isFinite(lat) || !isFinite(lng)) return;
        const msg = db.getMessage(id);
        if (msg && msg.sender === userId && msg.kind === 'location') {
          let p = {}; try { p = JSON.parse(msg.text || '{}'); } catch {}
          p.lat = lat; p.lng = lng; p.acc = m.acc; p.upd = Date.now();
          db.setText(id, userId, JSON.stringify(p));
        }
        broadcast({ t: 'geo', id, lat, lng, acc: m.acc, by: userId });
        break;
      }
      case 'react': {
        const id = parseInt(m.id, 10);
        if (!id || typeof m.emoji !== 'string') return;
        const updated = db.react(id, userId, m.emoji.slice(0, 8), !!m.on);
        if (updated) broadcast({ t: 'react', message: updated });
        break;
      }
      case 'edit': {
        const id = parseInt(m.id, 10);
        if (!id || typeof m.text !== 'string') return;
        const updated = db.edit(id, userId, m.text.slice(0, 8000));
        if (updated) broadcast({ t: 'edit', message: updated });
        break;
      }
      case 'delete': {
        const id = parseInt(m.id, 10);
        if (!id) return;
        const updated = db.remove(id, userId);
        if (updated) broadcast({ t: 'delete', message: updated });
        break;
      }
      // ── WebRTC signalling (relay only; media is peer-to-peer) ──
      case 'call': {
        // kinds: request | accept | reject | offer | answer | ice | hangup | busy
        const kind = String(m.kind || '');
        if (!kind) return;
        relayToOthers(userId, { t: 'call', kind, from: userId, data: m.data, video: !!m.video });
        if (kind === 'request')
          pushToOthers(userId, { title: (userById(userId) || {}).name || 'Kin', body: (m.video ? '📹' : '📞') + ' Incoming call…', tag: 'kin-call', url: '/', renotify: true });
        break;
      }
      default: break;
    }
  });

  ws.on('close', () => {
    removeClient(userId, ws);
    broadcast({ t: 'presence', online: onlineIds() });
  });
  ws.on('error', () => {});
});

// heartbeat to drop dead sockets
setInterval(() => {
  for (const set of online.values()) for (const ws of set) {
    if (!ws.isAlive) { ws.terminate(); continue; }
    ws.isAlive = false; try { ws.ping(); } catch {}
  }
}, 30_000).unref();

// deliver scheduled messages when due
setInterval(() => {
  for (const s of db.dueScheduled()) {
    try {
      const saved = db.addMessage(s.sender, s.kind, s.text, s.att_id, s.reply_to);
      db.removeScheduled(s.id);
      broadcast({ t: 'msg', message: saved });
      pushToOthers(s.sender, { title: (userById(s.sender) || {}).name || 'Kin', body: previewFor(saved), tag: 'kin-msg', url: '/' });
    } catch (e) { db.removeScheduled(s.id); }
  }
}, 15_000).unref();

server.listen(PORT, () => console.log(`[kin] listening on http://localhost:${PORT}`));
