const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn, execSync } = require('child_process');
const net = require('net');
const { WebSocketServer } = require('ws');
const { open, migrate, decadeOf, ART_DIR, DB_PATH } = require('./db');
const { fetchArtistBio } = require('./bio-fetch');
const {
  generateRegistrationOptions, verifyRegistrationResponse,
  generateAuthenticationOptions, verifyAuthenticationResponse,
} = require('@simplewebauthn/server');

const app = express();
const PORT = process.env.PORT || 3010;
const APP = __dirname;
const PUBLIC_DIR = path.join(APP, 'public');
const CONFIG_PATH = path.join(APP, 'config.json');
const PROGRESS_PATH = path.join(APP, 'scan-progress.json');

// sane music timeline — bad tags love to spit out year 0, 1009, 9999, etc.
const MIN_YEAR = 1900;
const MAX_YEAR = new Date().getFullYear() + 1;

const PIN = String(process.env.REEL_PIN || '0000');
const SESSION_TOKEN = crypto.randomBytes(24).toString('hex');
const COOKIE_NAME = 'reel';
const COOKIE_MAX_AGE = 60 * 60 * 24 * 30; // 30 days

// second factor: library-paths passcode (distinct from the front-door PIN).
// env REEL_ADMIN_PIN wins; otherwise config.adminPin; otherwise the default.
const ADMIN_TOKEN = crypto.randomBytes(24).toString('hex');
const ADMIN_COOKIE = 'jadmin';
const DEFAULT_ADMIN_PIN = '0000';
function adminPin() {
  if (process.env.REEL_ADMIN_PIN) return String(process.env.REEL_ADMIN_PIN);
  try { const c = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')); if (c.adminPin) return String(c.adminPin); } catch { }
  return DEFAULT_ADMIN_PIN;
}

// NOTE: remote desktop / PC-control no longer has its own passcode — it lives
// under the single Admin factor (ADMIN_TOKEN above), revealed only via the
// hidden triple-tap-logo entry in the UI.

// ---------- shared config read/write ----------
function readConfig() { try { return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')); } catch { return {}; } }
function writeConfig(c) { fs.writeFileSync(CONFIG_PATH, JSON.stringify(c, null, 2)); }

// ---------- sessions + profiles ----------
// Personal state (favorites / playlists / play history / resume) is namespaced by
// PROFILE so separate logins don't bleed together. The owner uses the static
// SESSION_TOKEN (profile 'owner'); members + guests each get a random token mapped
// here to a profile + expiry (members effectively permanent, guests time-boxed).
const sessions = new Map(); // token -> { profile, exp }
function sessionProfile(token) {
  if (!token) return null;
  if (token === SESSION_TOKEN) return 'owner';
  const s = sessions.get(token);
  if (!s) return null;
  if (s.exp != null && s.exp <= Date.now()) { sessions.delete(token); return null; }  // null exp = permanent
  return s.profile;
}
// expiry (ms epoch) of the caller's session, or null for owner / permanent profiles
function sessionExp(req) {
  const tok = parseCookies(req)[COOKIE_NAME];
  if (!tok || tok === SESSION_TOKEN) return null;
  const s = sessions.get(tok);
  return s && s.exp != null ? s.exp : null;
}
// duration menus (label -> minutes; null = no expiry)
const PROFILE_TTLS = { perm: null, '1h': 60, '6h': 360, '12h': 720, '24h': 1440, '7d': 10080, '30d': 43200 };
const GUEST_TTLS   = { '30m': 30, '6h': 360, '12h': 720, '24h': 1440 };
// guest codes: time-limited shares, persisted in config.json (survive restart)
function readGuests() { const now = Date.now(); return (readConfig().guests || []).filter(g => g && g.exp > now); }
// members: named profiles (own library). exp null = permanent; else auto-expires like a guest.
function readMembers() { const now = Date.now(); return (readConfig().members || []).filter(m => m && m.id && m.code && (!m.exp || m.exp > now)); }

// ---------- per-profile telemetry + hygiene ----------
// bump login counter + stamp on every successful auth
function touchLogin(prof) {
  try {
    db.prepare(`INSERT INTO profile_stats (profile, logins, last_login) VALUES (?, 1, ?)
                ON CONFLICT(profile) DO UPDATE SET logins = logins + 1, last_login = excluded.last_login`).run(prof, Date.now());
  } catch { }
}
// wipe every trace of a profile (favs/history/playlists/stats) — called when a
// member/guest is removed or a guest code lapses, so a recycled code never
// inherits the previous holder's personal data. playlist_tracks cascades.
function purgeProfile(prof) {
  try {
    db.prepare('DELETE FROM favs           WHERE profile = ?').run(prof);
    db.prepare('DELETE FROM plays          WHERE profile = ?').run(prof);
    db.prepare('DELETE FROM playlists      WHERE profile = ?').run(prof);
    db.prepare('DELETE FROM profile_stats  WHERE profile = ?').run(prof);
  } catch { }
}

// ---------- auth hardening helpers ----------
// Behind the Cloudflare tunnel every request arrives over HTTPS (x-forwarded-proto);
// add Secure so session cookies can never ride a downgraded/plain connection. Kept
// off for direct localhost (http) so local login still works.
function isHttps(req) { return String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim() === 'https'; }
function setCookie(res, req, name, value, maxAge) {
  const sec = isHttps(req) ? '; Secure' : '';
  res.setHeader('Set-Cookie', `${name}=${value}; Path=/; Max-Age=${maxAge}; SameSite=Lax; HttpOnly${sec}`);
}
// Constant-time PIN check (HMAC both sides → no length/short-circuit timing leak).
function pinEq(a, b) {
  const h = x => crypto.createHmac('sha256', SESSION_TOKEN).update(String(x)).digest();
  return crypto.timingSafeEqual(h(a), h(b));
}
// Escalating brute-force lockout. Level persists until a clean success, so repeated
// 5-fail bursts back off harder each time (a 4-digit space becomes uncrackable).
// Tunnel traffic shares one bucket (cloudflared connects from 127.0.0.1) — that makes
// the limit global for remote attackers, which is the defensively stronger choice.
const LOCK_WAITS = [60, 300, 900, 1800, 3600, 7200, 21600]; // seconds, by lockout level
function lockWait(map, ip, now) {
  const rec = map.get(ip);
  return rec && rec.until > now ? Math.ceil((rec.until - now) / 1000) : 0;
}
function lockFail(map, ip, now) {
  const rec = map.get(ip) || { count: 0, until: 0, level: 0, seen: now };
  rec.count += 1; rec.seen = now;
  if (rec.count >= 5) {
    rec.count = 0;
    rec.until = now + LOCK_WAITS[Math.min(rec.level, LOCK_WAITS.length - 1)] * 1000;
    rec.level += 1;
  }
  map.set(ip, rec);
}

// The native PIN gate (reel cookie) is the sole wall.
app.use(express.json({ limit: '16kb' }));

// baseline security headers on everything
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('Referrer-Policy', 'same-origin');
  next();
});

// public health probe — the desktop wrapper polls this before loading the UI
const BOOTED_AT = Date.now();
app.get('/api/health', (req, res) => res.json({ ok: true, up: Math.round((Date.now() - BOOTED_AT) / 1000) }));

// ---------- ffmpeg (for live .wma transcode) ----------
// Pin to an explicit binary via FFMPEG_PATH so PATH order can't silently
// select an unpatched build. Multiple ffmpeg builds coexist on this host;
// the >= 8.1.1 build carries the June 2026 demuxer/depacketizer fixes
// (CVE-2026-40962 et al.). ffprobe is derived from this path below.
let FFMPEG = null;
try {
  const explicit = process.env.FFMPEG_PATH;
  if (explicit && fs.existsSync(explicit)) {
    FFMPEG = explicit;
  } else {
    execSync('where ffmpeg', { stdio: 'pipe', windowsHide: true });
    FFMPEG = 'ffmpeg';
  }
} catch { }

// ---------- datastore ----------
const db = open();
migrate(db);
const natural = (a, b) => String(a).localeCompare(String(b), undefined, { numeric: true, sensitivity: 'base' });

// shared projection: a track joined to its artist + album
const TRACK_SELECT = `
  SELECT t.id, t.title, ar.name AS artist, t.artist_id, al.title AS album, t.album_id,
         al.art AS art, t.genre, t.year, t.dir, t.dur, t.ext, t.track_no AS tn, t.disc
  FROM tracks t
  LEFT JOIN artists ar ON ar.id = t.artist_id
  LEFT JOIN albums  al ON al.id = t.album_id`;
const pub = r => ({
  id: r.id, title: r.title || '', artist: r.artist || '', artistId: r.artist_id || null,
  album: r.album || '', albumId: r.album_id || null, art: r.art ? 1 : 0,
  genre: r.genre || '', year: r.year || 0, dir: r.dir || '', dur: r.dur || 0, ext: r.ext || '', tn: r.tn || 0
});
const lim = q => Math.min(parseInt(q.limit, 10) || 100, 500);
const off = q => Math.max(parseInt(q.offset, 10) || 0, 0);
// strict integer id — NaN must never reach a bind() (node:sqlite throws on NaN)
const intId = v => { const n = parseInt(v, 10); return Number.isInteger(n) ? n : null; };

// ---------- folder tree (cached; rebuilt after each scan) ----------
let TREE = new Map();
function buildTree() {
  const tree = new Map();
  const node = p => { let n = tree.get(p); if (!n) { n = { dirs: new Map(), count: 0 }; tree.set(p, n); } return n; };
  node('');
  for (const { dir, n } of db.prepare('SELECT dir, COUNT(*) n FROM tracks GROUP BY dir').all()) {
    if (!dir) continue;
    tree.get('').count += n;
    let cur = '';
    for (const part of dir.split('/')) {
      const parent = node(cur);
      const next = cur ? cur + '/' + part : part;
      parent.dirs.set(part, next);
      node(next).count += n;
      cur = next;
    }
  }
  TREE = tree;
}
buildTree();
// rebuild the tree when a scan finishes
let lastPhase = '';
fs.watchFile(PROGRESS_PATH, { interval: 4000 }, () => {
  try {
    const p = JSON.parse(fs.readFileSync(PROGRESS_PATH, 'utf8'));
    if (p.phase === 'done' && lastPhase !== 'done') buildTree();
    lastPhase = p.phase;
  } catch { }
});

// ---------- auth ----------
function parseCookies(req) {
  const out = {};
  const header = req.headers.cookie;
  if (!header) return out;
  header.split(';').forEach(p => {
    const i = p.indexOf('=');
    if (i < 0) return;
    out[p.slice(0, i).trim()] = decodeURIComponent(p.slice(i + 1).trim());
  });
  return out;
}
// Self-contained gate — auth = the native reel cookie (PIN login). No external SSO.
const isAuthed = req => sessionProfile(parseCookies(req)[COOKIE_NAME]) !== null;
const currentProfile = req => sessionProfile(parseCookies(req)[COOKIE_NAME]) || 'owner';
const isAdmin = req => parseCookies(req)[ADMIN_COOKIE] === ADMIN_TOKEN;
const requireAdmin = (req, res, next) => isAdmin(req) ? next() : res.status(403).json({ error: 'admin' });
// owner = the front PIN holder ONLY. Library metadata edits are global, so
// they're locked to the owner profile — members/guests can never rename anything.
const isOwner = req => currentProfile(req) === 'owner';
const requireOwner = (req, res, next) => isOwner(req) ? next() : res.status(403).json({ error: 'owner only' });
const isDesktopAuthed = isAdmin;  // desktop / PC-control now lives under the single Admin factor

app.get('/gate.html', (req, res) => res.sendFile(path.join(PUBLIC_DIR, 'gate.html')));

const failCounts = new Map();
app.post('/api/auth', (req, res) => {
  const ip = req.ip || req.connection.remoteAddress || 'unknown';
  const now = Date.now();
  const wait = lockWait(failCounts, ip, now);
  if (wait) return res.status(429).json({ ok: false, wait });
  const submitted = String((req.body && req.body.pin) || '').trim();
  if (submitted && pinEq(submitted, PIN)) {
    failCounts.delete(ip);
    setCookie(res, req, COOKIE_NAME, SESSION_TOKEN, COOKIE_MAX_AGE);
    touchLogin('owner');
    return res.json({ ok: true });
  }
  // member codes: permanent named profiles, each with its own library memory
  if (submitted) {
    const m = readMembers().find(m => pinEq(submitted, m.code));
    if (m) {
      failCounts.delete(ip);
      const token = crypto.randomBytes(24).toString('hex');
      const exp = m.exp || null;  // null = permanent profile
      sessions.set(token, { profile: 'm:' + m.id, exp });
      setCookie(res, req, COOKIE_NAME, token, exp ? Math.max(1, Math.floor((exp - Date.now()) / 1000)) : COOKIE_MAX_AGE);
      touchLogin('m:' + m.id);
      return res.json({ ok: true, member: true });
    }
  }
  // guest codes: a valid, unexpired code grants a time-boxed session that the
  // server force-expires (cookie Max-Age + per-request expiry check) → auto-kick.
  if (submitted) {
    const g = readGuests().find(g => pinEq(submitted, g.code));
    if (g) {
      failCounts.delete(ip);
      const token = crypto.randomBytes(24).toString('hex');
      sessions.set(token, { profile: 'g:' + g.code, exp: g.exp });
      setCookie(res, req, COOKIE_NAME, token, Math.max(1, Math.floor((g.exp - Date.now()) / 1000)));
      touchLogin('g:' + g.code);
      return res.json({ ok: true, guest: true });
    }
  }
  lockFail(failCounts, ip, now);
  res.status(401).json({ ok: false });
});

app.post('/api/logout', (req, res) => {
  try {
    const prof = currentProfile(req);
    db.prepare(`INSERT INTO profile_stats (profile, last_logout) VALUES (?, ?)
                ON CONFLICT(profile) DO UPDATE SET last_logout = excluded.last_logout`).run(prof, Date.now());
  } catch { }
  setCookie(res, req, COOKIE_NAME, '', 0);
  res.json({ ok: true });
});

// Shared Sona theme + fonts must load on the lock screen, before auth.
app.use('/assets', express.static(path.join(PUBLIC_DIR, 'assets')));
// gate everything below (PWA install assets stay public — no library data in them)
const PUBLIC_PATHS = new Set(['/manifest.json', '/icon-192.png', '/icon-512.png']);
app.use((req, res, next) => {
  if (PUBLIC_PATHS.has(req.path)) return next();
  if (isAuthed(req)) return next();
  const accept = req.headers.accept || '';
  if (req.method === 'GET' && accept.includes('text/html')) return res.redirect('/gate.html');   // unauthed -> Sona lock screen
  return res.status(401).json({ error: 'unauthorized' });
});

app.use(express.static(PUBLIC_DIR));

// ---------- stats ----------
app.get('/api/stats', (req, res) => {
  let scanning = null;
  try { const p = JSON.parse(fs.readFileSync(PROGRESS_PATH, 'utf8')); if (p.phase !== 'done') scanning = p; } catch { }
  const t = db.prepare('SELECT COUNT(*) n, COALESCE(SUM(size),0) s FROM tracks').get();
  const scannedAt = db.prepare(`SELECT v FROM meta WHERE k='scannedAt'`).get();
  res.json({
    tracks: t.n,
    sizeGB: +(t.s / 1e9).toFixed(1),
    artists: db.prepare('SELECT COUNT(*) n FROM artists').get().n,
    albums: db.prepare('SELECT COUNT(*) n FROM albums').get().n,
    scannedAt: scannedAt ? scannedAt.v : null,
    scanning, ffmpeg: !!FFMPEG
  });
});

// ---------- folder browser ----------
app.get('/api/browse', (req, res) => {
  const dir = String(req.query.dir || '');
  const n = TREE.get(dir);
  if (!n) {
    if (dir === '') return res.json({ dir, folders: [], total: 0, offset: 0, tracks: [] });
    return res.status(404).json({ error: 'no such folder' });
  }
  const folders = [...n.dirs.entries()]
    .map(([name, p]) => ({ name, path: p, count: TREE.get(p).count }))
    .sort((a, b) => natural(a.name, b.name));
  const o = off(req.query), l = lim(req.query);
  const total = db.prepare('SELECT COUNT(*) n FROM tracks WHERE dir = ?').get(dir).n;
  const rows = db.prepare(`${TRACK_SELECT} WHERE t.dir = ? ORDER BY t.disc, t.track_no, t.fn LIMIT ? OFFSET ?`).all(dir, l, o);
  res.json({ dir, folders, total, offset: o, tracks: rows.map(pub) });
});

// ---------- ranked full-text search ----------
function ftsQuery(raw) {
  const terms = String(raw).toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, ' ').split(/\s+/).filter(Boolean);
  return terms.map(t => t + '*').join(' ');
}
app.get('/api/search', (req, res) => {
  const raw = String(req.query.q || '').trim();
  if (raw.length < 2) return res.json({ tracks: [], total: 0, offset: 0 });
  const match = ftsQuery(raw);
  if (!match) return res.json({ tracks: [], total: 0, offset: 0 });
  const o = off(req.query), l = lim(req.query);
  try {
    const total = db.prepare('SELECT COUNT(*) n FROM search WHERE search MATCH ?').get(match).n;
    const rows = db.prepare(`
      ${TRACK_SELECT}
      JOIN search s ON s.tid = t.id
      WHERE search MATCH ? ORDER BY s.rank LIMIT ? OFFSET ?`).all(match, l, o);
    const out = { total, offset: o, tracks: rows.map(pub) };
    if (o === 0) {
      // grouped sections (page one only): matching artists + albums, best first
      const like = '%' + raw.toLowerCase().replace(/[%_]/g, ' ') + '%';
      out.artists = db.prepare(`
        SELECT ar.id, ar.name, COUNT(t.id) n
        FROM artists ar LEFT JOIN tracks t ON t.artist_id = ar.id
        WHERE lower(ar.name) LIKE ? GROUP BY ar.id ORDER BY n DESC LIMIT 6`).all(like);
      out.albums = db.prepare(`
        SELECT al.id, al.title, al.year, al.art, ar.name AS artist, COUNT(t.id) n
        FROM albums al LEFT JOIN artists ar ON ar.id = al.artist_id
        LEFT JOIN tracks t ON t.album_id = al.id
        WHERE lower(al.title) LIKE ? GROUP BY al.id ORDER BY n DESC LIMIT 6`).all(like);
    }
    res.json(out);
  } catch (e) { res.json({ tracks: [], total: 0, offset: 0 }); }
});

