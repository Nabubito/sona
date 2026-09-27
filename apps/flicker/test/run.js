'use strict';
//
// Flicker's offline checks: the egress guard, the input rules, and the ffmpeg argument builders.
// Every guard is paired with a control that shows the check can fail (a check that cannot fail
// is not a check). No network access, no media files, no running server needed.

const http = require('http');
const net = require('net');
const EG = require('../lib/egress');
const LINK = require('../lib/linkimport');
const CLIP = require('../lib/clip');
const SUBS = require('../lib/subs');
const LABELS = require('../lib/labels');
const { safeSegment } = require('../server');

let pass = 0, fail = 0;
function ok(cond, name, extra) {
  if (cond) { pass++; console.log('PASS ' + name); }
  else { fail++; console.log('FAIL ' + name + (extra !== undefined ? '  (' + extra + ')' : '')); }
}

// a link that carries a user name and password
function withLogin(u) { const x = new URL(u); x.username = 'user'; x.password = 'pw'; return x.href; }

async function main() {
  // ---- addresses ----
  for (const ip of ['127.0.0.1', '172.16.5.5', '169.254.169.254', '0.0.0.0', '::1', '::ffff:127.0.0.1', '::ffff:7f00:1', 'fd12::1', 'fe80::1', '224.0.0.1', 'not-an-ip']) {
    ok(EG.ipBlocked(ip) === true, 'blocked ' + ip);
  }
  for (const ip of ['8.8.8.8', '1.1.1.1', '172.32.0.1', '2606:4700::1111']) ok(EG.ipBlocked(ip) === false, 'control: public ' + ip + ' allowed');
  // IPv6 transition schemes that carry an IPv4 address inside: 6to4 (2002::/16) and Teredo (2001::/32)
  for (const ip of ['2002:7f00:1::1', '2002:c0a8:101::1', '2001:0:4136:e378:8000:63bf:80ff:fffe', '2001::7f00:1']) ok(EG.ipBlocked(ip) === true, 'blocked transition address ' + ip);
  ok(EG.ipBlocked('2001:4860:4860::8888') === false, 'control: an ordinary 2001: address outside Teredo is allowed');

  EG.configureRefused(['my-own.domain']);
  for (const h of ['localhost', 'printer.local', 'nas.lan', 'box.internal', 'my-own.domain', 'cdn.my-own.domain..', '']) ok(EG.hostnameRefused(h) === true, 'refused name "' + h + '"');
  ok(EG.hostnameRefused('someone-else.domain') === false, 'control: an ordinary name is allowed');

  // ---- the link pre-check ----
  for (const u of ['file:///etc/passwd', 'javascript:alert(1)', '-o evil', 'http://127.0.0.1/', 'http://[::1]/', 'http://localhost/', withLogin('https://sona.casa/'), 'http://sona.casa:22/', 'http://sona.casa/\u0000', 'http://' + 'a'.repeat(2100) + '.domain/']) {
    ok(LINK.validUrl(u) === null, 'link refused: ' + u.slice(0, 40));
  }
  ok(LINK.validUrl('https://sona.casa/watch?v=1') === 'https://sona.casa/watch?v=1', 'control: a public link passes');

  // ---- arg builders: the URL can never become a flag, no cookies, the proxy is always there ----
  const a = LINK.buildInfoArgs('-o evil', 'http://127.0.0.1:1', 'cache');
  ok(a[0] === '--ignore-config' && a[a.length - 2] === '--' && a[a.length - 1] === '-o evil', 'info args: --ignore-config, URL after --');
  ok(a.includes('--proxy') && !a.some((x) => /cookie/i.test(x)), 'info args: proxy set, no cookies');
  const d = LINK.buildDownloadArgs({ dir: 'd', url: '--exec x', mode: 'studio', cacheDir: 'c', maxMB: 10, maxSec: 60, proxy: 'http://127.0.0.1:1' });
  ok(d[d.length - 2] === '--' && d[d.length - 1] === '--exec x' && !d.some((x) => /cookie/i.test(x)), 'download args: URL after --, no cookies');
  // every format term refuses streams that an outside player would fetch past the proxy
  for (const mode of ['studio', 'video', 'audio']) {
    for (const quality of ['best', 'compat', '720']) {
      const f = LINK.buildDownloadArgs({ dir: 'd', url: 'u', mode, quality, cacheDir: 'c', maxMB: 1, maxSec: 1, proxy: 'p' });
      const sel = f[f.indexOf('-f') + 1];
      const terms = sel.split(/[/+]/);
      ok(terms.length > 1 && terms.every((t) => t.endsWith(LINK.PROTOCOL_GUARD)), 'protocol guard on every format term (' + mode + ', ' + quality + ')', sel);
    }
  }
  ok(!LINK.guardFormats('b').endsWith('b'), 'control: the guard really changes a selector');
  for (const proto of ['rtmp', 'rtmpe', 'rtsp', 'mms', 'ftp']) ok(LINK.isMediaFormat({ protocol: proto, vcodec: 'h264', acodec: 'aac' }) === false, proto + ' format is not offered as media');
  ok(LINK.isMediaFormat({ url: 'rtmp://x/y', vcodec: 'h264', acodec: 'aac' }) === false, 'a format with no protocol field is judged by its URL');
  for (const proto of ['https', 'm3u8_native', 'http_dash_segments', 'f4m', 'ism']) ok(LINK.isMediaFormat({ protocol: proto, vcodec: 'h264', acodec: 'aac' }) === true, 'control: ' + proto + ' still counts as media');

  const env = LINK.spawnEnv('http://127.0.0.1:1');
  ok(env.HTTPS_PROXY === 'http://127.0.0.1:1' && env.http_proxy === 'http://127.0.0.1:1' && env.NO_PROXY === '', 'engine env points every proxy variable at the guard');

  // ---- the proxy against a canary that counts ----
  let hits = 0;
  const canary = http.createServer((q, s) => { hits++; s.end('canary'); });
  await new Promise((r) => canary.listen(0, '127.0.0.1', r));
  const cport = canary.address().port;
  const proxy = EG.createEgressProxy();
  const pport = await proxy.start();
  const viaGet = (url) => new Promise((resolve) => {
    const q = http.request({ host: '127.0.0.1', port: pport, method: 'GET', path: url }, (s) => { s.resume(); s.on('end', () => resolve(s.statusCode)); });
    q.on('error', () => resolve(-1)); q.end();
  });
  const viaConnect = (auth) => new Promise((resolve) => {
    const s = net.connect(pport, '127.0.0.1', () => s.write('CONNECT ' + auth + ' HTTP/1.1\r\n\r\n'));
    s.once('data', (b) => { resolve(Number((/^HTTP\/1\.1 (\d{3})/.exec(String(b)) || [])[1])); s.destroy(); });
    s.on('error', () => resolve(-1));
  });
  ok(await viaGet('http://127.0.0.1:8080/') === 403, 'proxy refuses loopback on an allowed port');
  ok(await viaGet('http://127.0.0.1:' + cport + '/') === 403, 'proxy refuses the canary');
  ok(await viaConnect('127.0.0.1:443') === 403, 'proxy refuses CONNECT to loopback');
  ok(await viaConnect('[::1]:443') === 403, 'proxy refuses CONNECT to [::1]');
  ok(await viaConnect('localhost:443') === 403, 'proxy refuses a local name');
  ok(await viaConnect('8.8.8.8:25') === 403, 'proxy refuses a port outside the allowlist');
  ok(hits === 0, 'canary saw nothing through the proxy', hits);
  await new Promise((r) => http.get('http://127.0.0.1:' + cport + '/', (s) => { s.resume(); s.on('end', r); }).on('error', r));
  ok(hits === 1, 'control: a direct request does reach the canary', hits);
  await proxy.stop();
  canary.close();

  // ---- ranges and filters ----
  ok(CLIP.validRange({ start: 1, end: 4 }, 10, 5).ok === true, 'range inside the video');
  ok(CLIP.validRange({ start: 1, end: 9 }, 10, 5).ok === false, 'range longer than the tool allows');
  ok(CLIP.validRange({ start: 5, end: 4 }, 10, 60).ok === false, 'backwards range');
  ok(CLIP.validRange({ start: '1;rm', end: 4 }, 10, 60).ok === false, 'text in a range');
  const args = CLIP.buildClipArgs({ src: 's', out: 'o', kind: 'video', start: '1e1', len: 2, subFilter: "subtitles=x.srt:force_style='FontName=evil'", subStyle: null });
  ok(!args.join(' ').includes('evil'), 'a filter that is not ours is never used');
  ok(args.includes('-protocol_whitelist') && args[args.indexOf('-protocol_whitelist') + 1] === 'file', 'ffmpeg pinned to local files');
  const good = SUBS.subtitleFilter('video', { look: 'box', font: 'arial', color: 'ember' });
  const withSub = CLIP.buildClipArgs({ src: 's', out: 'o', kind: 'video', start: 0, len: 2, subFilter: good, subStyle: { look: 'box', font: 'arial', color: 'ember' } });
  ok(withSub.join(' ').includes('subtitles=subs.srt'), 'control: our own filter is used');
  ok(SUBS.subtitleFilter('video', { font: "arial',evil" }) === SUBS.subtitleFilter('video', {}), 'unknown style names become the default');

  // ---- words ----
  const cl = SUBS.cleanLine('{\\fs900}<font color=red>Hi</font> &lt;b&gt;there');
  ok(/^Hi /.test(cl) && !/[<>{}\\&]/.test(cl), 'markup stripped from text', cl);
  ok(SUBS.cleanLine('plain words') === 'plain words', 'control: plain text untouched');
  const cues = SUBS.typedCues('one\ntwo\n\nthree', 6);
  ok(cues.length === 3 && cues[1].start === 2 && cues[2].end === 6, 'typed lines share the clip evenly');
  ok(SUBS.typedCues('   \n ', 6).length === 0, 'blank typed words give nothing');
  const tags = LABELS.normTags([{ id: 0, name: '{\\p1}m 0 0 l 9 9' }, { id: 9, name: 'x' }, { id: 1, name: 'Ok' }]);
  ok(tags.length === 2 && !/[{}\\]/.test(tags[0].name) && tags[1].name === 'Ok', 'follow labels cleaned and capped');

  // ---- static file names ----
  for (const s of ['styles.css::$DATA', '..', 'con.txt', 'app.js.', '.env', 'a b.js']) ok(safeSegment(s) === false, 'refused file name "' + s + '"');
  ok(safeSegment('app.js') === true, 'control: a plain file name is served');

  console.log('\nPASS ' + pass + ' / FAIL ' + fail);
  process.exit(fail ? 1 : 0);
}
main().catch((e) => { console.log('FAIL crashed: ' + (e && e.message)); process.exit(1); });
