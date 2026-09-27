'use strict';
//
// Small process helpers shared by every module that starts ffmpeg, yt-dlp or Python.
//
// Nothing here ever uses a shell: every child is started from an absolute path with an
// argument array, so no text can be read as a command.

const { spawn, execFile } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

let LOW_PRIORITY = true;
function setLowPriority(on) { LOW_PRIORITY = on !== false; }

// Find an executable on PATH. Only real executables: on Windows .exe and .com, since a .cmd or
// .bat would need a shell to run. Returns an absolute path or ''.
function which(name) {
  if (!name) return '';
  if (path.isAbsolute(name) || name.includes('/') || name.includes('\\')) {
    try { return fs.statSync(name).isFile() ? path.resolve(name) : ''; } catch { return ''; }
  }
  const dirs = String(process.env.PATH || '').split(path.delimiter).filter(Boolean);
  const exts = process.platform === 'win32' ? ['.exe', '.com'] : [''];
  for (const d of dirs) {
    for (const e of exts) {
      const lower = name.toLowerCase();
      const cand = path.join(d, exts.some((x) => x && lower.endsWith(x)) ? name : name + e);
      try { if (fs.statSync(cand).isFile()) return cand; } catch { /* keep looking */ }
    }
  }
  return '';
}

// Resolve a configured value: an absolute path, or a bare name looked up on PATH.
function resolveExe(configured, fallbackNames) {
  if (configured) return which(configured);
  for (const n of fallbackNames) { const p = which(n); if (p) return p; }
  return '';
}

function lower(p) {
  if (!LOW_PRIORITY || !p || !p.pid) return;
  try { os.setPriority(p.pid, os.constants.priority.PRIORITY_BELOW_NORMAL); } catch { /* not fatal */ }
}

// Kill a child AND everything it started. On Windows some tools (the yt-dlp exe is one) are a
// launcher that starts the real worker as its own child, so p.kill() alone takes out the
// launcher and leaves the worker running, outside every cap and still holding its pipes.
function killTree(p) {
  if (!p || !p.pid) return;
  const plain = () => { try { p.kill(); } catch { /* already gone */ } };
  if (process.platform !== 'win32') return plain();
  // ORDER MATTERS. taskkill walks the tree from the launcher's pid, so the launcher has to be
  // alive while it does. Killing the launcher first orphans the worker and taskkill then finds
  // nothing. So the plain kill only runs after taskkill is done, as a fallback, with a timer in
  // case taskkill itself ever hangs. Absolute path, never a bare name resolved through PATH.
  const exe = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'taskkill.exe');
  let fell = false;
  const once = () => { if (!fell) { fell = true; clearTimeout(t); plain(); } };
  const t = setTimeout(once, 5_000);
  try {
    const tk = spawn(exe, ['/PID', String(p.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
    tk.on('exit', once);
    tk.on('error', once);
  } catch { once(); }
}

// Run to completion and collect output (capped). Resolves { code, out, err }; never rejects.
function run(exe, args, opts) {
  opts = opts || {};
  return new Promise((resolve) => {
    if (!exe) return resolve({ code: -1, out: '', err: 'missing' });
    let p;
    try { p = spawn(exe, args, { windowsHide: true, env: opts.env || process.env, cwd: opts.cwd || undefined, stdio: ['ignore', 'pipe', 'pipe'] }); }
    catch (e) { return resolve({ code: -1, out: '', err: String(e && e.message) }); }
    lower(p);
    if (opts.hold) opts.hold.proc = p;
    let out = '', err = '', done = false;
    const cap = opts.maxOut || 16 * 1024 * 1024;
    const finish = (r) => { if (!done) { done = true; clearTimeout(killer); if (opts.hold) opts.hold.proc = null; resolve(r); } };
    const killer = setTimeout(() => { killTree(p); finish({ code: -2, out, err: err + '\ntimed out' }); }, opts.timeoutMs || 60_000);
    p.stdout.on('data', (d) => { out += d; if (out.length > cap) out = out.slice(-Math.floor(cap / 4)); if (opts.onOut) opts.onOut(String(d)); });
    p.stderr.on('data', (d) => { err += d; if (err.length > 256 * 1024) err = err.slice(-64 * 1024); });
    p.on('close', (code) => finish({ code, out, err }));
    p.on('error', (e) => finish({ code: -1, out: '', err: String(e && e.message) }));
  });
}

// Quick one-shot for detection: execFile with a timeout. Resolves { ok, out, err }.
function probeExe(exe, args, timeoutMs) {
  return new Promise((resolve) => {
    if (!exe) return resolve({ ok: false, out: '', err: 'missing' });
    try {
      execFile(exe, args, { windowsHide: true, timeout: timeoutMs || 20_000, maxBuffer: 8 * 1024 * 1024 }, (e, so, se) => {
        resolve({ ok: !e, out: String(so || ''), err: String(se || '') });
      });
    } catch (e) { resolve({ ok: false, out: '', err: String(e && e.message) }); }
  });
}

module.exports = { which, resolveExe, lower, killTree, run, probeExe, setLowPriority };