// ---------- facets: genres ----------
app.get('/api/genres', (req, res) => {
  const rows = db.prepare(`
    SELECT t.genre AS name, COUNT(*) n,
      (SELECT al.id FROM tracks x JOIN albums al ON al.id = x.album_id
       WHERE x.genre = t.genre AND al.art IS NOT NULL LIMIT 1) AS art
    FROM tracks t WHERE t.genre IS NOT NULL AND t.genre != ''
    GROUP BY t.genre HAVING COUNT(*) >= 2 ORDER BY n DESC, name`).all();
  // fold every single-track genre (the P2P junk-tag tail) into one honest bucket.
  // nothing is hidden — the tracks all live inside "Singles & Rarities" and stay searchable.
  const loose = db.prepare(`SELECT COUNT(*) n FROM tracks
    WHERE genre IS NOT NULL AND genre != '' AND genre IN
    (SELECT genre FROM tracks WHERE genre IS NOT NULL AND genre != '' GROUP BY genre HAVING COUNT(*) = 1)`).get().n;
  if (loose > 0) rows.push({ name: 'Singles & Rarities', key: '__loose__', n: loose, art: null, loose: true });
  res.json({ genres: rows });
});
app.get('/api/genre', (req, res) => {
  const g = String(req.query.g || '');
  const o = off(req.query), l = lim(req.query);
  if (g === '__loose__') {   // the "Singles & Rarities" bucket: every genre that has exactly one track
    const sub = `SELECT genre FROM tracks WHERE genre IS NOT NULL AND genre != '' GROUP BY genre HAVING COUNT(*) = 1`;
    const total = db.prepare(`SELECT COUNT(*) n FROM tracks WHERE genre IN (${sub})`).get().n;
    const rows = db.prepare(`${TRACK_SELECT} WHERE t.genre IN (${sub}) ORDER BY ar.sort_name, al.title, t.disc, t.track_no LIMIT ? OFFSET ?`).all(l, o);
    return res.json({ name: 'Singles & Rarities', total, offset: o, tracks: rows.map(pub) });
  }
  const total = db.prepare('SELECT COUNT(*) n FROM tracks WHERE genre = ?').get(g).n;
  const rows = db.prepare(`${TRACK_SELECT} WHERE t.genre = ? ORDER BY ar.sort_name, al.title, t.disc, t.track_no LIMIT ? OFFSET ?`).all(g, l, o);
  const out = { name: g, total, offset: o, tracks: rows.map(pub) };
  if (o === 0) {
    // parent→child drill: the albums + artists that live inside this genre
    out.albums = db.prepare(`
      SELECT al.id, al.title, al.year, al.art, ar.name AS artist, COUNT(t.id) n
      FROM tracks t JOIN albums al ON al.id = t.album_id LEFT JOIN artists ar ON ar.id = al.artist_id
      WHERE t.genre = ? GROUP BY al.id
      ORDER BY (al.year IS NULL), al.year, al.title LIMIT 400`).all(g);
    out.artists = db.prepare(`
      SELECT ar.id, ar.name, COUNT(t.id) n
      FROM tracks t JOIN artists ar ON ar.id = t.artist_id
      WHERE t.genre = ? GROUP BY ar.id ORDER BY n DESC, ar.sort_name LIMIT 40`).all(g);
  }
  res.json(out);
});

// ---------- facets: decades / years ----------
app.get('/api/decades', (req, res) => {
  const rows = db.prepare(`
    SELECT (t.year/10)*10 AS decade, COUNT(*) n,
      (SELECT al.id FROM tracks x JOIN albums al ON al.id = x.album_id
       WHERE (x.year/10)*10 = (t.year/10)*10 AND al.art IS NOT NULL LIMIT 1) AS art
    FROM tracks t WHERE t.year >= ${MIN_YEAR} AND t.year <= ${MAX_YEAR}
    GROUP BY decade ORDER BY decade DESC`).all();
  res.json({ decades: rows });
});
app.get('/api/decade', (req, res) => {
  const d = parseInt(req.query.d, 10) || 0;
  const o = off(req.query), l = lim(req.query);
  const total = db.prepare('SELECT COUNT(*) n FROM tracks WHERE year >= ? AND year < ?').get(d, d + 10).n;
  const rows = db.prepare(`${TRACK_SELECT} WHERE t.year >= ? AND t.year < ? ORDER BY t.year, ar.sort_name, al.title, t.track_no LIMIT ? OFFSET ?`).all(d, d + 10, l, o);
  const out = { decade: d, total, offset: o, tracks: rows.map(pub) };
  if (o === 0) {
    out.albums = db.prepare(`
      SELECT al.id, al.title, al.year, al.art, ar.name AS artist, COUNT(t.id) n
      FROM tracks t JOIN albums al ON al.id = t.album_id LEFT JOIN artists ar ON ar.id = al.artist_id
      WHERE t.year >= ? AND t.year < ? GROUP BY al.id ORDER BY n DESC, al.title LIMIT 60`).all(d, d + 10);
  }
  res.json(out);
});

