'use strict';
//
// Flicker egress guard: a forward proxy every link import fetch is forced through.
//
// Only used when link import is switched on. Checking the link the owner pastes is not enough:
// redirects, DNS rebinding and extractors that follow URLs a page supplies can all steer the
// engine at this machine, the home network, or a private overlay network. So the engine is not
// allowed to open its own sockets. Every fetch goes through this proxy, which
//
//   1. refuses anything outside the port allowlist,
//   2. refuses local and owner hostnames by name,
//   3. resolves the host ITSELF and refuses if ANY returned address is private,
//   4. then dials the vetted IP literal, so a second DNS answer (rebinding)
//      can never be substituted between the check and the connect.
//
// It listens on 127.0.0.1, on an ephemeral port, and is never reachable from outside.

const http = require('http');
const net = require('net');
const dns = require('dns');

const ALLOWED_PORTS = new Set([80, 443, 8080, 8443]);
const MAX_SOCKETS = 96;
const IDLE_MS = 60_000;

// Everything that must never be reachable from a pasted link: this machine, private and
// carrier grade NAT ranges (the CGNAT block is where private overlay VPNs live), link local
// (cloud metadata), documentation, benchmarking, multicast and reserved space.
// Written in CIDR shorthand: missing trailing octets are zero, so "127/8" is 127.0.0.0/8.
const V4_BLOCKS = [
  '0/8', '10/8', '100.64/10', '127/8',
  '169.254/16', '172.16/12', '192.0.0/24', '192.0.2/24',
  '192.168/16', '198.18/15', '198.51.100/24', '203.0.113/24',
  '224/4', '240/4',
].map((c) => { const [a, p] = c.split('/'); const o = a.split('.'); while (o.length < 4) o.push('0'); return [o.join('.'), Number(p)]; });
const V6_BLOCKS = [
  ['::', 128], ['::1', 128], ['64:ff9b::', 96], ['fc00::', 7],
  ['fe80::', 10], ['ff00::', 8], ['2001:db8::', 32],
  // IPv6 transition schemes that embed an IPv4 address: 6to4 and Teredo. Refused whole, so an
  // IPv4 address hidden inside one (a loopback or home address) can never be reached through them.
  ['2002::', 16], ['2001::', 32],
];

const BLOCK = new net.BlockList();
for (const [a, p] of V4_BLOCKS) BLOCK.addSubnet(a, p, 'ipv4');
for (const [a, p] of V6_BLOCKS) BLOCK.addSubnet(a, p, 'ipv6');

// Names that only ever mean "somewhere on my side". The owner adds their own domains in
// config (linkImport.refuseHosts); each one refuses the name itself and every name under it.
const BASE_EXACT = ['localhost'];
// (Names on a private overlay VPN resolve into the CGNAT and fd00::/7 blocks above, so the
// address check refuses them whatever they are called.)
const BASE_SUFFIX = ['.localhost', '.local', '.internal', '.lan', '.home.arpa'];
let REFUSED_EXACT = new Set(BASE_EXACT);
let REFUSED_SUFFIX = BASE_SUFFIX.slice();

function cleanName(h) {
  let s = String(h == null ? '' : h).trim().toLowerCase();
  if (s.startsWith('[') && s.endsWith(']')) s = s.slice(1, -1);
  // Strip EVERY trailing dot, not just one: "name.example.." is the same name to a
  // resolver but slips past a single-dot strip.
  return s.replace(/\.+$/, '');
}

// Add the owner's own names. "my.domain" or ".my.domain" both refuse the name and every name under it.
function configureRefused(extra) {
  const exact = new Set(BASE_EXACT), suffix = BASE_SUFFIX.slice();
  for (const raw of Array.isArray(extra) ? extra : []) {
    const s = cleanName(raw).replace(/^\*?\.+/, '');
    if (!s || !/^[a-z0-9.-]+$/.test(s)) continue;
    exact.add(s);
    suffix.push('.' + s);
  }
  REFUSED_EXACT = exact;
  REFUSED_SUFFIX = suffix;
}

/* ------------------------------------------------------------------ *
 * IP normalisation
 * ------------------------------------------------------------------ */

