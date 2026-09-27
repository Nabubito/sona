// Passcode gate. Self-contained: no accounts, no outside service.
//
// Where the passcode comes from, in order:
//   1. FORGE_PASS in the environment, or
//   2. a salted scrypt hash in <data>/auth.json, written the first time you
//      open Forge and choose a passcode. First-run setup is only accepted
//      from this machine (loopback socket AND a loopback Host header), so
//      nobody on the network can claim a fresh install before you do.
//
// A correct passcode earns a random session token in an HttpOnly cookie.
// Tokens live in memory, so restarting Forge signs everyone out.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const cfg = require('./config');

const AUTH_FILE = path.join(cfg.DATA_DIR, 'auth.json');
const COOKIE_NAME = 'forge_session';
const SESSION_MS = 30 * 24 * 3600 * 1000;
const MIN_LEN = 8;

const sessions = new Map(); // token -> expiry

function safeEq(a, b) {
  const A = Buffer.from(String(a)), B = Buffer.from(String(b));
  if (A.length !== B.length) return false;
  return crypto.timingSafeEqual(A, B);
}

function readStored() {
  try { const j = JSON.parse(fs.readFileSync(AUTH_FILE, 'utf8')); return j && j.salt && j.hash ? j : null; }
  catch { return null; }
}
function hashOf(pass, salt) { return crypto.scryptSync(String(pass), Buffer.from(salt, 'hex'), 32).toString('hex'); }

function mode() {
  if (cfg.PASSCODE) return 'env';
  return readStored() ? 'stored' : 'setup';
}
function check(pass) {
  if (!pass) return false;
  if (cfg.PASSCODE) return safeEq(pass, cfg.PASSCODE);
  const s = readStored();
  return !!s && safeEq(hashOf(pass, s.salt), s.hash);
}
function store(pass) {
  const salt = crypto.randomBytes(16).toString('hex');
  fs.mkdirSync(path.dirname(AUTH_FILE), { recursive: true });
  fs.writeFileSync(AUTH_FILE, JSON.stringify({ salt, hash: hashOf(pass, salt), createdAt: Date.now() }), { mode: 0o600 });
}

// ---- brute-force lockout: per client, plus a global cap ----
const fails = new Map();
let globalFails = { n: 0, until: 0 };
function lockState(ip) { return fails.get(ip) || { n: 0, until: 0 }; }
function noteFail(ip) {
  const s = lockState(ip); s.n++; if (s.n >= 8) { s.until = Date.now() + 15 * 60000; s.n = 0; } fails.set(ip, s);
  globalFails.n++; if (globalFails.n >= 30) { globalFails.until = Date.now() + 15 * 60000; globalFails.n = 0; }
}
function noteSuccess(ip) { fails.delete(ip); globalFails.n = 0; }
function locked(ip) { return lockState(ip).until > Date.now() || globalFails.until > Date.now(); }
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of fails) if (!v.until || v.until < now) fails.delete(k);
  for (const [t, exp] of sessions) if (exp < now) sessions.delete(t);
}, 60000).unref();

// ---- cookies ----
function parseCookies(req) {
  const out = {}; const h = req.headers.cookie; if (!h) return out;
  for (const p of h.split(';')) { const i = p.indexOf('='); if (i < 0) continue; out[p.slice(0, i).trim()] = decodeURIComponent(p.slice(i + 1).trim()); }
  return out;
}
function setCookie(res, req, val, maxAgeSec) {
  let c = `${COOKIE_NAME}=${encodeURIComponent(val)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAgeSec}`;
  if (req.headers['x-forwarded-proto'] === 'https') c += '; Secure';
  res.setHeader('Set-Cookie', c);
}
function isAuthed(req) {
  const t = parseCookies(req)[COOKIE_NAME];
  if (!t) return false;
  const exp = sessions.get(t);
  return !!exp && exp > Date.now();
}
function startSession(req, res) {
  const t = crypto.randomBytes(32).toString('hex');
  sessions.set(t, Date.now() + SESSION_MS);
  setCookie(res, req, t, SESSION_MS / 1000);
}

function isLoopbackAddr(a) { return a === '127.0.0.1' || a === '::1' || a === '::ffff:127.0.0.1'; }
function isLoopbackHost(h) {
  const host = String(h || '').replace(/:\d+$/, '').replace(/^\[|\]$/g, '').toLowerCase();
  return host === 'localhost' || host === '127.0.0.1' || host === '::1';
}
function clientIp(req) { return req.socket.remoteAddress || 'x'; }

function json(res, code, obj) { res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(obj)); }
function readJson(req, limit = 4096) {
  return new Promise((resolve) => {
    let b = '', over = false;
    req.on('data', d => { if (over) return; b += d; if (b.length > limit) { over = true; } });
    req.on('end', () => { if (over) return resolve({}); try { resolve(b ? JSON.parse(b) : {}); } catch { resolve({}); } });
  });
}

// Handles the gate's own endpoints. Returns true if it answered the request.
async function handle(req, res, p) {
  if (p === '/api/auth/status' && req.method === 'GET') {
    const m = mode();
    return json(res, 200, {
      authed: isAuthed(req), mode: m, minLength: MIN_LEN,
      canSetup: m === 'setup' && isLoopbackAddr(req.socket.remoteAddress) && isLoopbackHost(req.headers.host)
    }), true;
  }
  if (p === '/api/auth' && req.method === 'POST') {
    const ip = clientIp(req);
    if (locked(ip)) return json(res, 429, { ok: false, error: 'locked' }), true;
    const body = await readJson(req);
    const pass = String(body.passcode || '');
    if (mode() === 'setup') return json(res, 409, { ok: false, error: 'setup' }), true;
    if (check(pass)) { noteSuccess(ip); startSession(req, res); return json(res, 200, { ok: true }), true; }
    noteFail(ip);
    return json(res, 401, { ok: false, error: 'denied' }), true;
  }
  if (p === '/api/auth/setup' && req.method === 'POST') {
    if (mode() !== 'setup') return json(res, 409, { ok: false, error: 'already set' }), true;
    if (!isLoopbackAddr(req.socket.remoteAddress) || !isLoopbackHost(req.headers.host)) {
      return json(res, 403, { ok: false, error: 'Choose the first passcode from the machine Forge runs on.' }), true;
    }
    const body = await readJson(req);
    const pass = String(body.passcode || '');
    if (pass.length < MIN_LEN) return json(res, 400, { ok: false, error: `Use at least ${MIN_LEN} characters.` }), true;
    store(pass);
    startSession(req, res);
    return json(res, 200, { ok: true }), true;
  }
  if (p === '/api/logout' && req.method === 'POST') {
    const t = parseCookies(req)[COOKIE_NAME]; if (t) sessions.delete(t);
    setCookie(res, req, '', 0);
    return json(res, 200, { ok: true }), true;
  }
  return false;
}

module.exports = { handle, isAuthed, mode, MIN_LEN };
