// Path guard. Every file or folder path that arrives from the browser goes
// through check() before Forge reads, writes, lists or hands it to a tool.
//
// A path is allowed only if, after resolving symlinks / junctions, it sits
// inside one of the allowed roots (default: your home folder, Forge's output
// folder and its upload inbox; set FORGE_ROOTS or "roots" in config.json).
// On Windows the comparison is case-insensitive and alternate data streams
// (name:stream), device paths and trailing dots/spaces are refused outright.
const fs = require('fs');
const path = require('path');
const cfg = require('./config');

const IS_WIN = process.platform === 'win32';
const norm = p => (IS_WIN ? p.toLowerCase() : p);

function httpError(status, msg) { const e = new Error(msg); e.status = status; return e; }

// realpath of the deepest existing ancestor, with the not-yet-existing tail
// re-attached. Lets us judge output paths that do not exist yet.
function realish(abs) {
  let cur = abs; const rest = [];
  for (;;) {
    try { return path.join(fs.realpathSync.native(cur), ...rest.reverse()); }
    catch {
      const parent = path.dirname(cur);
      if (parent === cur) return null;
      rest.push(path.basename(cur));
      cur = parent;
    }
  }
}

function resolveRoot(r) {
  const abs = path.resolve(cfg.APP_DIR, String(r));
  try { fs.mkdirSync(abs, { recursive: true }); } catch {}
  try { return fs.realpathSync.native(abs); } catch { return null; }
}
const ROOTS = [...new Set(cfg.ROOTS.map(resolveRoot).filter(Boolean))];

function isInside(real) {
  const r = norm(real);
  return ROOTS.some(root => { const n = norm(root); return r === n || r.startsWith(n.endsWith(path.sep) ? n : n + path.sep); });
}

// check(p, { mustExist, dir, file }) -> absolute real path, or throws (403/404/400).
function check(p, opts = {}) {
  if (typeof p !== 'string' || !p.trim()) throw httpError(400, 'No path given.');
  if (p.includes('\0') || p.length > 4096) throw httpError(400, 'Bad path.');
  let s = p.trim();
  if (IS_WIN) {
    s = s.replace(/\//g, '\\');
    if (s.startsWith('\\\\')) throw httpError(403, 'Network and device paths are not allowed.');
    if (s.indexOf(':', 2) !== -1) throw httpError(400, 'Bad path.');                 // name:stream
    if (s.split('\\').some(seg => seg && seg !== '.' && seg !== '..' && /[. ]$/.test(seg))) throw httpError(400, 'Bad path.');
  }
  const abs = path.resolve(s);
  const real = realish(abs);
  if (!real || !isInside(real)) throw httpError(403, 'That path is outside the folders Forge is allowed to use.');
  let st = null;
  try { st = fs.statSync(real); } catch {}
  if (opts.mustExist && !st) throw httpError(404, 'Not found.');
  if (st && opts.dir && !st.isDirectory()) throw httpError(400, 'Not a folder.');
  if (st && opts.file && !st.isFile()) throw httpError(400, 'Not a file.');
  return real;
}

const allowed = p => { try { check(p); return true; } catch { return false; } };

module.exports = { check, allowed, ROOTS, httpError };