// Expand any textual IPv6 to its 16 bytes, or null if it is not one.
// Needed so ::ffff:a.b.c.d (and the deprecated ::a.b.c.d) can be unwrapped and
// judged by the IPv4 rules instead of sliding past them.
function v6ToBytes(input) {
  let s = String(input).toLowerCase();
  if (!net.isIPv6(s)) return null;
  let v4tail = null;
  const dotted = s.match(/:((?:\d{1,3}\.){3}\d{1,3})$/);
  if (dotted) {
    const o = dotted[1].split('.').map(Number);
    if (o.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return null;
    v4tail = o;
    // The dotted tail occupies exactly two 16-bit groups; stand in for it so the
    // group arithmetic below stays correct, then paint the real bytes back on.
    s = s.slice(0, dotted.index + 1) + '0:0';
  }
  const halves = s.split('::');
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(':').filter((x) => x !== '') : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(':').filter((x) => x !== '') : [];
  let groups;
  if (halves.length === 2) {
    const fill = 8 - head.length - tail.length;
    if (fill < 0) return null;
    groups = head.concat(new Array(fill).fill('0'), tail);
  } else {
    groups = head;
  }
  if (groups.length !== 8) return null;
  const bytes = [];
  for (const g of groups) {
    if (!/^[0-9a-f]{1,4}$/.test(g)) return null;
    const n = parseInt(g, 16);
    bytes.push((n >> 8) & 255, n & 255);
  }
  if (v4tail) { bytes[12] = v4tail[0]; bytes[13] = v4tail[1]; bytes[14] = v4tail[2]; bytes[15] = v4tail[3]; }
  return bytes;
}

// Strip brackets / zone id, and flatten an IPv4-mapped or IPv4-compatible IPv6
// address down to its IPv4 form so one rule set covers both spellings.
function normalizeIp(ip) {
  let s = String(ip == null ? '' : ip).trim();
  if (s.startsWith('[') && s.endsWith(']')) s = s.slice(1, -1);
  const pct = s.indexOf('%');
  if (pct >= 0) s = s.slice(0, pct);
  if (net.isIPv6(s)) {
    const b = v6ToBytes(s);
    if (b) {
      const zeroTop = b.slice(0, 10).every((x) => x === 0);
      const mapped = zeroTop && b[10] === 255 && b[11] === 255;
      const compat = zeroTop && b[10] === 0 && b[11] === 0 && !(b[12] === 0 && b[13] === 0 && b[14] === 0);
      if (mapped || compat) return b.slice(12).join('.');
    }
  }
  return s;
}

// Fail closed: anything that is not a well-formed IP counts as blocked, because
// BlockList.check() quietly answers "false" for garbage it cannot parse.
function ipBlocked(ip) {
  const s = normalizeIp(ip);
  const fam = net.isIP(s);
  if (!fam) return true;
  return BLOCK.check(s, fam === 4 ? 'ipv4' : 'ipv6');
}

function hostnameRefused(host) {
  const s = cleanName(host);
  if (!s) return true;
  if (REFUSED_EXACT.has(s)) return true;
  return REFUSED_SUFFIX.some((sfx) => s.endsWith(sfx));
}

function portAllowed(p) { return ALLOWED_PORTS.has(Number(p)); }

function lookupAll(host) {
  return new Promise((resolve) => {
    dns.lookup(host, { all: true, verbatim: true }, (err, addrs) => {
      if (err || !Array.isArray(addrs)) return resolve([]);
      resolve(addrs);
    });
  });
}

// The single decision point. Returns the vetted IP literal to dial, or why not.
async function vetTarget(host, port) {
  if (!portAllowed(port)) return { ok: false, why: 'port' };
  let h = String(host == null ? '' : host).trim().toLowerCase();
  if (h.startsWith('[') && h.endsWith(']')) h = h.slice(1, -1);
  if (!h) return { ok: false, why: 'host' };
  if (net.isIP(h)) return ipBlocked(h) ? { ok: false, why: 'literal' } : { ok: true, ip: h };
  if (hostnameRefused(h)) return { ok: false, why: 'name' };
  const addrs = await lookupAll(h);
  if (!addrs.length) return { ok: false, why: 'dns' };
  for (const a of addrs) if (ipBlocked(a.address)) return { ok: false, why: 'private' };
  return { ok: true, ip: addrs[0].address };
}

/* ------------------------------------------------------------------ *
 * The proxy itself
 * ------------------------------------------------------------------ */

function splitHostPort(authority, defPort) {
  const s = String(authority == null ? '' : authority).trim();
  if (s.startsWith('[')) {
    const close = s.indexOf(']');
    if (close < 0) return null;
    const host = s.slice(1, close);
    const rest = s.slice(close + 1);
    if (!rest) return { host, port: defPort };
    if (rest[0] !== ':') return null;
    const port = Number(rest.slice(1));
    return Number.isInteger(port) ? { host, port } : null;
  }
  const i = s.lastIndexOf(':');
  if (i < 0) return s ? { host: s, port: defPort } : null;
  const host = s.slice(0, i);
  const port = Number(s.slice(i + 1));
  if (!host || !Number.isInteger(port)) return null;
  return { host, port };
}

function createEgressProxy() {
  const state = { sockets: new Set(), refused: 0, allowed: 0 };

  const armIdle = (sock) => {
    sock.setTimeout(IDLE_MS, () => { try { sock.destroy(); } catch { /* already gone */ } });
    sock.on('error', () => { try { sock.destroy(); } catch { /* already gone */ } });
  };

  const server = http.createServer();

  server.on('connection', (sock) => {
    if (state.sockets.size >= MAX_SOCKETS) { try { sock.destroy(); } catch { /* already gone */ } return; }
    state.sockets.add(sock);
    sock.on('close', () => state.sockets.delete(sock));
    armIdle(sock);
  });

  // Absolute-form plain HTTP (the request line carries the full URL)
  server.on('request', async (req, res) => {
    res.on('error', () => { /* client vanished mid-write */ });
    let target;
    try { target = new URL(req.url); } catch { target = null; }
    if (!target || (target.protocol !== 'http:' && target.protocol !== 'https:')) {
      state.refused++;
      res.writeHead(400, { 'Content-Type': 'text/plain' });
      return res.end('bad request');
    }
    const port = Number(target.port || (target.protocol === 'https:' ? 443 : 80));
    const verdict = await vetTarget(target.hostname, port);
    if (!verdict.ok) {
      state.refused++;
      res.writeHead(403, { 'Content-Type': 'text/plain', Connection: 'close' });
      return res.end('blocked');
    }
    // https over the plain path would need our own TLS client; the engine always
    // uses CONNECT for that, so treat it as not supported rather than guessing.
    if (target.protocol === 'https:') {
      state.refused++;
      res.writeHead(403, { 'Content-Type': 'text/plain', Connection: 'close' });
      return res.end('blocked');
    }
    const headers = {};
    for (const [k, v] of Object.entries(req.headers)) {
      const lk = k.toLowerCase();
      if (lk === 'proxy-connection' || lk === 'proxy-authorization' || lk === 'connection' || lk === 'keep-alive') continue;
      headers[k] = v;
    }
    headers.host = target.host;
    headers.connection = 'close';
    state.allowed++;
    const out = http.request({
      host: verdict.ip,
      port,
      method: req.method,
      path: target.pathname + target.search,
      headers,
      setHost: false,
      agent: false,
    });
    out.on('error', () => {
      if (!res.headersSent) { try { res.writeHead(502, { 'Content-Type': 'text/plain' }); } catch { /* raced */ } }
      try { res.end(); } catch { /* raced */ }
    });
    out.on('response', (up) => {
      up.on('error', () => { try { res.end(); } catch { /* raced */ } });
      try { res.writeHead(up.statusCode || 502, up.headers); } catch { try { res.end(); } catch { /* raced */ } return; }
      up.pipe(res);
    });
    req.on('error', () => { try { out.destroy(); } catch { /* raced */ } });
    req.pipe(out);
  });

  // CONNECT host:port  (every https fetch the engine makes)
  server.on('connect', async (req, clientSocket, head) => {
    clientSocket.on('error', () => { try { clientSocket.destroy(); } catch { /* already gone */ } });
    const hp = splitHostPort(req.url, 443);
    const verdict = hp ? await vetTarget(hp.host, hp.port) : { ok: false, why: 'parse' };
    if (!verdict.ok) {
      state.refused++;
      try { clientSocket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n'); } catch { /* raced */ }
      try { clientSocket.destroy(); } catch { /* raced */ }
      return;
    }
    state.allowed++;
    const upstream = net.connect({ host: verdict.ip, port: hp.port }, () => {
      try { clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n'); } catch { /* raced */ }
      if (head && head.length) upstream.write(head);
      upstream.pipe(clientSocket);
      clientSocket.pipe(upstream);
    });
    armIdle(upstream);
    upstream.on('error', () => {
      try { if (!clientSocket.destroyed) clientSocket.write('HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n'); } catch { /* raced */ }
      try { clientSocket.destroy(); } catch { /* raced */ }
    });
    upstream.on('close', () => { try { clientSocket.destroy(); } catch { /* raced */ } });
    clientSocket.on('close', () => { try { upstream.destroy(); } catch { /* raced */ } });
  });

  server.on('clientError', (err, sock) => { try { sock.destroy(); } catch { /* already gone */ } });
  server.on('error', () => { /* never take the app down over a proxy socket */ });

  return {
    start() {
      return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', () => {
          server.removeListener('error', reject);
          resolve(server.address().port);
        });
      });
    },
    get port() { const a = server.address(); return a ? a.port : 0; },
    get stats() { return { open: state.sockets.size, refused: state.refused, allowed: state.allowed }; },
    stop() { return new Promise((r) => server.close(() => r())); },
  };
}

module.exports = {
  createEgressProxy,
  configureRefused,
  ipBlocked,
  normalizeIp,
  hostnameRefused,
  portAllowed,
  vetTarget,
  ALLOWED_PORTS,
  MAX_SOCKETS,
};
