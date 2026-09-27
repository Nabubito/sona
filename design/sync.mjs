#!/usr/bin/env node
// Sona UI sync: copies design/sona-ui into each app's public/assets/sona-ui/
// so every app stays standalone-deployable (no shared path at runtime).
//
//   node design/sync.mjs           copy into kin, reel, attic, forge, flicker
//   node design/sync.mjs --check   exit 1 if any app copy has drifted (for CI)
//   node design/sync.mjs --serve   serve the showcase on http://127.0.0.1:4173
//
// Only the apps listed below are touched. Other folders in apps/ are left alone.
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.join(HERE, 'sona-ui');
const APPS = ['kin', 'reel', 'attic', 'forge', 'flicker'];
const SKIP = new Set(['index.html', 'README.md']); // showcase + docs stay in design/
const dest = app => path.join(HERE, '..', 'apps', app, 'public', 'assets', 'sona-ui');

function files(dir, base = dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap(e => {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) return files(full, base);
    const rel = path.relative(base, full);
    return SKIP.has(rel) ? [] : [rel];
  });
}

const mode = process.argv[2] || '';

if (mode === '--serve') {
  const types = { '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript', '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.md': 'text/plain' };
  http.createServer((req, res) => {
    const rel = decodeURIComponent(new URL(req.url, 'http://x').pathname).replace(/^\/+/, '') || 'index.html';
    const file = path.join(SRC, rel);
    if (!file.startsWith(SRC) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); return res.end('not found'); }
    res.writeHead(200, { 'Content-Type': types[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
    fs.createReadStream(file).pipe(res);
  }).listen(4173, '127.0.0.1', () => console.log('Sona UI showcase: http://127.0.0.1:4173/'));
} else {
  const list = files(SRC);
  let drift = 0, copied = 0;
  for (const app of APPS) {
    const out = dest(app);
    if (!fs.existsSync(path.join(HERE, '..', 'apps', app))) { console.warn(`skip ${app}: not found`); continue; }
    for (const rel of list) {
      const a = fs.readFileSync(path.join(SRC, rel));
      const target = path.join(out, rel);
      const same = fs.existsSync(target) && Buffer.compare(a, fs.readFileSync(target)) === 0;
      if (same) continue;
      if (mode === '--check') { console.log(`drift: apps/${app}/public/assets/sona-ui/${rel.replace(/\\/g, '/')}`); drift++; continue; }
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, a); copied++;
    }
    // files that exist in the app copy but no longer in the source
    if (fs.existsSync(out)) for (const rel of files(out)) {
      if (!list.includes(rel)) { console.log(`${mode === '--check' ? 'drift' : 'stale (not removed)'}: apps/${app}/public/assets/sona-ui/${rel.replace(/\\/g, '/')}`); if (mode === '--check') drift++; }
    }
  }
  if (mode === '--check') { console.log(drift ? `${drift} file(s) out of sync. Run: node design/sync.mjs` : 'sona-ui is in sync in all apps'); process.exit(drift ? 1 : 0); }
  console.log(`synced ${list.length} files into ${APPS.join(', ')} (${copied} written)`);
}