// ---------- facets: artists / albums (data ready; UI optional) ----------
// letter buckets: A–Z on first char of sort_name, '#' for everything else
const LETTER_SQL = `CASE WHEN upper(substr(ar.sort_name,1,1)) BETWEEN 'A' AND 'Z' THEN upper(substr(ar.sort_name,1,1)) ELSE '#' END`;
app.get('/api/artists', (req, res) => {
  const letter = String(req.query.letter || '').slice(0, 1).toUpperCase();
  const o = off(req.query), l = Math.min(parseInt(req.query.limit, 10) || 200, 500);
  const where = letter ? `WHERE ${LETTER_SQL} = ?` : '';
  const args = letter ? [letter] : [];
  const total = db.prepare(`
    SELECT COUNT(*) n FROM artists ar ${where}`).get(...args).n;
  const rows = db.prepare(`
    SELECT ar.id, ar.name, ar.sort_name, COUNT(t.id) n
    FROM artists ar LEFT JOIN tracks t ON t.artist_id = ar.id
    ${where} GROUP BY ar.id ORDER BY ar.sort_name LIMIT ? OFFSET ?`).all(...args, l, o);
  const out = { total, offset: o, artists: rows };
  if (o === 0) {
    // A–Z jump strip with counts (cheap: one GROUP BY over the artists table)
    out.letters = db.prepare(`
      SELECT ${LETTER_SQL} AS l, COUNT(*) n FROM artists ar GROUP BY l ORDER BY l`).all();
  }
  res.json(out);
});
app.get('/api/artist', (req, res) => {
  const id = intId(req.query.id);
  if (id === null) return res.status(400).json({ error: 'bad id' });
  const albums = db.prepare(`
    SELECT al.id, al.title, al.year, al.art, COUNT(*) n
    FROM tracks t JOIN albums al ON al.id = t.album_id
    WHERE t.artist_id = ? GROUP BY al.id ORDER BY al.year, al.title`).all(id);
  const rows = db.prepare(`${TRACK_SELECT} WHERE t.artist_id = ? ORDER BY al.year, al.title, t.disc, t.track_no`).all(id);
  const a = db.prepare('SELECT name FROM artists WHERE id = ?').get(id);
  res.json({ id, name: a ? a.name : '', albums, tracks: rows.map(pub) });
});

// ---------- artist bios (player bio panel) ----------
app.get('/api/artist-bio', (req, res) => {
  const id = intId(req.query.id);
  if (id === null) return res.status(400).json({ error: 'bad id' });
  const a = db.prepare('SELECT id, name, bio, bio_src, bio_at FROM artists WHERE id = ?').get(id);
  if (!a) return res.status(404).json({ error: 'no such artist' });
  const n = db.prepare('SELECT COUNT(*) n FROM tracks WHERE artist_id = ?').get(id).n;
  res.json({ id: a.id, name: a.name, bio: a.bio || '', src: a.bio_src || '', at: a.bio_at || 0, tracks: n });
});
// manual edit/paste — your words win and stick (bio_src='manual')
app.post('/api/artist-bio', (req, res) => {
  const id = intId(req.body && req.body.id);
  const bio = String((req.body && req.body.bio) || '').trim().slice(0, 4000);
  if (!id) return res.status(400).json({ ok: false });
  db.prepare('UPDATE artists SET bio = ?, bio_src = ?, bio_at = ? WHERE id = ?')
    .run(bio || null, bio ? 'manual' : null, Date.now(), id);
  res.json({ ok: true, bio });
});
// on-demand ✨ — fetch one artist from Wikipedia now (for anything the batch missed)
app.post('/api/artist-bio/generate', async (req, res) => {
  const id = intId(req.body && req.body.id);
  if (id === null) return res.status(400).json({ ok: false });
  const a = db.prepare('SELECT id, name FROM artists WHERE id = ?').get(id);
  if (!a) return res.status(404).json({ ok: false });
  try {
    const r = await fetchArtistBio(a.name);
    if (!r) {
      db.prepare('UPDATE artists SET bio_src = ?, bio_at = ? WHERE id = ?').run('none', Date.now(), id);
      return res.json({ ok: true, bio: '', src: 'none' });
    }
    db.prepare('UPDATE artists SET bio = ?, bio_src = ?, bio_at = ? WHERE id = ?').run(r.bio, r.src, Date.now(), id);
    res.json({ ok: true, bio: r.bio, src: r.src });
  } catch (e) { res.status(500).json({ ok: false, error: 'fetch failed' }); }
});
const ALBUM_SORTS = {
  artist: 'ar.sort_name, al.year, al.title',
  title:  'al.title COLLATE NOCASE',
  year:   'al.year DESC, ar.sort_name, al.title'
};
app.get('/api/albums', (req, res) => {
  const o = off(req.query), l = Math.min(parseInt(req.query.limit, 10) || 120, 500);
  const order = ALBUM_SORTS[String(req.query.sort || 'artist')] || ALBUM_SORTS.artist;
  const total = db.prepare('SELECT COUNT(*) n FROM albums').get().n;
  const rows = db.prepare(`
    SELECT al.id, al.title, al.year, al.art, ar.name AS artist, COUNT(t.id) n
    FROM albums al LEFT JOIN artists ar ON ar.id = al.artist_id
    LEFT JOIN tracks t ON t.album_id = al.id
    GROUP BY al.id ORDER BY ${order} LIMIT ? OFFSET ?`).all(l, o);
  res.json({ total, offset: o, albums: rows });
});
app.get('/api/album', (req, res) => {
  const id = intId(req.query.id);
  if (id === null) return res.status(400).json({ error: 'bad id' });
  const al = db.prepare('SELECT al.id, al.title, al.year, al.art, ar.name AS artist FROM albums al LEFT JOIN artists ar ON ar.id=al.artist_id WHERE al.id = ?').get(id);
  if (!al) return res.status(404).json({ error: 'no such album' });
  const rows = db.prepare(`${TRACK_SELECT} WHERE t.album_id = ? ORDER BY t.disc, t.track_no, t.fn`).all(id);
  res.json({ album: al, tracks: rows.map(pub) });
});

// ---------- The NOW Collection ----------
// "Now That's What I Call Music" got fragmented across many album rows (per-artist
// splits + CD1/CD2). The now-*.jpg cover set by now-art.js is a clean edition key, so
// we fold the rows back into one entry per edition and present them grouped by year.
const NOW_WHERE = `(LOWER(al.title) LIKE '%what i call music%' OR LOWER(al.title) LIKE '%what i call gold%')`;
const nowClean = t => String(t || '').replace(/\s*CD\s*\d.*/i, '').replace(/\s*\(disc.*/i, '').replace(/\s*-\s*$/, '').trim();
const nowSlug = t => nowClean(t).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().replace(/\s+/g, '-');
const ROMAN_NOW = { i: 1, ii: 2, iii: 3, iv: 4, v: 5, vi: 6, vii: 7, viii: 8, ix: 9, x: 10 };
function nowLabel(title) {
  const t = title.toLowerCase();
  if (/gold/.test(t)) return 'NOW Gold';
  let m = t.match(/music!?\s*(?:vol\.?\s*)?(\d{1,3})/);
  if (m) return 'NOW ' + m[1];
  m = t.match(/\b(i{1,3}|iv|v|vi{0,3}|ix|x)\b\s*$/);
  if (m && ROMAN_NOW[m[1]]) return 'NOW ' + ROMAN_NOW[m[1]];
  return nowClean(title);
}
const nowNumOf = l => { const m = String(l).match(/(\d+)/); return m ? +m[1] : 9999; };
app.get('/api/now', (req, res) => {
  const rows = db.prepare(`
    SELECT al.id, al.title, al.year, al.art,
      (SELECT COUNT(*) FROM tracks t WHERE t.album_id = al.id) AS n
    FROM albums al WHERE ${NOW_WHERE}`).all();
  const eds = new Map();
  for (const r of rows) {
    const key = (r.art && r.art.startsWith('now-')) ? r.art : 'k:' + nowSlug(r.title);
    if (!eds.has(key)) eds.set(key, { key, label: nowLabel(r.title), year: r.year || null, tracks: 0, ids: [], coverId: null });
    const e = eds.get(key);
    e.ids.push(r.id); e.tracks += r.n;
    if (!e.year && r.year) e.year = r.year;
    if (r.art && !e.coverId) e.coverId = r.id;            // a row that actually has a cover
  }
  for (const e of eds.values()) if (!e.coverId) e.coverId = e.ids[0];
  const list = [...eds.values()].sort((a, b) => (a.year || 9999) - (b.year || 9999) || nowNumOf(a.label) - nowNumOf(b.label));
  res.json({ count: list.length, editions: list });
});
app.get('/api/now-edition', (req, res) => {
  const ids = String(req.query.ids || '').split(',').map(x => parseInt(x, 10)).filter(Number.isInteger).slice(0, 80);
  if (!ids.length) return res.status(400).json({ error: 'no ids' });
  const ph = ids.map(() => '?').join(',');
  const rows = db.prepare(`${TRACK_SELECT} WHERE t.album_id IN (${ph}) ORDER BY t.year, t.disc, t.track_no, t.fn`).all(...ids);
  res.json({ tracks: rows.map(pub) });
});
// every NOW song, flattened — powers the "Songs A-Z" filter view
app.get('/api/now-songs', (req, res) => {
  const albs = db.prepare(`SELECT id FROM albums al WHERE ${NOW_WHERE}`).all().map(a => a.id);
  if (!albs.length) return res.json({ count: 0, tracks: [] });
  const ph = albs.map(() => '?').join(',');
  const rows = db.prepare(`${TRACK_SELECT} WHERE t.album_id IN (${ph}) ORDER BY t.title COLLATE NOCASE`).all(...albs);
  res.json({ count: rows.length, tracks: rows.map(pub) });
});

// Albums whose title signals a hits/best-of compilation
const HITS_FILTER = `(al.title LIKE '%hits%' OR al.title LIKE '%best of%'
  OR al.title LIKE '%very best%' OR al.title LIKE '%essential%'
  OR al.title LIKE '%anthology%' OR al.title LIKE '%definitive%'
  OR al.title LIKE '%the singles%' OR al.title LIKE '%greatest song%'
  OR al.title LIKE '%classics%' OR al.title LIKE '%the collection%'
  OR al.title LIKE '%complete collection%')`;

// ---------- random shuffle endpoint ----------
app.get('/api/random', (req, res) => {
  const scope = String(req.query.scope || 'all');
  const limit = Math.min(parseInt(req.query.limit, 10) || 100, 300);
  let sql, args;
  if (scope === 'genre') {
    sql = `${TRACK_SELECT} WHERE t.genre = ? ORDER BY RANDOM() LIMIT ?`;
    args = [String(req.query.g || ''), limit];
  } else if (scope === 'genre_loose') {
    sql = `${TRACK_SELECT} WHERE t.genre IN (SELECT genre FROM tracks WHERE genre IS NOT NULL AND genre != '' GROUP BY genre HAVING COUNT(*) = 1) ORDER BY RANDOM() LIMIT ?`;
    args = [limit];
  } else if (scope === 'genre_hits') {
    sql = `${TRACK_SELECT} WHERE t.genre = ? AND ${HITS_FILTER} ORDER BY RANDOM() LIMIT ?`;
    args = [String(req.query.g || ''), limit];
  } else if (scope === 'artist_hits') {
    sql = `${TRACK_SELECT} WHERE t.artist_id = ? AND ${HITS_FILTER} ORDER BY RANDOM() LIMIT ?`;
    args = [intId(req.query.id) ?? -1, limit];
  } else if (scope === 'decade') {
    const d = parseInt(req.query.d, 10) || 0;
    sql = `${TRACK_SELECT} WHERE t.year >= ? AND t.year < ? ORDER BY RANDOM() LIMIT ?`;
    args = [d, d + 10, limit];
  } else if (scope === 'artist') {
    sql = `${TRACK_SELECT} WHERE t.artist_id = ? ORDER BY RANDOM() LIMIT ?`;
    args = [intId(req.query.id) ?? -1, limit];
  } else if (scope === 'album') {
    sql = `${TRACK_SELECT} WHERE t.album_id = ? ORDER BY RANDOM() LIMIT ?`;
    args = [intId(req.query.id) ?? -1, limit];
  } else if (scope === 'dirtree') {
    const dir = String(req.query.dir || '');
    if (dir) {
      sql = `${TRACK_SELECT} WHERE (t.dir = ? OR t.dir LIKE ?) ORDER BY RANDOM() LIMIT ?`;
      args = [dir, dir + '/%', limit];
    } else {
      sql = `${TRACK_SELECT} ORDER BY RANDOM() LIMIT ?`;
      args = [limit];
    }
  } else if (scope === 'favorites') {
    sql = `${TRACK_SELECT} JOIN favs f ON f.tid = t.id AND f.profile = ? ORDER BY RANDOM() LIMIT ?`;
    args = [currentProfile(req), limit];
  } else {
    sql = `${TRACK_SELECT} ORDER BY RANDOM() LIMIT ?`;
    args = [limit];
  }
  const rows = db.prepare(sql).all(...args);
  res.json({ tracks: rows.map(pub) });
});

// ---------- voice resolver ----------
// take a spoken phrase and aim it at the right entity in the library: a track to
// play, an artist/album/genre/decade to open, a shuffle scope, or a search fallback.
const VOICE_FILLER = /\b(please|play|put on|listen to|the|some|any|my|a|an|me|us|for|songs?|tracks?|music|stuff|album|artist|band|group|of|please)\b/gi;
const DECADE_WORDS = { twenties:1920, thirties:1930, forties:1940, fifties:1950, sixties:1960, seventies:1970, eighties:1980, nineties:1990, naughties:2000, aughts:2000 };
function cleanVoice(s) {
  return String(s).toLowerCase()
    .replace(VOICE_FILLER, ' ')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ').trim();
}
function detectDecade(raw) {
  const s = String(raw).toLowerCase();
  for (const [word, year] of Object.entries(DECADE_WORDS)) if (s.includes(word)) return year;
  const m = s.match(/\b(19|20)?(\d0)\s*s\b/);
  if (m) {
    const tens = parseInt(m[2], 10);
    if (m[1]) return parseInt(m[1] + m[2], 10);
    return tens >= 30 ? 1900 + tens : 2000 + tens; // "20s"->2020, "30s"->1930
  }
  return null;
}
// ---------- speech-to-text (local faster-whisper worker) ----------
// Telegram's in-app browser blocks Web Speech API. We work around it by
// recording raw audio in the page (MediaRecorder works fine in the WebView)
// and transcribing locally via a long-running Python helper. No paid API.
const WHISPER_TMP = path.join(APP, 'tmp-voice');
try { fs.mkdirSync(WHISPER_TMP, { recursive: true }); } catch {}
const WHISPER_SCRIPT = path.join(APP, 'whisper-worker.py');
const PYTHON_EXE = process.env.REEL_PYTHON
  || 'python3';

let whisperProc = null;
let whisperReady = false;
let whisperPending = [];          // [{resolve, reject, timer}]
let whisperQueue = [];            // [{wavPath, resolve, reject}]
let whisperBusy = false;
let whisperBuf = '';

function whisperHandleLine(line) {
  let msg;
  try { msg = JSON.parse(line); } catch { return; }
  if (msg.ready !== undefined && !whisperReady) {
    whisperReady = !!msg.ok;
    if (!whisperReady) console.error('[whisper] not ready:', msg.error);
    return;
  }
  const job = whisperPending.shift();
  if (!job) return;
  clearTimeout(job.timer);
  whisperBusy = false;
  if (msg.ok) job.resolve(String(msg.text || '').trim());
  else job.reject(new Error(msg.error || 'transcribe failed'));
  pumpWhisper();
}
function pumpWhisper() {
  if (whisperBusy || !whisperReady || !whisperProc) return;
  const next = whisperQueue.shift();
  if (!next) return;
  whisperBusy = true;
  const timer = setTimeout(() => {
    whisperPending = whisperPending.filter(p => p !== entry);
    whisperBusy = false;
    next.reject(new Error('whisper timeout'));
    pumpWhisper();
  }, 30000);
  const entry = { resolve: next.resolve, reject: next.reject, timer };
  whisperPending.push(entry);
  whisperProc.stdin.write(next.wavPath + '\n');
}
function whisperStart() {
  if (whisperProc) return;
  try {
    whisperProc = spawn(PYTHON_EXE, [WHISPER_SCRIPT], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  } catch (e) {
    console.error('[whisper] spawn failed:', e.message);
    whisperProc = null;
    return;
  }
  whisperProc.stdout.on('data', d => {
    whisperBuf += d.toString('utf8');
    let i;
    while ((i = whisperBuf.indexOf('\n')) >= 0) {
      const line = whisperBuf.slice(0, i).trim();
      whisperBuf = whisperBuf.slice(i + 1);
      if (line) whisperHandleLine(line);
    }
  });
  whisperProc.stderr.on('data', d => process.stderr.write('[whisper] ' + d.toString('utf8')));
  whisperProc.on('exit', code => {
    console.error('[whisper] worker exited code=' + code);
    whisperProc = null;
    whisperReady = false;
    whisperBusy = false;
    // fail any in-flight + queued jobs so the client can fall back
    for (const j of whisperPending) { clearTimeout(j.timer); j.reject(new Error('whisper exited')); }
    for (const j of whisperQueue) j.reject(new Error('whisper exited'));
    whisperPending = []; whisperQueue = [];
    // try to come back online after a short delay
    setTimeout(whisperStart, 5000);
  });
}
whisperStart();

function transcribeWav(wavPath) {
  return new Promise((resolve, reject) => {
    if (!whisperProc) return reject(new Error('whisper not running'));
    whisperQueue.push({ wavPath, resolve, reject });
    pumpWhisper();
  });
}

// Accept raw audio bytes from the browser MediaRecorder, transcode to 16kHz
// mono wav with ffmpeg, hand the path to the whisper worker, return text.
app.post('/api/voice-search', express.raw({ type: '*/*', limit: '8mb' }), async (req, res) => {
  if (!FFMPEG) return res.status(503).json({ ok: false, error: 'ffmpeg unavailable' });
  if (!whisperReady) return res.status(503).json({ ok: false, error: 'whisper not ready' });
  const buf = req.body;
  if (!Buffer.isBuffer(buf) || buf.length < 1024) return res.status(400).json({ ok: false, error: 'audio missing' });

  const stamp = Date.now().toString(36) + '_' + crypto.randomBytes(4).toString('hex');
  const inPath = path.join(WHISPER_TMP, stamp + '.bin');
  const wavPath = path.join(WHISPER_TMP, stamp + '.wav');
  const cleanup = () => { try { fs.unlinkSync(inPath); } catch {} try { fs.unlinkSync(wavPath); } catch {} };
  try {
    fs.writeFileSync(inPath, buf);
    await new Promise((ok, ko) => {
      const ff = spawn(FFMPEG, ['-y', '-i', inPath, '-ac', '1', '-ar', '16000', '-f', 'wav', wavPath], { stdio: 'ignore', windowsHide: true });
      ff.on('exit', code => code === 0 ? ok() : ko(new Error('ffmpeg exit ' + code)));
      ff.on('error', ko);
    });
    const text = await transcribeWav(wavPath);
    cleanup();
    res.json({ ok: true, text });
  } catch (e) {
    cleanup();
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.get('/api/voice-status', (req, res) => {
  res.json({ ok: true, whisper: whisperReady, ffmpeg: !!FFMPEG });
});

app.get('/api/voice-resolve', (req, res) => {
  const raw = String(req.query.q || '').trim();
  if (!raw) return res.json({ ok: false });

  // intent: shuffle / hits prefix
  const lower = raw.toLowerCase();
  const wantsHits = /\b(hits|greatest hits|best of|essentials)\b/.test(lower);
  const wantsShuffle = /\b(shuffle|random|mix)\b/.test(lower);

  // "X by Y" — song X by artist Y
  const byMatch = lower.match(/^(.+?)\s+by\s+(.+)$/);
  if (byMatch) {
    const song = cleanVoice(byMatch[1]);
    const artist = cleanVoice(byMatch[2]);
    if (song && artist) {
      const row = db.prepare(`
        ${TRACK_SELECT}
        WHERE lower(t.title) LIKE ? AND lower(ar.name) LIKE ?
        ORDER BY length(t.title) ASC LIMIT 1`).get('%'+song+'%', '%'+artist+'%');
      if (row) return res.json({ ok: true, kind: 'track', track: pub(row), label: `${row.title} — ${row.artist||''}` });
    }
  }

  // decade
  const dec = detectDecade(raw);
  if (dec) {
    const hit = db.prepare('SELECT COUNT(*) n FROM tracks WHERE year >= ? AND year < ?').get(dec, dec + 10).n;
    if (hit > 0) return res.json({ ok: true, kind: 'decade', decade: dec, label: dec + 's', shuffle: wantsShuffle });
  }

  // strip shuffle/hits cue words so the rest can match an entity
  const stripped = lower
    .replace(/\b(shuffle|random|mix|hits|greatest hits|best of|essentials|from|of)\b/g, ' ');
  const q = cleanVoice(stripped);
  if (!q) return res.json({ ok: false });
  const like = '%' + q + '%';

  // 1. exact genre
  const gEx = db.prepare("SELECT DISTINCT genre FROM tracks WHERE lower(genre) = ? LIMIT 1").get(q);
  if (gEx) return res.json({ ok: true, kind: 'genre', genre: gEx.genre, label: gEx.genre, shuffle: wantsShuffle, hits: wantsHits });

  // 2. exact artist
  const arEx = db.prepare('SELECT id, name FROM artists WHERE lower(name) = ? LIMIT 1').get(q);
  if (arEx) return res.json({ ok: true, kind: 'artist', id: arEx.id, label: arEx.name, shuffle: wantsShuffle, hits: wantsHits });

  // 3. exact album
  const alEx = db.prepare(`SELECT al.id, al.title, ar.name AS artist FROM albums al
    LEFT JOIN artists ar ON ar.id=al.artist_id WHERE lower(al.title) = ? LIMIT 1`).get(q);
  if (alEx) return res.json({ ok: true, kind: 'album', id: alEx.id, label: alEx.title + (alEx.artist?' — '+alEx.artist:''), shuffle: wantsShuffle });

  // 4. exact track
  const trEx = db.prepare(`${TRACK_SELECT} WHERE lower(t.title) = ? ORDER BY t.play_count DESC LIMIT 1`).get(q);
  if (trEx) return res.json({ ok: true, kind: 'track', track: pub(trEx), label: trEx.title + (trEx.artist?' — '+trEx.artist:'') });

  // 5. substring artist (shortest name first — "Adele" beats "Adele Bertei")
  if (q.length >= 3) {
    const arLk = db.prepare('SELECT id, name FROM artists WHERE lower(name) LIKE ? ORDER BY length(name) ASC LIMIT 1').get(like);
    if (arLk) return res.json({ ok: true, kind: 'artist', id: arLk.id, label: arLk.name, shuffle: wantsShuffle, hits: wantsHits });
  }

  // 6. substring genre
  if (q.length >= 3) {
    const gLk = db.prepare("SELECT DISTINCT genre FROM tracks WHERE lower(genre) LIKE ? AND genre IS NOT NULL ORDER BY length(genre) ASC LIMIT 1").get(like);
    if (gLk) return res.json({ ok: true, kind: 'genre', genre: gLk.genre, label: gLk.genre, shuffle: wantsShuffle, hits: wantsHits });
  }

  // 7. substring album
  if (q.length >= 3) {
    const alLk = db.prepare(`SELECT al.id, al.title, ar.name AS artist FROM albums al
      LEFT JOIN artists ar ON ar.id=al.artist_id WHERE lower(al.title) LIKE ? ORDER BY length(al.title) ASC LIMIT 1`).get(like);
    if (alLk) return res.json({ ok: true, kind: 'album', id: alLk.id, label: alLk.title + (alLk.artist?' — '+alLk.artist:''), shuffle: wantsShuffle });
  }

  // 8. substring track — most-played first so "play hotel california" picks the real one
  const trLk = db.prepare(`${TRACK_SELECT} WHERE lower(t.title) LIKE ? ORDER BY t.play_count DESC, length(t.title) ASC LIMIT 1`).get(like);
  if (trLk) return res.json({ ok: true, kind: 'track', track: pub(trLk), label: trLk.title + (trLk.artist?' — '+trLk.artist:'') });

  return res.json({ ok: true, kind: 'search', q: raw });
});

// ---------- home ----------
app.get('/api/home', (req, res) => {
  // "Jump back in" — distinct albums THIS profile most recently played
  const jumpBackIn = db.prepare(`
    SELECT al.id, al.title, al.year, al.art, ar.name AS artist, MAX(pl.last_played) lp
    FROM plays pl JOIN tracks t ON t.id = pl.tid JOIN albums al ON al.id = t.album_id LEFT JOIN artists ar ON ar.id = al.artist_id
    WHERE pl.profile = ? AND pl.last_played IS NOT NULL GROUP BY al.id ORDER BY lp DESC LIMIT 12`).all(currentProfile(req));
  const topGenres = db.prepare(`
    SELECT t.genre AS name, COUNT(*) n,
      (SELECT al.id FROM tracks x JOIN albums al ON al.id = x.album_id
       WHERE x.genre = t.genre AND al.art IS NOT NULL LIMIT 1) AS art
    FROM tracks t WHERE t.genre IS NOT NULL AND t.genre!='' GROUP BY t.genre ORDER BY n DESC LIMIT 8`).all();
  // random album shelf — at 90k tracks "recently added" is one giant import, so
  // rediscovery beats recency for finding something to play
  const rediscover = db.prepare(`
    SELECT al.id, al.title, al.year, al.art, ar.name AS artist, COUNT(t.id) n
    FROM albums al LEFT JOIN artists ar ON ar.id = al.artist_id
    LEFT JOIN tracks t ON t.album_id = al.id
    GROUP BY al.id ORDER BY RANDOM() LIMIT 12`).all();
  res.json({ jumpBackIn, topGenres, rediscover });
});

// ---------- album art ----------
// Covers ranged up to 8 MB at full resolution — a grid of them choked the
// cloudflare tunnel (~1 MB/s) and starved the song request, so a click took ~10s
// to start. Default now is a disk-cached ~400px thumbnail (~20-40 KB); full-res
// is served only on ?full=1 (OS media-session / lock-screen art).
const THUMB_DIR = path.join(ART_DIR, '_thumb');
try { fs.mkdirSync(THUMB_DIR, { recursive: true }); } catch { }
const THUMB_PX = 400;
app.get('/art/:id', (req, res) => {
  const id = intId(req.params.id);
  if (id === null) return res.status(404).end();
  const row = db.prepare('SELECT art FROM albums WHERE id = ?').get(id);
  if (!row || !row.art) return res.status(404).end();
  const orig = path.join(ART_DIR, row.art);
  if (!orig.startsWith(ART_DIR) || !fs.existsSync(orig)) return res.status(404).end();

  if (req.query.full) {                          // full-res, on demand only
    res.setHeader('Cache-Control', 'public, max-age=604800');
    return res.sendFile(orig);
  }

  const thumb = path.join(THUMB_DIR, id + '.jpg');
  const sendThumb = () => { res.setHeader('Cache-Control', 'public, max-age=604800'); res.sendFile(thumb); };
  const sendOrig  = () => { res.setHeader('Cache-Control', 'public, max-age=86400');  res.sendFile(orig); };
  if (fs.existsSync(thumb)) return sendThumb();
  if (!FFMPEG) return sendOrig();                // no transcoder → original
  const ff = spawn(FFMPEG, ['-y', '-v', 'quiet', '-i', orig,
    '-vf', `scale='min(${THUMB_PX},iw)':-2`, '-q:v', '4', thumb],
    { stdio: 'ignore', windowsHide: true });
  ff.on('error', () => { try { sendOrig(); } catch { } });
  ff.on('close', code => {
    if (code === 0 && fs.existsSync(thumb)) { try { sendThumb(); } catch { } }
    else { try { sendOrig(); } catch { } }
  });
});

// ---------- favorites (persistent) ----------
app.get('/api/favorites', (req, res) => {
  const rows = db.prepare(`${TRACK_SELECT} JOIN favs f ON f.tid = t.id WHERE f.profile = ? ORDER BY f.added_at DESC`).all(currentProfile(req));
  res.json({ tracks: rows.map(pub) });
});
// ---------- "Just Added": newest tracks by index time ----------
app.get('/api/recent', (req, res) => {
  const o = off(req.query), l = lim(req.query);
  const total = db.prepare('SELECT COUNT(*) n FROM tracks').get().n;
  const rows = db.prepare(`${TRACK_SELECT} ORDER BY t.added_at DESC, t.id DESC LIMIT ? OFFSET ?`).all(l, o);
  res.json({ total, offset: o, tracks: rows.map(pub) });
});
app.post('/api/favorite', (req, res) => {
  const tid = String((req.body && req.body.id) || '');
  const on = !!(req.body && req.body.on);
  if (!tid) return res.status(400).json({ ok: false });
  const prof = currentProfile(req);
  if (on) db.prepare('INSERT OR IGNORE INTO favs (profile, tid, added_at) VALUES (?, ?, ?)').run(prof, tid, Date.now());
  else db.prepare('DELETE FROM favs WHERE profile = ? AND tid = ?').run(prof, tid);
  res.json({ ok: true, on });
});

// ---------- playlists (persistent, tables already in schema) ----------
app.get('/api/playlists', (req, res) => {
  const rows = db.prepare(`
    SELECT p.id, p.name, COUNT(pt.tid) n
    FROM playlists p LEFT JOIN playlist_tracks pt ON pt.playlist_id = p.id
    WHERE p.profile = ? GROUP BY p.id ORDER BY p.created_at`).all(currentProfile(req));
  res.json({ playlists: rows });
});
app.post('/api/playlists', (req, res) => {
  const name = String((req.body && req.body.name) || '').trim().slice(0, 80);
  if (!name) return res.status(400).json({ ok: false, error: 'name required' });
  const id = Number(db.prepare('INSERT INTO playlists (name, created_at, profile) VALUES (?, ?, ?)').run(name, Date.now(), currentProfile(req)).lastInsertRowid);
  res.json({ ok: true, id, name });
});
// every playlist mutation is scoped to the caller's profile — you can only touch your own
const ownsPlaylist = (id, req) => !!db.prepare('SELECT 1 FROM playlists WHERE id = ? AND profile = ?').get(id, currentProfile(req));
app.post('/api/playlist-rename', (req, res) => {
  const id = parseInt(req.body && req.body.id, 10);
  const name = String((req.body && req.body.name) || '').trim().slice(0, 80);
  if (!id || !name) return res.status(400).json({ ok: false });
  if (!ownsPlaylist(id, req)) return res.status(404).json({ ok: false });
  db.prepare('UPDATE playlists SET name = ? WHERE id = ?').run(name, id);
  res.json({ ok: true });
});
app.post('/api/playlist-delete', (req, res) => {
  const id = parseInt(req.body && req.body.id, 10);
  if (!id) return res.status(400).json({ ok: false });
  if (!ownsPlaylist(id, req)) return res.status(404).json({ ok: false });
  db.prepare('DELETE FROM playlist_tracks WHERE playlist_id = ?').run(id);
  db.prepare('DELETE FROM playlists WHERE id = ?').run(id);
  res.json({ ok: true });
});
app.get('/api/playlist', (req, res) => {
  const id = intId(req.query.id);
  if (id === null) return res.status(400).json({ error: 'bad id' });
  const p = db.prepare('SELECT id, name FROM playlists WHERE id = ? AND profile = ?').get(id, currentProfile(req));
  if (!p) return res.status(404).json({ error: 'no such playlist' });
  const rows = db.prepare(`${TRACK_SELECT} JOIN playlist_tracks pt ON pt.tid = t.id
    WHERE pt.playlist_id = ? ORDER BY pt.pos`).all(id);
  res.json({ id: p.id, name: p.name, tracks: rows.map(pub) });
});
app.post('/api/playlist-add', (req, res) => {
  const pid = parseInt(req.body && req.body.pid, 10);
  const tid = String((req.body && req.body.tid) || '');
  if (!pid || !tid) return res.status(400).json({ ok: false });
  if (!ownsPlaylist(pid, req)) return res.status(404).json({ ok: false });
  const pos = (db.prepare('SELECT COALESCE(MAX(pos),0) m FROM playlist_tracks WHERE playlist_id = ?').get(pid).m) + 1;
  db.prepare('INSERT OR IGNORE INTO playlist_tracks (playlist_id, tid, pos) VALUES (?, ?, ?)').run(pid, tid, pos);
  res.json({ ok: true });
});
app.post('/api/playlist-remove', (req, res) => {
  const pid = parseInt(req.body && req.body.pid, 10);
  const tid = String((req.body && req.body.tid) || '');
  if (!pid || !tid) return res.status(400).json({ ok: false });
  if (!ownsPlaylist(pid, req)) return res.status(404).json({ ok: false });
  db.prepare('DELETE FROM playlist_tracks WHERE playlist_id = ? AND tid = ?').run(pid, tid);
  res.json({ ok: true });
});

// ---------- library passcode (second factor, gates everything below) ----------
const adminFail = new Map();
app.get('/api/admin-status', (req, res) => res.json({ authed: isAdmin(req) }));
app.post('/api/admin-auth', (req, res) => {
  if (currentProfile(req) !== 'owner') return res.status(403).json({ ok: false, error: 'owner only' });
  const ip = req.ip || req.connection.remoteAddress || 'unknown';
  const now = Date.now();
  const wait = lockWait(adminFail, ip, now);
  if (wait) return res.status(429).json({ ok: false, wait });
  const submitted = String((req.body && req.body.pin) || '').trim();
  if (submitted && pinEq(submitted, adminPin())) {
    adminFail.delete(ip);
    setCookie(res, req, ADMIN_COOKIE, ADMIN_TOKEN, COOKIE_MAX_AGE);
    return res.json({ ok: true });
  }
  lockFail(adminFail, ip, now);
  res.status(401).json({ ok: false });
});
app.post('/api/admin-pin', requireAdmin, (req, res) => {
  const next = String((req.body && req.body.pin) || '').trim();
  if (next.length < 3) return res.status(400).json({ ok: false, error: 'passcode too short' });
  let cfg = {}; try { cfg = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')); } catch { }
  cfg.adminPin = next;
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2));
  res.json({ ok: true });
});

// ---------- WebAuthn / passkey: phishing-resistant 2nd factor for PC control ----------
// A passkey is an ALTERNATIVE to the admin passphrase — verifying one sets the same
// ADMIN_COOKIE. The passphrase stays as recovery fallback (availability matters: this
// is the emergency remote-into-PC path). Credentials live in config.json (passkeys[]),
// the same robust on-disk store as adminPin — a pm2 env wipe can't lose them.
// Enrollment requires an already-admin session; auth shares the admin brute-force lockout.
const RP_NAME = 'Reel';
function rpFrom(req) {
  const host = String(req.headers.host || '').split(':')[0] || 'localhost';
  const rpID = process.env.WEBAUTHN_RP_ID || host;
  const origin = process.env.WEBAUTHN_ORIGIN || `${isHttps(req) ? 'https' : 'http'}://${req.headers.host}`;
  return { rpID, origin };
}
function getPasskeys() { const c = readConfig(); return Array.isArray(c.passkeys) ? c.passkeys : []; }
function setPasskeys(list) { const c = readConfig(); c.passkeys = list; writeConfig(c); }
// short-lived registration/auth challenge, keyed by the front-session token
const waChallenges = new Map();
function putChallenge(req, challenge) {
  const tok = parseCookies(req)[COOKIE_NAME] || 'anon';
  waChallenges.set(tok, { challenge, exp: Date.now() + 5 * 60 * 1000 });
}
function takeChallenge(req) {
  const tok = parseCookies(req)[COOKIE_NAME] || 'anon';
  const rec = waChallenges.get(tok);
  waChallenges.delete(tok);
  return rec && rec.exp >= Date.now() ? rec.challenge : null;
}

app.get('/api/webauthn/status', (req, res) =>
  res.json({ enrolled: getPasskeys().length, authed: isAdmin(req) }));

// enroll a passkey (must already hold the admin factor)
app.post('/api/webauthn/register-begin', requireAdmin, async (req, res) => {
  try {
    const { rpID } = rpFrom(req);
    const opts = await generateRegistrationOptions({
      rpName: RP_NAME, rpID,
      userName: 'reel-owner', userDisplayName: 'Reel Owner',
      attestationType: 'none',
      excludeCredentials: getPasskeys().map(p => ({ id: p.id, transports: p.transports })),
      authenticatorSelection: { residentKey: 'preferred', userVerification: 'preferred' },
    });
    putChallenge(req, opts.challenge);
    res.json(opts);
  } catch (e) { res.status(500).json({ ok: false, error: String(e.message || e) }); }
});
app.post('/api/webauthn/register-finish', requireAdmin, async (req, res) => {
  const expectedChallenge = takeChallenge(req);
  if (!expectedChallenge) return res.status(400).json({ ok: false, error: 'challenge expired' });
  const { rpID, origin } = rpFrom(req);
  let v;
  try {
    v = await verifyRegistrationResponse({
      response: req.body && req.body.att,
      expectedChallenge, expectedOrigin: origin, expectedRPID: rpID,
      requireUserVerification: false,
    });
  } catch (e) { return res.status(400).json({ ok: false, error: String(e.message || e) }); }
  if (!v.verified || !v.registrationInfo) return res.status(400).json({ ok: false });
  const c = v.registrationInfo.credential;
  const list = getPasskeys().filter(p => p.id !== c.id);
  list.push({
    id: c.id,
    publicKey: Buffer.from(c.publicKey).toString('base64url'),
    counter: c.counter || 0,
    transports: c.transports || [],
    label: String((req.body && req.body.label) || 'Passkey').slice(0, 40),
    createdAt: Date.now(),
  });
  setPasskeys(list);
  res.json({ ok: true, count: list.length });
});

// authenticate with a passkey → grants the admin cookie
app.post('/api/webauthn/auth-begin', async (req, res) => {
  if (currentProfile(req) !== 'owner') return res.status(403).json({ ok: false, error: 'owner only' });
  const ip = req.ip || 'unknown', now = Date.now();
  const wait = lockWait(adminFail, ip, now);
  if (wait) return res.status(429).json({ ok: false, wait });
  const creds = getPasskeys();
  if (!creds.length) return res.status(404).json({ ok: false, error: 'no passkeys enrolled' });
  try {
    const { rpID } = rpFrom(req);
    const opts = await generateAuthenticationOptions({
      rpID,
      allowCredentials: creds.map(p => ({ id: p.id, transports: p.transports })),
      userVerification: 'preferred',
    });
    putChallenge(req, opts.challenge);
    res.json(opts);
  } catch (e) { res.status(500).json({ ok: false, error: String(e.message || e) }); }
});
app.post('/api/webauthn/auth-finish', async (req, res) => {
  if (currentProfile(req) !== 'owner') return res.status(403).json({ ok: false, error: 'owner only' });
  const ip = req.ip || 'unknown', now = Date.now();
  const wait = lockWait(adminFail, ip, now);
  if (wait) return res.status(429).json({ ok: false, wait });
  const expectedChallenge = takeChallenge(req);
  if (!expectedChallenge) return res.status(400).json({ ok: false, error: 'challenge expired' });
  const assertion = req.body && req.body.asr;
  const creds = getPasskeys();
  const stored = assertion && creds.find(p => p.id === assertion.id);
  if (!stored) { lockFail(adminFail, ip, now); return res.status(401).json({ ok: false }); }
  const { rpID, origin } = rpFrom(req);
  let v;
  try {
    v = await verifyAuthenticationResponse({
      response: assertion,
      expectedChallenge, expectedOrigin: origin, expectedRPID: rpID,
      credential: {
        id: stored.id,
        publicKey: Buffer.from(stored.publicKey, 'base64url'),
        counter: stored.counter || 0,
        transports: stored.transports || [],
      },
      requireUserVerification: false,
    });
  } catch (e) { lockFail(adminFail, ip, now); return res.status(401).json({ ok: false, error: String(e.message || e) }); }
  if (!v.verified) { lockFail(adminFail, ip, now); return res.status(401).json({ ok: false }); }
  stored.counter = v.authenticationInfo.newCounter;   // bump replay counter
  stored.lastUsed = Date.now();
  setPasskeys(creds);
  adminFail.delete(ip);
  setCookie(res, req, ADMIN_COOKIE, ADMIN_TOKEN, COOKIE_MAX_AGE);
  res.json({ ok: true });
});

// manage enrolled passkeys
app.get('/api/webauthn/list', requireAdmin, (req, res) =>
  res.json({ passkeys: getPasskeys().map(p => ({ id: p.id, label: p.label, createdAt: p.createdAt, lastUsed: p.lastUsed || null })) }));
app.post('/api/webauthn/remove', requireAdmin, (req, res) => {
  const id = String((req.body && req.body.id) || '');
  setPasskeys(getPasskeys().filter(p => p.id !== id));
  res.json({ ok: true, count: getPasskeys().length });
});

// ---------- remote desktop status (now under the single Admin factor) ----------
app.get('/api/desktop-status', (req, res) => res.json({ authed: isAdmin(req) }));

// who am I — current profile (drives the per-login resume key + UI badge)
app.get('/api/me', (req, res) => {
  const prof = currentProfile(req);
  let name = 'Owner', kind = 'owner', code = PIN;
  if (prof.startsWith('m:')) { const m = readMembers().find(x => 'm:' + x.id === prof); name = m ? m.name : 'Member'; code = m ? m.code : ''; kind = 'member'; }
  else if (prof.startsWith('g:')) { const g = (readConfig().guests || []).find(x => 'g:' + x.code === prof); name = (g && g.name) || 'Guest'; code = (g && g.code) || ''; kind = 'guest'; }
  res.json({ profile: prof, name, kind, code, isAdmin: isAdmin(req), exp: sessionExp(req) });
});

// listen-time heartbeat — client posts the wall-clock seconds actually played
// since the last beat. Clamp per call so a hostile client can't inflate it.
app.post('/api/listened', (req, res) => {
  const sec = Math.max(0, Math.min(120, parseInt(req.body && req.body.sec, 10) || 0));
  if (sec) {
    try {
      db.prepare(`INSERT INTO profile_stats (profile, listened_sec) VALUES (?, ?)
                  ON CONFLICT(profile) DO UPDATE SET listened_sec = listened_sec + excluded.listened_sec`).run(currentProfile(req), sec);
    } catch { }
  }
  res.json({ ok: true });
});

// per-profile dashboard: listen time, favourites, plays, last track, session log
app.get('/api/profile-stats', (req, res) => {
  const prof = currentProfile(req);
  const st = db.prepare('SELECT listened_sec, logins, last_login, last_logout FROM profile_stats WHERE profile = ?').get(prof) || {};
  const favorites = db.prepare('SELECT COUNT(*) n FROM favs WHERE profile = ?').get(prof).n;
  const plays = db.prepare('SELECT COALESCE(SUM(play_count),0) n FROM plays WHERE profile = ?').get(prof).n;
  const last = db.prepare(`SELECT t.title, ar.name AS artist, p.last_played
    FROM plays p JOIN tracks t ON t.id = p.tid LEFT JOIN artists ar ON ar.id = t.artist_id
    WHERE p.profile = ? ORDER BY p.last_played DESC LIMIT 1`).get(prof);
  res.json({
    listenedSec: st.listened_sec || 0, favorites, plays,
    lastTitle: last ? (last.title || '') : '', lastArtist: last ? (last.artist || '') : '', lastAt: last ? last.last_played : null,
    logins: st.logins || 0, lastLogin: st.last_login || null, lastLogout: st.last_logout || null
  });
});

// ---------- library metadata edits (OWNER ONLY — global, shared by everyone) ----------
// rename a song. Sets title_locked so a future rescan won't revert it. Keeps the
// track id (md5 of path) stable, so favourites / play history stay linked.
app.post('/api/edit-track', requireOwner, (req, res) => {
  const id = String((req.body && req.body.id) || '').trim();
  const title = String((req.body && req.body.title) || '').trim().slice(0, 300);
  if (!id || !title) return res.status(400).json({ ok: false, error: 'id + title required' });
  const r = db.prepare('UPDATE tracks SET title = ?, title_locked = 1 WHERE id = ?').run(title, id);
  if (!r.changes) return res.status(404).json({ ok: false, error: 'no such track' });
  try { db.prepare('UPDATE search SET title = ? WHERE tid = ?').run(title, id); } catch { }
  res.json({ ok: true, id, title });
});

// rename an album. akey is left untouched so the indexer still matches the same
// row on rescan (it reuses albums by akey and never rewrites the title).
app.post('/api/edit-album', requireOwner, (req, res) => {
  const id = intId(req.body && req.body.id);
  const title = String((req.body && req.body.title) || '').trim().slice(0, 300);
  if (id == null || !title) return res.status(400).json({ ok: false, error: 'id + title required' });
  const r = db.prepare('UPDATE albums SET title = ? WHERE id = ?').run(title, id);
  if (!r.changes) return res.status(404).json({ ok: false, error: 'no such album' });
  try { db.prepare('UPDATE search SET album = ? WHERE tid IN (SELECT id FROM tracks WHERE album_id = ?)').run(title, id); } catch { }
  res.json({ ok: true, id, title });
});

// ---------- admin dashboard: every user's traffic (OWNER ONLY) ----------
app.get('/api/admin/users', requireOwner, (req, res) => {
  const now = Date.now();
  // who's connected right now (live, non-expired sessions)
  const online = new Set();
  for (const [, s] of sessions) if (!(s.exp != null && s.exp <= now)) online.add(s.profile);
  // per-profile aggregates — three grouped reads, joined in JS (cheap even at scale)
  const statRows = db.prepare('SELECT profile, listened_sec, logins, last_login, last_logout FROM profile_stats').all();
  const statBy = new Map(statRows.map(r => [r.profile, r]));
  const favBy  = new Map(db.prepare('SELECT profile, COUNT(*) n FROM favs GROUP BY profile').all().map(r => [r.profile, r.n]));
  const playBy = new Map(db.prepare('SELECT profile, COALESCE(SUM(play_count),0) n FROM plays GROUP BY profile').all().map(r => [r.profile, r.n]));
  const lastStmt = db.prepare(`SELECT t.title, ar.name AS artist, p.last_played
    FROM plays p JOIN tracks t ON t.id = p.tid LEFT JOIN artists ar ON ar.id = t.artist_id
    WHERE p.profile = ? ORDER BY p.last_played DESC LIMIT 1`);

  // roster: owner + members + live guests, then any orphan stat rows (former users)
  const roster = [{ profile: 'owner', name: 'Owner', code: PIN, kind: 'owner' }];
  for (const m of readMembers()) roster.push({ profile: 'm:' + m.id, name: m.name, code: m.code, kind: 'member', exp: m.exp || null });
  for (const g of readGuests())  roster.push({ profile: 'g:' + g.code, name: g.name || 'Guest', code: g.code, kind: 'guest', exp: g.exp });
  const known = new Set(roster.map(r => r.profile));
  for (const r of statRows) if (!known.has(r.profile)) roster.push({ profile: r.profile, name: '(former user)', code: '', kind: 'former' });

  const users = roster.map(u => {
    const st = statBy.get(u.profile) || {};
    const last = lastStmt.get(u.profile);
    return {
      profile: u.profile, name: u.name, code: u.code, kind: u.kind, exp: u.exp || null,
      online: u.kind === 'owner' ? true : online.has(u.profile),
      listenedSec: st.listened_sec || 0,
      plays: playBy.get(u.profile) || 0,
      favorites: favBy.get(u.profile) || 0,
      logins: st.logins || 0,
      lastLogin: st.last_login || null, lastLogout: st.last_logout || null,
      lastTitle: last ? (last.title || '') : '', lastArtist: last ? (last.artist || '') : '', lastAt: last ? last.last_played : null
    };
  }).sort((a, b) => (b.online - a.online) || (b.listenedSec - a.listenedSec));

  const totals = users.reduce((a, u) => ({ listenedSec: a.listenedSec + u.listenedSec, plays: a.plays + u.plays, favorites: a.favorites + u.favorites }), { listenedSec: 0, plays: 0, favorites: 0 });
  res.json({ users, totals, onlineNow: users.filter(u => u.online).length });
});

// a code can't collide with the owner PIN, a member, or another guest
function codeTaken(code, cfg) {
  return code === PIN || (cfg.members || []).some(m => m.code === code) || (cfg.guests || []).some(g => g.code === code);
}

// ---------- guest passcodes (admin-managed; share time-boxed stream access) ----------
app.get('/api/guests', requireAdmin, (req, res) => {
  const now = Date.now();
  res.json({ guests: readGuests().map(g => ({ code: g.code, name: g.name || '', exp: g.exp, remainingMin: Math.max(0, Math.round((g.exp - now) / 60000)) })) });
});
app.post('/api/guests', requireAdmin, (req, res) => {
  const mins = GUEST_TTLS[String((req.body && req.body.ttl) || '')];
  if (!mins) return res.status(400).json({ ok: false, error: 'bad ttl' });
  const name = String((req.body && req.body.name) || '').trim().slice(0, 40);
  if (!name) return res.status(400).json({ ok: false, error: 'name required' });
  const cfg = readConfig();
  cfg.guests = (cfg.guests || []).filter(g => g && g.exp > Date.now());
  let code;                                  // 4-digit, to match the front gate
  do { code = String(Math.floor(1000 + Math.random() * 9000)); } while (codeTaken(code, cfg));
  const exp = Date.now() + mins * 60000;
  cfg.guests.push({ code, exp, name });
  writeConfig(cfg);
  res.json({ ok: true, code, exp, name });
});
app.delete('/api/guests', requireAdmin, (req, res) => {
  const code = String((req.body && req.body.code) || '');
  const cfg = readConfig();
  cfg.guests = (cfg.guests || []).filter(g => g && g.code !== code);
  writeConfig(cfg);
  for (const [tok, s] of sessions) if (s.profile === 'g:' + code) sessions.delete(tok); // kick now
  purgeProfile('g:' + code);   // free the code cleanly — no stale data for the next holder
  res.json({ ok: true });
});

// ---------- members (admin-managed; permanent profiles with separate libraries) ----------
app.get('/api/members', requireAdmin, (req, res) => {
  const now = Date.now();
  res.json({ members: readMembers().map(m => ({ id: m.id, name: m.name, code: m.code, exp: m.exp || null, remainingMin: m.exp ? Math.max(0, Math.round((m.exp - now) / 60000)) : null })) });
});
app.post('/api/members', requireAdmin, (req, res) => {
  const name = String((req.body && req.body.name) || '').trim().slice(0, 40);
  const code = String((req.body && req.body.code) || '').trim();
  const ttl = String((req.body && req.body.ttl) || 'perm');
  if (!name) return res.status(400).json({ ok: false, error: 'name required' });
  if (!/^\d{4}$/.test(code)) return res.status(400).json({ ok: false, error: 'code must be 4 digits' });
  if (!(ttl in PROFILE_TTLS)) return res.status(400).json({ ok: false, error: 'bad duration' });
  const cfg = readConfig();
  cfg.members = cfg.members || [];
  if (codeTaken(code, cfg)) return res.status(409).json({ ok: false, error: 'code already in use' });
  const id = crypto.randomBytes(5).toString('hex');
  const mins = PROFILE_TTLS[ttl];
  const member = { id, name, code };
  if (mins) member.exp = Date.now() + mins * 60000;   // omit for permanent profiles
  cfg.members.push(member);
  writeConfig(cfg);
  res.json({ ok: true, id, name, code, exp: member.exp || null });
});
app.delete('/api/members', requireAdmin, (req, res) => {
  const id = String((req.body && req.body.id) || '');
  const cfg = readConfig();
  cfg.members = (cfg.members || []).filter(m => m.id !== id);
  writeConfig(cfg);
  for (const [tok, s] of sessions) if (s.profile === 'm:' + id) sessions.delete(tok); // log them out
  purgeProfile('m:' + id);   // remove their favs/history/playlists/stats
  res.json({ ok: true });
});

// re-hide the admin surface: clear the Admin factor so the menu vanishes again
app.post('/api/admin-lock', (req, res) => { setCookie(res, req, ADMIN_COOKIE, '', 0); res.json({ ok: true }); });

// monitor geometry within the VNC framebuffer, so the client can crop to one
// screen at a time. Queried live (handles the Omen being on or off). Cached 10s.
let _monCache = { at: 0, data: null };
app.get('/api/desktop-monitors', (req, res) => {
  if (!isDesktopAuthed(req)) return res.status(403).json({ error: 'desktop' });
  if (_monCache.data && Date.now() - _monCache.at < 10_000) return res.json(_monCache.data);
  const ps = "Add-Type -AssemblyName System.Windows.Forms;$s=[System.Windows.Forms.Screen]::AllScreens;" +
    "$mx=($s|%{$_.Bounds.X}|measure -Minimum).Minimum;$my=($s|%{$_.Bounds.Y}|measure -Minimum).Minimum;" +
    "$s|%{[pscustomobject]@{primary=$_.Primary;x=$_.Bounds.X-$mx;y=$_.Bounds.Y-$my;w=$_.Bounds.Width;h=$_.Bounds.Height}}|ConvertTo-Json -Compress";
  try {
    const out = execSync(`powershell -NoProfile -NonInteractive -Command "${ps}"`, { windowsHide: true, timeout: 8000 }).toString().trim();
    let mons = JSON.parse(out);
    if (!Array.isArray(mons)) mons = [mons];
    mons = mons.map((m, i) => ({
      x: m.x, y: m.y, w: m.w, h: m.h, primary: !!m.primary,
      label: m.primary ? 'Main' : (mons.length === 2 ? 'Omen' : 'Monitor ' + (i + 1))
    }));
    const fbW = Math.max(...mons.map(m => m.x + m.w));
    const fbH = Math.max(...mons.map(m => m.y + m.h));
    const data = { monitors: mons, fbW, fbH };
    _monCache = { at: Date.now(), data };
    res.json(data);
  } catch (e) { res.json({ monitors: [], fbW: 0, fbH: 0, error: 'probe failed' }); }
});

// ---------- roots management (point it at more music, no code) ----------
app.get('/api/roots', requireAdmin, (req, res) => {
  try { const c = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')); res.json({ roots: c.roots || [] }); }
  catch { res.json({ roots: [] }); }
});
app.post('/api/roots', requireAdmin, (req, res) => {
  const roots = Array.isArray(req.body && req.body.roots) ? req.body.roots : null;
  if (!roots) return res.status(400).json({ ok: false, error: 'roots array required' });
  const clean = [];
  for (const r of roots) {
    const p = String(r.path || '').trim();
    if (!p) continue;
    clean.push({ name: String(r.name || path.basename(p) || 'Music').trim(), path: p, exists: fs.existsSync(p) });
  }
  // preserve adminPin (and any other config keys) when rewriting roots
  let cfg = {}; try { cfg = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')); } catch { }
  cfg.roots = clean.map(({ name, path }) => ({ name, path }));
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2));
  res.json({ ok: true, roots: clean });
});

// ---------- re-index ----------
let scanProc = null;
app.post('/api/rescan', requireAdmin, (req, res) => {
  if (scanProc) return res.status(409).json({ ok: false, error: 'scan already running' });
  const log = fs.openSync(path.join(APP, 'indexer.log'), 'a');
  scanProc = spawn(process.execPath, [path.join(APP, 'indexer.js')], { stdio: ['ignore', log, log], windowsHide: true });
  scanProc.on('exit', () => { scanProc = null; buildTree(); });
  res.json({ ok: true });
});
app.get('/api/scan-status', (req, res) => {
  try { res.json(JSON.parse(fs.readFileSync(PROGRESS_PATH, 'utf8'))); }
  catch { res.json({ phase: 'idle' }); }
});

// ---------- streaming (by track id) ----------
const MIME = { mp3: 'audio/mpeg', flac: 'audio/flac', wav: 'audio/wav', ogg: 'audio/ogg', m4a: 'audio/mp4', aac: 'audio/aac', opus: 'audio/opus' };
// pipe a file stream into the response without letting a mid-stream fs error
// (file deleted, drive yanked, sector error) crash the process
function pipeSafe(stream, res) {
  stream.on('error', () => { try { res.destroy(); } catch { } });
  res.on('close', () => stream.destroy());
  stream.pipe(res);
}
// RFC 7233 single-range parser: "bytes=a-b" | "bytes=a-" | "bytes=-n".
// Returns { start, end } clamped to the file, or null if unusable.
function parseRange(header, total) {
  const m = /^bytes=(\d*)-(\d*)$/.exec(String(header).trim());
  if (!m || (!m[1] && !m[2])) return null;
  let start, end;
  if (!m[1]) {                       // suffix: last n bytes
    const n = parseInt(m[2], 10);
    if (n === 0) return null;
    start = Math.max(0, total - n); end = total - 1;
  } else {
    start = parseInt(m[1], 10);
    end = m[2] ? Math.min(parseInt(m[2], 10), total - 1) : total - 1;
  }
  if (start >= total || start > end) return null;
  return { start, end };
}
app.get('/stream/:id', (req, res) => {
  const t = db.prepare('SELECT path, ext FROM tracks WHERE id = ?').get(String(req.params.id));
  if (!t) return res.status(404).send('Not found');

  let stat;
  try { stat = fs.statSync(t.path); } catch { return res.status(404).send('File missing (drive offline?)'); }

  // count a play only on the opening request — follow-up range chunks from
  // seeking/buffering are the same listen, not new plays
  const range = req.headers.range;
  if (!range || parseRange(range, stat.size)?.start === 0) {
    const now = Date.now(), pid = String(req.params.id), prof = currentProfile(req);
    try {
      db.prepare('UPDATE tracks SET play_count = play_count + 1, last_played = ? WHERE id = ?').run(now, pid); // global popularity (search ranking)
      db.prepare(`INSERT INTO plays (profile, tid, last_played, play_count) VALUES (?, ?, ?, 1)
                  ON CONFLICT(profile, tid) DO UPDATE SET last_played = excluded.last_played, play_count = play_count + 1`).run(prof, pid, now); // per-profile history
    } catch { }
  }

  if (t.ext === 'wma') {
    if (!FFMPEG) return res.status(415).send('wma requires ffmpeg');
    res.writeHead(200, { 'Content-Type': 'audio/mpeg' });
    const ff = spawn(FFMPEG, ['-v', 'quiet', '-i', t.path, '-f', 'mp3', '-b:a', '192k', '-'], { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true });
    ff.stdout.pipe(res);
    ff.on('error', () => { try { res.end(); } catch { } });
    res.on('close', () => { try { ff.kill('SIGKILL'); } catch { } });
    return;
  }

  // FLAC is ~4-5x the bitrate of the library's MP3s, so over the tunnel it
  // re-buffers on weak mobile data. Transcode to 256k MP3 on the fly and
  // cache the result — first play streams live from ffmpeg AND writes a
  // sidecar; subsequent plays serve the sidecar with full range support.
  if (t.ext === 'flac' && FFMPEG) {
    const cacheDir = path.join(APP, 'transcode-cache');
    try { fs.mkdirSync(cacheDir, { recursive: true }); } catch { }
    const cachePath = path.join(cacheDir, `${req.params.id}.mp3`);
    let cacheStat = null;
    try { cacheStat = fs.statSync(cachePath); } catch { }
    if (cacheStat && cacheStat.size > 0) {
      const ctotal = cacheStat.size;
      if (range) {
        const r = parseRange(range, ctotal);
        if (!r) { res.writeHead(416, { 'Content-Range': `bytes */${ctotal}` }); return res.end(); }
        res.writeHead(206, {
          'Content-Range': `bytes ${r.start}-${r.end}/${ctotal}`,
          'Accept-Ranges': 'bytes', 'Content-Length': r.end - r.start + 1, 'Content-Type': 'audio/mpeg'
        });
        pipeSafe(fs.createReadStream(cachePath, { start: r.start, end: r.end }), res);
      } else {
        res.writeHead(200, { 'Content-Length': ctotal, 'Content-Type': 'audio/mpeg', 'Accept-Ranges': 'bytes' });
        pipeSafe(fs.createReadStream(cachePath), res);
      }
      return;
    }
    res.writeHead(200, { 'Content-Type': 'audio/mpeg' });
    const tmpPath = cachePath + '.part';
    const ff = spawn(FFMPEG, ['-v', 'quiet', '-i', t.path, '-vn', '-c:a', 'libmp3lame', '-b:a', '256k', '-f', 'mp3', '-'], { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true });
    const sidecar = fs.createWriteStream(tmpPath);
    let sidecarOk = true;
    sidecar.on('error', () => { sidecarOk = false; try { fs.unlinkSync(tmpPath); } catch { } });
    ff.stdout.on('data', chunk => {
      if (sidecarOk) sidecar.write(chunk);
      res.write(chunk);
    });
    ff.stdout.on('end', () => {
      sidecar.end();
      res.end();
      if (sidecarOk) { try { fs.renameSync(tmpPath, cachePath); } catch { } }
    });
    ff.on('error', () => { try { res.end(); } catch { } try { sidecar.destroy(); fs.unlinkSync(tmpPath); } catch { } });
    res.on('close', () => { try { ff.kill('SIGKILL'); } catch { } try { sidecar.destroy(); fs.unlinkSync(tmpPath); } catch { } });
    return;
  }

  const total = stat.size;
  const mime = MIME[t.ext] || 'audio/mpeg';
  if (range) {
    const r = parseRange(range, total);
    if (!r) {
      res.writeHead(416, { 'Content-Range': `bytes */${total}` });
      return res.end();
    }
    res.writeHead(206, {
      'Content-Range': `bytes ${r.start}-${r.end}/${total}`,
      'Accept-Ranges': 'bytes', 'Content-Length': r.end - r.start + 1, 'Content-Type': mime
    });
    pipeSafe(fs.createReadStream(t.path, { start: r.start, end: r.end }), res);
  } else {
    res.writeHead(200, { 'Content-Length': total, 'Content-Type': mime, 'Accept-Ranges': 'bytes' });
    pipeSafe(fs.createReadStream(t.path), res);
  }
});

// ===== VIDEO SHOWS =====
// Video folders are configured per-install. Add them to config.json:
//   "videoShows": [ { "id": "movies", "name": "Movies", "path": "/path/to/your/videos" } ]
const VIDEO_SHOWS_CFG = (() => {
  try { const c = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')); if (Array.isArray(c.videoShows)) return c.videoShows; } catch { }
  return [];
})();

const videoMap = new Map();
let _vidNext = 1;
const vidShowData = {};

const DUR_CACHE_PATH = path.join(APP, 'video-durations.json');
let durCache = {};
try { durCache = JSON.parse(fs.readFileSync(DUR_CACHE_PATH, 'utf8')); } catch {}
function saveDurCache() { try { fs.writeFileSync(DUR_CACHE_PATH, JSON.stringify(durCache)); } catch {} }

function probeDuration(fpath) {
  if (durCache[fpath]) return durCache[fpath];
  if (!FFMPEG) return 0;
  try {
    const ffprobe = FFMPEG.replace(/ffmpeg(\.exe)?$/i, 'ffprobe$1');
    const out = require('child_process').execSync(
      `"${ffprobe}" -v quiet -print_format json -show_format "${fpath}"`,
      { timeout: 12000, windowsHide: true }
    ).toString();
    const dur = Math.round(parseFloat(JSON.parse(out).format?.duration) || 0);
    if (dur) { durCache[fpath] = dur; saveDurCache(); }
    return dur;
  } catch { return 0; }
}

function parseVidFilename(fn) {
  const m = fn.match(/S(\d{1,2})E(\d{1,2})(\..*)?$/i);
  if (!m) return null;
  const season = parseInt(m[1], 10), ep = parseInt(m[2], 10);
  let title = '';
  if (m[3]) {
    const parts = m[3].slice(1).split('.');
    const qi = parts.findIndex(p => /^\d{3,4}[ip]?$|^BluRay$|^WEB|^HDTV$|^BrRip$|^x26\d|^HEVC$/i.test(p));
    if (qi > 0) title = parts.slice(0, qi).join(' ').trim();
  }
  return { season, ep, title };
}

function buildVideoCatalog() {
  for (const show of VIDEO_SHOWS_CFG) {
    if (!fs.existsSync(show.path)) continue;
    vidShowData[show.id] = { id: show.id, name: show.name, seasons: {} };
    const dirs = fs.readdirSync(show.path, { withFileTypes: true })
      .filter(e => e.isDirectory()).sort((a, b) => natural(a.name, b.name));
    for (const dir of dirs) {
      const sDir = path.join(show.path, dir.name);
      const files = fs.readdirSync(sDir)
        .filter(f => /\.(mkv|mp4|avi|mov)$/i.test(f))
        .sort((a, b) => natural(a, b));
      for (const file of files) {
        const parsed = parseVidFilename(file);
        if (!parsed) continue;
        const id = String(_vidNext++);
        const ep = {
          id, showId: show.id, showName: show.name,
          season: parsed.season, ep: parsed.ep, title: parsed.title,
          file, path: path.join(sDir, file)
        };
        videoMap.set(id, ep);
        const s = parsed.season;
        if (!vidShowData[show.id].seasons[s]) vidShowData[show.id].seasons[s] = [];
        vidShowData[show.id].seasons[s].push({ id, showId: show.id, showName: show.name, season: s, ep: parsed.ep, title: parsed.title });
      }
    }
  }
}
buildVideoCatalog();

const showPoster = id => {
  const f = path.join(PUBLIC_DIR, 'show-art', id + '.jpg');
  return fs.existsSync(f) ? '/show-art/' + id + '.jpg' : null;
};
app.get('/api/videos/shows', (req, res) => {
  const shows = Object.values(vidShowData).map(s => ({
    id: s.id, name: s.name, art: showPoster(s.id),
    seasons: Object.keys(s.seasons).length,
    episodes: Object.values(s.seasons).reduce((n, eps) => n + eps.length, 0)
  }));
  res.json({ shows });
});

app.get('/api/videos/episodes', (req, res) => {
  const showId = String(req.query.show || '');
  const season = parseInt(req.query.season, 10) || 0;
  const s = vidShowData[showId];
  if (!s) return res.status(404).json({ error: 'show not found' });
  const seasons = Object.keys(s.seasons).map(Number).sort((a, b) => a - b);
  const cur = season || seasons[0];
  res.json({ showId, showName: s.name, art: showPoster(showId), season: cur, seasons, episodes: s.seasons[cur] || [] });
});

app.get('/api/videos/info/:id', (req, res) => {
  const ep = videoMap.get(req.params.id);
  if (!ep) return res.status(404).json({ error: 'not found' });
  const dur = probeDuration(ep.path);
  res.json({ id: ep.id, showId: ep.showId, showName: ep.showName, season: ep.season, ep: ep.ep, title: ep.title, dur });
});

app.get('/video/:id', (req, res) => {
  const ep = videoMap.get(req.params.id);
  if (!ep) return res.status(404).send('Not found');
  if (!fs.existsSync(ep.path)) return res.status(404).send('File missing');
  if (!FFMPEG) return res.status(415).send('ffmpeg required for video streaming');

  const t = Math.max(0, parseFloat(req.query.t) || 0);
  const dur = durCache[ep.path] || 0;

  res.writeHead(200, {
    'Content-Type': 'video/mp4',
    'Cache-Control': 'no-cache',
    'X-Video-Duration': String(dur),
    'Access-Control-Expose-Headers': 'X-Video-Duration'
  });

  const ff = spawn(FFMPEG, [
    '-v', 'quiet',
    '-ss', String(t),
    '-i', ep.path,
    '-c:v', 'copy',
    '-c:a', 'aac',
    '-b:a', '192k',
    '-ac', '2',
    '-f', 'mp4',
    '-movflags', 'frag_keyframe+empty_moov+default_base_moof',
    '-'
  ], { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true });

  ff.stdout.pipe(res);
  res.on('close', () => { try { ff.kill('SIGKILL'); } catch {} });
  ff.on('error', () => { try { res.end(); } catch {} });
  // probe in background if not cached
  if (!dur) setImmediate(() => probeDuration(ep.path));
});

// ---------- last-resort handlers ----------
// unknown /api/* routes answer JSON, not the HTML 404 page
app.use('/api', (req, res) => res.status(404).json({ error: 'no such endpoint' }));
// any route that throws lands here instead of leaking a stack trace to the client
app.use((err, req, res, next) => {
  console.error(`[err] ${req.method} ${req.url}:`, err && err.message);
  if (res.headersSent) return res.destroy();
  res.status(err && err.type === 'entity.parse.failed' ? 400 : 500).json({ error: 'server error' });
});

// the lockout maps only ever grow — sweep expired entries hourly
setInterval(() => {
  const now = Date.now();
  for (const m of [failCounts, adminFail])
    // keep escalation state for 24h of idle so attackers can't reset their level
    for (const [ip, rec] of m)
      if (rec.until < now && rec.count === 0 && (now - (rec.seen || 0)) > 86_400_000) m.delete(ip);
  // drop lapsed sessions + prune expired guest codes / timed profiles from config
  for (const [tok, s] of sessions) if (s.exp != null && s.exp <= now) sessions.delete(tok);
  try {
    const c = readConfig(); let dirty = false;
    if (c.guests) { const live = c.guests.filter(g => g && g.exp > now); if (live.length !== c.guests.length) { c.guests.filter(g => g && g.exp <= now).forEach(g => purgeProfile('g:' + g.code)); c.guests = live; dirty = true; } }
    if (c.members) { const live = c.members.filter(m => m && (!m.exp || m.exp > now)); if (live.length !== c.members.length) { c.members.filter(m => m && m.exp && m.exp <= now).forEach(m => purgeProfile('m:' + m.id)); c.members = live; dirty = true; } }
    if (dirty) writeConfig(c);
  } catch { }
}, 3600_000).unref();

const server = app.listen(PORT, () => {
  const n = db.prepare('SELECT COUNT(*) n FROM tracks').get().n;
  const vn = videoMap.size;
  console.log(`Reel (Sona) on port ${PORT}`);
  console.log(`Library: ${n} tracks | Videos: ${vn} episodes | ffmpeg: ${FFMPEG ? 'yes' : 'no'} | db: ${DB_PATH}`);
  console.log(`PIN gate active | library passcode active`);
  // Loud warning if any factor is still on the shipped default — those are
  // effectively public. Change them before exposing the app to anything.
  const weak = [];
  if (PIN === '0000') weak.push('front PIN');
  if (adminPin() === DEFAULT_ADMIN_PIN) weak.push('Admin passcode — also gates PC control');
  if (weak.length) {
    console.log('!'.repeat(64));
    console.log(`SECURITY: still on DEFAULT credentials → ${weak.join(', ')}`);
    console.log('These are public knowledge. Set REEL_PIN / REEL_ADMIN_PIN');
    console.log('(or config.json adminPin) to long, unique values now.');
    console.log('!'.repeat(64));
  }
});
server.on('error', e => {
  console.error(e.code === 'EADDRINUSE' ? `Port ${PORT} already taken — is another Reel running?` : e);
  process.exit(1);
});

// ---------- remote desktop: WebSocket <-> VNC bridge ----------
// noVNC speaks RFB over a binary WebSocket; TightVNC speaks raw RFB/TCP on
// 127.0.0.1:5900 (loopback-only, no LAN exposure). We bridge the two in-process.
// The upgrade is gated by BOTH the front-door PIN and the desktop passcode —
// Express middleware doesn't run on raw upgrades, so we check cookies by hand.
const VNC_HOST = '127.0.0.1', VNC_PORT = 5900;
const wss = new WebSocketServer({ noServer: true });
server.on('upgrade', (req, socket, head) => {
  if (!String(req.url || '').startsWith('/desktop/ws')) { socket.destroy(); return; }
  // Anti cross-site-WebSocket-hijack: if an Origin is present it must match our
  // host. A malicious page can't then open this socket using the user's cookies.
  const origin = req.headers.origin;
  if (origin) {
    let oh = null; try { oh = new URL(origin).host; } catch { }
    if (oh !== req.headers.host) {
      socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }
  }
  const c = parseCookies(req);
  // owner session (not a guest token) AND the Admin factor — guests never reach the PC
  if (c[COOKIE_NAME] !== SESSION_TOKEN || c[ADMIN_COOKIE] !== ADMIN_TOKEN) {
    socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
    socket.destroy();
    return;
  }
  wss.handleUpgrade(req, socket, head, ws => {
    const tcp = net.connect(VNC_PORT, VNC_HOST);
    let alive = true;
    const tear = () => { if (!alive) return; alive = false; try { ws.close(); } catch {} try { tcp.destroy(); } catch {} };
    tcp.on('data', d => { if (ws.readyState === ws.OPEN) { try { ws.send(d); } catch { tear(); } } });
    tcp.on('error', tear); tcp.on('close', tear);
    ws.on('message', d => { if (tcp.writable) tcp.write(d); });
    ws.on('error', tear); ws.on('close', tear);
  });
});

// graceful shutdown: stop accepting, checkpoint + close the db, then exit.
// pm2 restart sends SIGINT — this keeps the WAL clean across deploys.
let shuttingDown = false;
function shutdown(sig) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`${sig} — shutting down`);
  server.close(() => {
    try { db.exec('PRAGMA wal_checkpoint(TRUNCATE)'); db.close(); } catch { }
    process.exit(0);
  });
  setTimeout(() => process.exit(0), 4000).unref(); // don't hang on open streams
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('unhandledRejection', e => console.error('[unhandledRejection]', e));
process.on('uncaughtException', e => { console.error('[uncaughtException]', e); process.exit(1); });
