// Forge client. No inline handlers anywhere: every button carries
// data-act="name" and one delegated listener runs ACTS[name]. That keeps the
// page working under a strict script-src 'self' policy.
const $ = s => document.querySelector(s);
const view = $('#view');
const jobsMap = new Map();
let TOOLS = [];
let HEALTH = { engines: [], disc: { available: false }, outdir: '' };
let DISC_OK = false;

const api = async (path, body) => {
  const r = await fetch(path, body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {});
  if (r.status === 401) { location.href = '/gate.html'; throw new Error('locked'); }
  return r.json();
};
const fmt = n => { if (n == null) return ''; const u = ['B', 'KB', 'MB', 'GB', 'TB']; let i = 0; n = Number(n); while (n >= 1024 && i < 4) { n /= 1024; i++; } return n.toFixed(n < 10 && i ? 1 : 0) + ' ' + u[i]; };
const esc = s => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const ic = (name, cls) => (window.Sona ? Sona.icon(name, cls) : '');
const isPhone = () => window.matchMedia('(max-width: 720px)').matches;

// ---------- actions (event delegation) ----------
const ACTS = {
  view: el => setView(el.dataset.arg),
  pickRoute: () => pickThen(p => routeFile(p)),
  pickOpen: () => pickThen(p => openContainer(p)),
  pickMount: () => pickThen(p => mountDisc(p)),
  pickMakeIso: () => pickThen(p => makeIsoFromFolder(p), true),
  pickTool: el => pickThen(p => openMediaTool(el.dataset.arg, p)),
  pickArchIn: () => pickThen(p => addArchiveInput(p)),
  pickFolderInto: el => pickThen(p => { const f = document.getElementById(el.dataset.arg); if (f) f.value = p; }, true),
  pickInput: () => pickThen(p => { window._in = p; const b = document.getElementById('inPath'); if (b) b.textContent = p; }),
  tool: el => openMediaTool(el.dataset.arg),
  jobs: () => openJobs(),
  closeJobs: () => closeJobs(),
  verb: el => doVerbAt(+el.dataset.arg),
  mount: el => mountDisc(el.dataset.p),
  extract: el => extractContainer(el.dataset.p),
  test: el => testContainer(el.dataset.p),
  install: el => startInstall(el.dataset.arg),
  openDrive: el => openDrive(el.dataset.arg),
  eject: el => unmountDrive(el.dataset.arg),
  makeIso: () => makeIso(),
  runMedia: el => runMedia(el.dataset.arg),
  createArchive: () => createArchive(),
  closeModal: () => closeModal(),
  engines: () => showEngines(),
  reveal: el => { if (window.forge && window.forge.reveal) window.forge.reveal(el.dataset.p); },
  guide: el => toggleGuide(el.dataset.arg),
  lock: () => lock()
};
window.FORGE_ACTS = ACTS;   // editor.js adds its own
document.addEventListener('click', e => {
  const el = e.target.closest('[data-act]');
  if (!el || el.disabled) return;
  const f = Object.prototype.hasOwnProperty.call(ACTS, el.dataset.act) ? ACTS[el.dataset.act] : null;
  if (!f) return;
  e.preventDefault();
  f(el, e);
});
const btn = (act, label, icon, cls, extra) => `<button type="button" class="s-btn ${cls || ''}" data-act="${act}" ${extra || ''}>${icon ? ic(icon) : ''}${label}</button>`;

// ---------- in-app guidance ----------
const GUIDES = {
  home: {
    title: 'New here? Start with this',
    body: `<p><b>Forge is a free, private workshop for your files.</b> Things people usually pay for, upload to strangers, or install separate apps for, all in one window, all on <b>this machine</b>. Nothing ever leaves your computer.</p>
      <p class="lead">What you can do here</p>
      <ul>
        <li>${ic('film')}<span><b>Media</b>: turn a video into a GIF, shrink a huge clip so it fits in an email, rip the audio out of a video, resize an image for the web.</span></li>
        <li>${ic('disc')}<span><b>Discs</b>: open an <code>.iso</code> game or program and use it with no CD and no burning, or turn a folder into one <code>.iso</code> file.</span></li>
        <li>${ic('archive')}<span><b>Archives</b>: squeeze a folder into one small <code>.zip</code>, password-protect files, or unpack a <code>.zip</code> or <code>.rar</code> someone sent you.</span></li>
      </ul>
      <p><b>To start:</b> drop any file onto this window and Forge shows you what it can do with it. Or pick a toolset below.</p>`
  },
  discs: {
    title: 'What are Discs for?',
    body: `<p>A disc image (an <code>.iso</code> or <code>.img</code>) is an entire CD or DVD saved as a single file. This tab lets you use them with <b>no physical disc and no paid app</b>.</p>
      <p class="lead">What you can do</p>
      <ul>
        <li>${ic('play')}<span><b>Play or install</b> an old game or program from its <code>.iso</code>. <b>Mount</b> it and it appears as a drive (for example <code>E:</code>) as if you inserted the disc. <span class="muted">(Windows)</span></span></li>
        <li>${ic('folder')}<span><b>Pull files out</b> of an <code>.iso</code> without mounting it: open the image, then Extract.</span></li>
        <li>${ic('layers')}<span><b>Build your own <code>.iso</code></b> from any folder, handy for backups. Any size, no cap. <span class="muted">(Windows)</span></span></li>
      </ul>`
  },
  media: {
    title: 'What is Media for?',
    body: `<p>A <b>free, private GIF maker and video and audio converter</b>. No ads, no upload, and no size limit.</p>
      <p class="lead">What you can make</p>
      <ul>
        <li>${ic('gif')}<span>A shareable <b>GIF</b> from a video clip or screen recording.</span></li>
        <li>${ic('collapse')}<span>A <b>smaller MP4</b> that actually fits in an email or chat.</span></li>
        <li>${ic('music')}<span>An <b>MP3</b> pulled out of any video.</span></li>
        <li>${ic('image')}<span>A <b>resized or converted image</b> ready for the web or a form.</span></li>
        <li>${ic('scissors')}<span>A <b>trimmed clip</b> with just the part you want.</span></li>
      </ul>
      <p><b>To start:</b> pick a tool, choose a file, Run, then Save.</p>`
  },
  archives: {
    title: 'What are Archives for?',
    body: `<p>Bundle many files into one smaller, tidy file, or open ones you receive. Powered by <b>7-Zip</b>, free.</p>
      <p class="lead">What you can do</p>
      <ul>
        <li>${ic('archive')}<span><b>Shrink a folder</b> into one smaller <code>.zip</code> or <code>.7z</code> to email, upload, or back up.</span></li>
        <li>${ic('key')}<span><b>Password-protect</b> sensitive files with AES-256 encryption.</span></li>
        <li>${ic('folder')}<span><b>Open and unpack</b> a <code>.zip</code>, <code>.7z</code> or <code>.rar</code> someone sent you.</span></li>
        <li>${ic('check')}<span><b>Check a download is not corrupt</b> before you trust it (Test integrity).</span></li>
      </ul>`
  },
  tool: {
    title: 'How this works',
    body: `<p>Pick a file, adjust the options if you want (the defaults are good), then press <b>Run</b>. Your result appears below with a <b>Save</b> button, and it never left your machine.</p>`
  }
};
function guideOpen(key) {
  let v = null; try { v = localStorage.getItem('guide_' + key); } catch {}
  if (v === '1') return true;
  if (v === '0') return false;
  return !isPhone() && key === 'home';
}
function guideBlock(key) {
  const g = GUIDES[key]; if (!g) return '';
  const open = guideOpen(key);
  return `<div class="guide ${open ? '' : 'collapsed'}" id="guide_${key}">
    <button type="button" class="guide-h" data-act="guide" data-arg="${key}" aria-expanded="${open}" aria-controls="guideb_${key}">${ic('info')}<span class="guide-t">${esc(g.title)}</span><span class="guide-c"><span>${open ? 'Hide' : 'Show'}</span>${ic('chevron-down')}</span></button>
    <div class="guide-b" id="guideb_${key}">${g.body}</div></div>`;
}
function toggleGuide(k) {
  const el = document.getElementById('guide_' + k); if (!el) return;
  const c = el.classList.toggle('collapsed');
  try { localStorage.setItem('guide_' + k, c ? '0' : '1'); } catch {}
  const h = el.querySelector('.guide-h'); h.setAttribute('aria-expanded', String(!c));
  h.querySelector('.guide-c span').textContent = c ? 'Show' : 'Hide';
}
window.toggleGuide = toggleGuide;

// ---------- per-tab toolbar ----------
// [id, label, icon, action, arg]
const TOOLBARS = {
  home: [['open', 'Open file', 'folder', 'pickRoute'], ['editor', 'Video editor', 'scissors', 'view', 'edit'], ['jobs', 'Jobs', 'layers', 'jobs']],
  discs: [['openimg', 'Open image', 'disc', 'pickOpen'], ['mount', 'Mount', 'import', 'pickMount'], ['makeiso', 'Make ISO', 'layers', 'pickMakeIso'], ['jobs', 'Jobs', 'layers', 'jobs']],
  media: [['open', 'Open file', 'folder', 'pickRoute'], ['gif', 'Make GIF', 'gif', 'pickTool', 'video-to-gif'], ['compress', 'Compress', 'collapse', 'pickTool', 'compress-video'], ['audio', 'Extract audio', 'music', 'pickTool', 'extract-audio'], ['jobs', 'Jobs', 'layers', 'jobs']],
  archives: [['openarch', 'Open archive', 'folder', 'pickOpen'], ['newarch', 'Add to new archive', 'plus', 'pickArchIn'], ['jobs', 'Jobs', 'layers', 'jobs']],
  edit: []
};
function renderToolbar(name) {
  const tb = document.getElementById('toolbar'); if (!tb) return;
  const items = (TOOLBARS[name] || []).filter(([id]) => DISC_OK || !['mount', 'makeiso'].includes(id));
  if (!items.length) { tb.hidden = true; tb.innerHTML = ''; return; }
  tb.hidden = false;
  tb.innerHTML = items.map(([id, label, icon, act, arg]) =>
    `<button type="button" class="s-btn s-btn--ghost" data-tb="${id}" data-act="${act}"${arg ? ` data-arg="${esc(arg)}"` : ''}>${ic(icon)}${esc(label)}</button>`).join('');
}

// ---------- navigation ----------
// Bumped whenever the view changes, so a slow async render never paints over a newer one.
let viewSeq = 0;
const TITLES = { home: 'Home', discs: 'Discs', media: 'Media', edit: 'Video editor', archives: 'Archives', jobs: 'Jobs' };
function setView(name) {
  if (name === 'jobs') { openJobs(); return; }
  viewSeq++;
  closeJobs();
  document.body.dataset.tab = name;
  document.querySelectorAll('.nav[data-view]').forEach(b => {
    const on = b.dataset.view === name;
    b.classList.toggle('is-active', on);
    if (on) b.setAttribute('aria-current', 'page'); else b.removeAttribute('aria-current');
  });
  view.className = 'view';  // reset so the editor's full-bleed class never leaks into other tabs
  view.scrollTop = 0;
  renderToolbar(name);
  ({ home: renderHome, discs: renderDiscs, media: renderMedia, edit: window.renderEditor, archives: renderArchives }[name] || renderHome)();
  setStatus(TITLES[name] || 'Home');
  document.title = (name === 'home' ? 'Forge' : (TITLES[name] || 'Forge') + ' · Forge') + ' · Sona';
}
window.setView = setView;
function setStatus(msg, right) {
  const m = document.getElementById('stMsg'); if (m && msg !== undefined) m.textContent = msg;
  const r = document.getElementById('stRight'); if (r && right !== undefined) r.textContent = right;
}
document.querySelectorAll('.nav[data-view]').forEach(b => b.addEventListener('click', () => {
  if (b.dataset.view === 'jobs') { toggleJobs(); return; }
  setView(b.dataset.view);
}));

// ---------- home ----------
function enginesChips() {
  const chips = HEALTH.engines.filter(e => e.id !== 'ffprobe').map(e =>
    `<span class="eng ${e.present ? 'eng--on' : 'eng--missing'}"><i class="s-dot" aria-hidden="true"></i>${esc(e.label)}${e.present ? '' : ' missing'}</span>`);
  chips.push(`<span class="eng ${DISC_OK ? 'eng--on' : 'eng--off'}"><i class="s-dot" aria-hidden="true"></i>${DISC_OK ? 'discs' : 'discs off'}</span>`);
  return chips.join('');
}
function renderHome() {
  const card = (icon, title, sub, viewName, tools) => `<div class="card">
      <button type="button" class="card-head" data-act="view" data-arg="${viewName}"><span class="card-ic">${ic(icon)}</span><span><span class="card-title">${title}</span><span class="card-sub">${sub}</span></span>${ic('chevron-right')}</button>
      ${tools.map(([label, icon2, act, arg]) => `<button type="button" class="tool" data-act="${act}"${arg ? ` data-arg="${arg}"` : ''}>${ic(icon2)}${label}</button>`).join('')}
    </div>`;
  view.innerHTML = `
    <div class="hero"><div><h1 class="page-title s-wordmark">Forge</h1>
      <p class="sub">Discs, media, and archives in one workshop. Your files never leave the box.</p></div>
      <div class="home-engines"><button type="button" class="engines" data-act="engines" aria-label="Engines: tap for details">${enginesChips()}</button></div></div>
    ${missingBanner()}
    <button type="button" class="dropzone" id="dz" data-act="pickRoute">
      <span class="dz-icon">${ic('upload')}</span>
      <b>Drop any file here</b>
      <span>or ${isPhone() ? 'tap' : 'click'} to pick one. Forge suggests what to do with it.</span>
      <span class="fmts">iso · img · zip · 7z · rar · mp4 · mov · gif · webp · png · jpg · mp3 · wav</span>
    </button>
    <div class="cards">
      ${card('film', 'Media', 'GIF, compress, audio, images', 'media', [['All media tools', 'film', 'view', 'media'], ['Convert a file', 'wand', 'pickRoute']])}
      ${card('scissors', 'Video editor', 'Timeline, titles, export', 'edit', [['Open the editor', 'scissors', 'view', 'edit']])}
      ${card('archive', 'Archives', 'Zip, 7z, unpack, test', 'archives', [['Open an archive', 'folder', 'pickOpen'], ['New archive', 'plus', 'view', 'archives']])}
      ${card('disc', 'Discs', DISC_OK ? 'Mount and build ISOs' : 'Browse ISO images', 'discs', [['Open an image', 'disc', 'pickOpen'], [DISC_OK ? 'Mount or make ISO' : 'Browse and extract', 'layers', 'view', 'discs']])}
    </div>
    <div class="home-guide">${guideBlock('home')}</div>`;
}

// ---------- drop router ----------
async function routeFile(p) {
  const info = await api('/api/inspect', { path: p });
  if (!info.supported) { toast('No tool for .' + info.ext + ' files yet', true); return; }
  window._verbCtx = { verbs: info.verbs, p };
  openModal(`<h3>${esc(info.name)}</h3>
    <div class="muted">${esc(info.pillar === 'media' ? 'Media file' : info.pillar === 'disc' ? 'Disc image' : 'Archive')}. Pick what to do with it.</div>
    <div class="verbs">${info.verbs.map((v, i) => btn('verb', esc(v.label), verbIcon(v), i === 0 ? 's-btn--primary s-btn--block' : 's-btn--outline s-btn--block', `data-arg="${i}"`)).join('')}</div>
    <div class="modal-foot">${btn('closeModal', 'Cancel', '', 's-btn--ghost')}</div>`);
}
function verbIcon(v) {
  if (v.kind === 'container') return v.id === 'test' ? 'check' : v.id === 'extract' ? 'download' : 'folder';
  if (v.kind === 'disc') return 'import';
  return toolIcon(v.id);
}
window.doVerbAt = i => { const c = window._verbCtx; if (c && c.verbs[i]) doVerb(c.verbs[i], c.p); };
window.doVerb = (v, p) => {
  closeModal();
  if (v.kind === 'container') openContainer(p);
  else if (v.kind === 'disc' && v.id === 'mount') mountDisc(p);
  else if (v.kind === 'media') openMediaTool(v.id, p);
};

// ---------- container browser (disc + archive) ----------
const DISC_EXT = ['iso', 'img', 'bin', 'nrg', 'mdf', 'vhd', 'vhdx', 'dmg', 'wim'];
async function openContainer(p) {
  setView(DISC_EXT.includes(String(p).split('.').pop().toLowerCase()) ? 'discs' : 'archives');
  viewSeq++;   // the archive listing below owns the view now
  const mySeq = viewSeq;
  view.innerHTML = `<div class="pathbar">${ic('folder')}<b>${esc(p)}</b></div><div class="s-skel s-skel--title"></div>${Sona.skeleton('rows', 6)}`;
  setStatus('Reading ' + p.split(/[\\/]/).pop());
  const info = await api('/api/inspect', { path: p });
  const data = await api('/api/container/list', { path: p });
  if (mySeq !== viewSeq) return;
  if (data.error) { view.innerHTML = `<div class="result err">${ic('info')}<span>Could not read this file: ${esc(data.error)}</span></div>`; return; }
  const isDisc = info.pillar === 'disc';
  const totalSz = data.entries.reduce((a, e) => a + (e.size || 0), 0);
  const P = `data-p="${esc(p)}"`;
  const verbs = isDisc
    ? `${DISC_OK ? btn('mount', 'Mount', 'import', 's-btn--primary', P) : ''}${btn('extract', 'Extract all', 'download', DISC_OK ? 's-btn--outline' : 's-btn--primary', P)}`
    : `${btn('extract', 'Extract all', 'download', 's-btn--primary', P)}${btn('test', 'Test integrity', 'check', 's-btn--outline', P)}`;
  view.innerHTML = `
    <div class="pathbar">${ic(isDisc ? 'disc' : 'archive')}<b>${esc(p)}</b> <span class="badge">${esc(data.type || info.ext)}</span></div>
    <div class="row" style="margin-bottom:var(--sp-4)">${verbs}</div>
    ${data.entries.length ? `<div class="tablewrap"><table><thead><tr><th>Name</th><th class="sz">Size</th><th class="sz col-hide">Packed</th><th class="col-hide">Modified</th></tr></thead>
    <tbody>${data.entries.slice(0, 500).map(e => `<tr class="${e.dir ? 'dir' : ''}" data-ctx="entry" data-container="${esc(p)}" data-path="${esc(e.path)}" data-dir="${e.dir ? 1 : 0}">
      <td class="nm">${ic(e.dir ? 'folder' : 'file', 's-i--sm')}<span>${esc(e.path)}</span></td><td class="sz">${e.dir ? '' : fmt(e.size)}</td>
      <td class="sz col-hide">${e.packed != null ? fmt(e.packed) : ''}</td><td class="muted col-hide">${esc(e.modified)}</td></tr>`).join('')}</tbody></table></div>`
      : `<div class="s-empty"><div class="s-empty__icon">${ic('archive')}</div><h2 class="s-empty__title">It is empty</h2><p class="s-empty__text">This file holds no entries. Try another archive or image.</p></div>`}
    <div class="statusbar"><span>${data.entries.length} items</span><span>${fmt(totalSz)} total</span><span>${esc(data.type)}</span>${data.entries.length > 500 ? '<span>Showing the first 500</span>' : ''}</div>`;
  setStatus(p.split(/[\\/]/).pop());
}
window.openContainer = openContainer;
window.extractContainer = async (p) => {
  const r = await api('/api/container/extract', { path: p });
  if (r && r.error) return toast(r.error, true);
  toast('Extracting. Follow it in Jobs.'); openJobs();
};
window.testContainer = async (p) => {
  const r = await api('/api/container/test', { path: p });
  toast(r.ok ? 'Looks good: ' + r.message : 'Problem: ' + (r.message || 'the test failed'), !r.ok);
};
window.mountDisc = async (p) => {
  const r = await api('/api/disc/mount', { path: p });
  if (r.error) return toast('Mount failed: ' + r.error, true);
  toast(`Mounted as ${r.drive}: (${r.label || 'disc'})`);
  renderDiscs();
};

// ---------- discs view ----------
async function renderDiscs() {
  const head = `<h1 class="page-title">Discs</h1><p class="sub">${DISC_OK ? 'Mount, browse, and build ISO images.' : 'Browse and extract ISO images.'}</p>${guideBlock('discs')}`;
  if (!DISC_OK) {
    view.innerHTML = `${head}
      <div class="notice">${ic('info')}<span><b>Mount and Build ISO are off on this computer.</b> ${esc(HEALTH.disc.reason || '')}
        You can still open any disc image here to browse it and extract its files with 7-Zip.</span></div>
      <div class="s-empty"><div class="s-empty__icon">${ic('disc')}</div><h2 class="s-empty__title">Open a disc image</h2>
        <p class="s-empty__text">Pick an .iso or .img file to see what is inside and pull files out.</p>
        <div class="s-empty__actions">${btn('pickOpen', 'Choose an image', 'folder', 's-btn--primary')}</div></div>`;
    return;
  }
  const mySeq = viewSeq;
  view.innerHTML = `${head}<div class="section-title s-eyebrow">Mounted now</div>${Sona.skeleton('rows', 2)}`;
  const m = await api('/api/disc/mounted');
  if (mySeq !== viewSeq) return;
  const drives = (m || []).filter(v => /^[A-Za-z]$/.test(v.drive));
  view.innerHTML = `${head}
    <div class="section-title s-eyebrow">Mounted now</div>
    ${drives.length ? `<div class="tablewrap"><table><thead><tr><th>Drive</th><th>Label</th><th class="sz">Size</th><th>Actions</th></tr></thead><tbody>
      ${drives.map(v => `<tr><td><b>${v.drive}:</b></td><td>${esc(v.label)}</td><td class="sz">${fmt(v.size)}</td>
      <td><div class="row">${btn('install', 'Start install', 'play', 's-btn--primary s-btn--sm', `data-arg="${v.drive}"`)}
        ${btn('openDrive', 'Open', 'external', 's-btn--outline s-btn--sm', `data-arg="${v.drive}"`)}
        ${v.path ? btn('eject', 'Eject', 'close', 's-btn--ghost s-btn--sm', `data-arg="${v.drive}"`) : ''}</div></td></tr>`).join('')}</tbody></table></div>
      <p class="muted" style="margin-top:var(--sp-2)">Start install runs the disc's setup or autorun, from the Forge app window.</p>`
      : `<p class="muted">Nothing mounted. Mount an image to install or browse it.</p>`}
    <div class="section-title s-eyebrow">Open an image</div>
    ${btn('pickOpen', 'Choose an .iso or .img', 'folder', 's-btn--outline')}
    <div class="section-title s-eyebrow">Make ISO from a folder</div>
    <div class="formgrid">
      <label class="s-field span2"><span class="s-label">Source folder</span>
        <span class="row" style="flex-wrap:nowrap"><input class="s-input" id="mkFolder" placeholder="path/to/folder">${btn('pickFolderInto', 'Browse', 'folder', 's-btn--outline', 'data-arg="mkFolder"')}</span></label>
      <label class="s-field"><span class="s-label">Volume label</span><input class="s-input" id="mkLabel" placeholder="MY_DISC"></label>
    </div>
    ${btn('makeIso', 'Build ISO', 'layers', 's-btn--primary')}`;
}
async function makeIso() {
  const folder = $('#mkFolder').value.trim(), label = $('#mkLabel').value.trim();
  if (!folder) return toast('Pick a source folder first', true);
  const r = await api('/api/disc/make', { folder, label });
  if (r.error) return toast(r.error, true);
  toast('Building the ISO. Follow it in Jobs.'); openJobs();
}
window.makeIso = makeIso;

// ---------- media ----------
const TOOL_ICONS = { 'video-to-gif': 'gif', 'gif-to-mp4': 'film', 'compress-video': 'collapse', 'resize-video': 'crop', 'cut-video': 'scissors',
  'extract-audio': 'music', 'convert-audio': 'refresh', 'resize-image': 'crop', 'convert-image': 'image' };
const GROUP_ICONS = { 'GIF & Animation': 'gif', Video: 'video', Audio: 'music', Image: 'image' };
const toolIcon = id => TOOL_ICONS[id] || 'wand';
function renderMedia() {
  const groups = {};
  TOOLS.forEach(t => (groups[t.group] = groups[t.group] || []).push(t));
  view.innerHTML = `<h1 class="page-title">Media</h1><p class="sub">Local ffmpeg tools. No upload, no caps, no ads.</p>
    ${engineOk('ffmpeg') ? '' : missingBanner('ffmpeg')}
    ${guideBlock('media')}
    ${TOOLS.length ? Object.entries(groups).map(([g, ts]) => `<section class="toolgroup"><h2 class="s-eyebrow">${ic(GROUP_ICONS[g] || 'wand', 's-i--sm')}${esc(g)}</h2>
      <div class="tooltiles">${ts.map(t => `<button type="button" class="tooltile" data-act="tool" data-arg="${esc(t.id)}"><span class="tt-ic">${ic(toolIcon(t.id))}</span>
        <span class="tt-main"><span class="tt-t">${esc(t.label)}</span><span class="tt-s">${esc(t.accepts.slice(0, 5).join(' · '))}</span></span></button>`).join('')}</div></section>`).join('')
      : `<div class="s-empty"><div class="s-empty__icon">${ic('film')}</div><h2 class="s-empty__title">No media tools</h2><p class="s-empty__text">Forge could not load its tool list. Check that ffmpeg is installed, then restart Forge.</p><div class="s-empty__actions">${btn('engines', 'Check engines', 'cpu', 's-btn--primary')}</div></div>`}`;
}
async function openMediaTool(id, inputPath) {
  const t = TOOLS.find(x => x.id === id);
  if (!t) return;
  if (document.body.dataset.tab !== 'media') setView('media');
  viewSeq++;
  const opts = (t.options || []).map(o => {
    if (o.type === 'select') return `<label class="s-field"><span class="s-label">${esc(o.label)}</span><select class="s-select" data-k="${esc(o.key)}">${o.options.map(v => `<option ${v === o.default ? 'selected' : ''}>${esc(v)}</option>`).join('')}</select></label>`;
    return `<label class="s-field"><span class="s-label">${esc(o.label)}</span><input class="s-input" data-k="${esc(o.key)}" value="${esc(o.default)}" type="${o.type === 'number' ? 'number' : 'text'}"${o.type === 'number' ? ' inputmode="numeric"' : ''}></label>`;
  }).join('');
  view.innerHTML = `<div class="toolpage">
    ${btn('view', 'All media tools', 'back', 's-btn--ghost back', 'data-arg="media"')}
    <h1 class="page-title">${esc(t.label)}</h1><p class="sub">Accepts ${esc(t.accepts.join(', '))}</p>
    ${guideBlock('tool')}
    <div class="pathbar">${ic('file')}<b id="inPath">${inputPath ? esc(inputPath) : '<span class="muted">No file chosen yet</span>'}</b>
      ${btn('pickInput', 'Choose file', 'folder', 's-btn--outline')}</div>
    ${opts ? `<div class="formgrid">${opts}</div>` : ''}
    <button type="button" class="s-btn s-btn--primary s-btn--lg" id="runBtn" data-act="runMedia" data-arg="${esc(id)}">${ic('play')}Run</button>
    <div id="mout"></div></div>`;
  window._in = inputPath || null;
  setStatus(t.label);
}
window.openMediaTool = openMediaTool;
window.runMedia = async (id) => {
  if (!window._in) return toast('Choose a file first', true);
  const opts = {};
  document.querySelectorAll('#view [data-k]').forEach(el => opts[el.dataset.k] = el.value);
  const b = $('#runBtn'); b.disabled = true; b.lastChild.textContent = 'Running';
  $('#mout').innerHTML = `<div class="result"><div class="muted">Working on it. Big files take a while.</div><div class="prog indet"><i id="pbar"></i></div></div>`;
  const r = await api('/api/media/run', { toolId: id, path: window._in, options: opts });
  b.disabled = false; b.lastChild.textContent = 'Run';
  if (r.error) { $('#mout').innerHTML = `<div class="result err">${ic('info')}<span>${esc(r.error)}</span></div>`; return; }
  const dl = '/api/download?path=' + encodeURIComponent(r.out);
  const ext = (r.out.split('.').pop() || '').toLowerCase();
  let preview = '';
  if (['gif', 'png', 'jpg', 'jpeg', 'webp', 'bmp'].includes(ext)) preview = `<img src="${dl}" alt="Result preview">`;
  else if (['mp4', 'webm', 'mov'].includes(ext)) preview = `<video src="${dl}" controls></video>`;
  else if (['mp3', 'wav', 'm4a', 'ogg', 'flac'].includes(ext)) preview = `<audio src="${dl}" controls></audio>`;
  const outFwd = r.out.replace(/\\/g, '/');
  $('#mout').innerHTML = `<div class="result" data-ctx="result" data-out="${esc(outFwd)}"><div class="result-head">
    <b>${ic('check')}${esc(r.out.split(/[\\/]/).pop())}</b>
    <span class="row"><a class="s-btn s-btn--primary" href="${dl}">${ic('download')}Save</a>
    ${window.forge ? btn('reveal', 'Show in folder', 'folder', 's-btn--outline', `data-p="${esc(outFwd)}"`) : ''}</span></div>
    ${preview}</div>`;
  setStatus('Done: ' + r.out.split(/[\\/]/).pop());
};

// ---------- archives ----------
let archiveInputs = [];
function renderArchives() {
  view.innerHTML = `<h1 class="page-title">Archives</h1><p class="sub">Open zip, 7z and rar files, or pack your own with compression and a password.</p>
    ${engineOk('sevenzip') ? '' : missingBanner('sevenzip')}
    ${guideBlock('archives')}
    <div class="openbar"><span class="card-ic">${ic('folder')}</span><span class="openbar-main"><span class="card-title">Open an archive</span><span class="card-sub">Browse inside, extract one file or all, or test it</span></span>
      ${btn('pickOpen', 'Choose a file', 'folder', 's-btn--primary')}</div>
    <div class="section-title s-eyebrow">New archive</div>
    <div class="formgrid">
      <div class="s-field span2"><span class="s-label">Files to include</span>
        <div id="archFiles" class="chosen"></div>
        <div>${btn('pickArchIn', 'Add a file', 'plus', 's-btn--outline')}</div></div>
      <label class="s-field"><span class="s-label">Format</span><select class="s-select" id="afmt"><option>7z</option><option>zip</option><option>tar</option></select></label>
      <label class="s-field"><span class="s-label">Compression</span><select class="s-select" id="alvl"><option value="1">Fast</option><option value="5" selected>Balanced</option><option value="9">Max</option></select></label>
      <label class="s-field span2"><span class="s-label">Password (optional, AES-256)</span><input class="s-input" id="apw" type="text" placeholder="Leave blank for none" autocomplete="off"></label>
      <label class="s-field span2"><span class="s-label">Save the archive as</span><input class="s-input" id="aout" placeholder="${esc(HEALTH.outdir)}/archive.7z" value="${esc(HEALTH.outdir)}/archive.7z"></label>
    </div>
    ${btn('createArchive', 'Create archive', 'archive', 's-btn--primary s-btn--lg')}`;
  renderArchInputs();
}
window.addArchiveInput = p => { archiveInputs.push(p); if (document.body.dataset.tab !== 'archives') setView('archives'); renderArchInputs(); };
function renderArchInputs() { const el = $('#archFiles'); if (el) el.innerHTML = archiveInputs.map(p => `<span class="chip">${ic('file', 's-i--sm')}${esc(p)}</span>`).join(''); }
async function createArchive() {
  if (!archiveInputs.length) return toast('Add at least one file', true);
  const out = $('#aout').value.trim();
  const r = await api('/api/archive/create', {
    inputs: archiveInputs, out, format: $('#afmt').value,
    level: Number($('#alvl').value), password: $('#apw').value.trim() || undefined
  });
  if (r && r.error) return toast(r.error, true);
  toast('Creating the archive. Follow it in Jobs.'); openJobs();
}
window.createArchive = createArchive;

// ---------- jobs ----------
function paintJobs(sel) {
  const el = document.querySelector(sel) || $('#jobsList');
  const arr = [...jobsMap.values()].sort((a, b) => b.at - a.at);
  el.innerHTML = arr.length ? arr.map(j => `<div class="job" data-ctx="job" data-id="${esc(j.id)}">
    <div class="t"><b>${esc(j.label)}</b><span class="st ${esc(j.status)}">${esc(j.status === 'error' ? 'failed' : j.status)}</span></div>
    ${j.status === 'running' ? `<div class="prog"><i style="width:${Number(j.progress) || 0}%"></i></div>` : ''}
    ${j.out ? `<a class="dl" href="/api/download?path=${encodeURIComponent(j.out)}">${ic('download')}${esc(String(j.out).split(/[\\/]/).pop())}</a>` : ''}
    ${j.error ? `<div class="jerr">${esc(j.error)}</div>` : ''}
  </div>`).join('') : `<div class="s-empty jobs-empty"><div class="s-empty__icon">${ic('layers')}</div><h2 class="s-empty__title">No jobs yet</h2>
      <p class="s-empty__text">Convert a file, extract an archive or export a video. Long tasks show up here with a progress bar and a download link.</p></div>`;
}
function openJobs() {
  const t = $('#jobsTray'); t.classList.add('open'); t.setAttribute('aria-hidden', 'false');
  document.querySelectorAll('.nav[data-view="jobs"]').forEach(b => b.setAttribute('aria-expanded', 'true'));
  setTimeout(() => { try { $('#jobsClose').focus({ preventScroll: true }); } catch {} }, 40);
}
function closeJobs() {
  const t = $('#jobsTray'); if (!t.classList.contains('open')) return;
  t.classList.remove('open'); t.setAttribute('aria-hidden', 'true');
  document.querySelectorAll('.nav[data-view="jobs"]').forEach(b => b.setAttribute('aria-expanded', 'false'));
}
function toggleJobs() { if ($('#jobsTray').classList.contains('open')) closeJobs(); else openJobs(); }
window.openJobs = openJobs;
paintJobs('#jobsList');
const es = new EventSource('/api/jobs/stream');
es.onmessage = e => {
  const m = JSON.parse(e.data);
  if (m.type === 'job') { jobsMap.set(m.job.id, m.job); paintJobs('#jobsList'); if (window.onForgeJob) window.onForgeJob(m.job); }
  const running = [...jobsMap.values()].filter(j => j.status === 'running').length;
  document.querySelectorAll('.jobbadge').forEach(b => { b.textContent = running || ''; b.classList.toggle('show', !!running); });
};

// ---------- file picker ----------
function pickThen(cb, dirsOnly) {
  // App window (Electron): the system's own file dialog, parented and on top.
  if (window.forge && window.forge.isElectron) {
    (dirsOnly ? window.forge.pickFolder() : window.forge.pickFile()).then(p => { if (p) cb(p.replace(/\\/g, '/')); });
    return;
  }
  // Browser: a folder path can't be returned, so keep the server picker for that.
  if (dirsOnly) { openPicker(HEALTH.browseStart || '', cb, true); return; }
  // Browser file pick: open the real OS file dialog via a hidden <input>, then upload.
  nativeFilePick(cb);
}
window.pickThen = pickThen;
function nativeFilePick(cb) {
  let inp = document.getElementById('_nativePick');
  if (!inp) { inp = document.createElement('input'); inp.type = 'file'; inp.id = '_nativePick'; inp.hidden = true; document.body.appendChild(inp); }
  inp.value = '';
  inp.onchange = async () => {
    const f = inp.files[0]; if (!f) return;
    const p = await upload(f);
    if (p) cb(p);
  };
  inp.click();
}
async function upload(f) {
  toast('Uploading ' + f.name);
  setStatus('Uploading ' + f.name);
  try {
    const r = await fetch('/api/upload?filename=' + encodeURIComponent(f.name), { method: 'POST', body: f });
    const j = await r.json();
    if (j.path) { setStatus('Ready: ' + f.name); return j.path; }
    toast(j.error || 'Upload failed', true);
  } catch { toast('Upload failed', true); }
  return null;
}
function makeIsoFromFolder(folder) {
  setView('discs');
  setTimeout(() => { const f = document.getElementById('mkFolder'); if (f) { f.value = folder; f.scrollIntoView({ block: 'center' }); } toast('Folder set. Add a label, then Build ISO'); }, 60);
}
async function openPicker(dir, cb, dirsOnly) {
  const d = await api('/api/fs?dir=' + encodeURIComponent(dir));
  if (d.error) { toast(d.error, true); return; }
  const rows = [
    d.parent ? `<button type="button" class="fsrow d" data-dir="${esc(d.parent)}">${ic('back')}Up one folder</button>`
      : (d.roots || []).filter(r => r !== d.cwd).map(r => `<button type="button" class="fsrow d" data-dir="${esc(r)}">${ic('home')}${esc(r)}</button>`).join(''),
    dirsOnly ? `<button type="button" class="fsrow pick" data-pick="${esc(d.cwd)}">${ic('check')}Use this folder</button>` : '',
    ...d.entries.map(e => e.dir
      ? `<button type="button" class="fsrow d" data-dir="${esc(e.path)}">${ic('folder')}${esc(e.name)}</button>`
      : (dirsOnly ? '' : `<button type="button" class="fsrow" data-pick="${esc(e.path)}">${ic('file')}${esc(e.name)}</button>`))
  ].join('');
  openModal(`<h3>${dirsOnly ? 'Pick a folder' : 'Pick a file'}</h3>
    <div class="pathbar" style="margin:var(--sp-3) 0 0">${ic('folder')}<b>${esc(d.cwd)}</b></div><div class="fslist s-list s-list--inset">${rows}</div>
    <div class="modal-foot">${btn('closeModal', 'Cancel', '', 's-btn--ghost')}</div>`);
  document.querySelectorAll('#modalBox .fsrow').forEach(r => r.onclick = () => {
    if (r.dataset.dir) openPicker(r.dataset.dir, cb, dirsOnly);
    else { closeModal(); cb(r.dataset.pick); }
  });
}

// ---------- modal / toast / drop ----------
const modal = $('#modal');
function openModal(html) {
  const box = $('#modalBox');
  box.innerHTML = html;
  const h = box.querySelector('h3');
  if (h) { h.id = 'modalTitle'; box.setAttribute('aria-labelledby', 'modalTitle'); box.removeAttribute('aria-label'); }
  else { box.removeAttribute('aria-labelledby'); box.setAttribute('aria-label', 'Dialog'); }
  if (!modal.hasAttribute('data-open')) Sona.open(modal);
  else { const f = $('#modalBox').querySelector('button,input,select,textarea'); if (f) f.focus({ preventScroll: true }); }
}
function closeModal() { if (modal.hasAttribute('data-open')) Sona.close(modal); }
window.openModal = openModal;
window.closeModal = closeModal;
function toast(msg, isError) { if (window.Sona) Sona.toast(String(msg), { error: !!isError }); }
window.toast = toast;
window.openInExplorer = p => { if (window.forge) window.forge.openDrive(String(p).replace(/[:/\\]+$/, '') + ':'); else toast('Drive ' + p + ' is mounted'); };
function openDrive(d) { if (window.forge) window.forge.openDrive(d + ':'); else toast('Drive ' + d + ': is mounted. Open it in Explorer'); }
window.openDrive = openDrive;
async function startInstall(d) {
  if (!window.forge) { toast('Start install runs in the Forge app window (npm run app)'); return; }
  setStatus('Launching the installer on ' + d + ':');
  const r = await window.forge.runInstaller(d);
  if (r.launched) { toast('Launched ' + r.target); setStatus('Launched ' + r.target + ' from ' + d + ':'); }
  else if (r.opened) { toast('No installer found, opened ' + d + ':'); setStatus('No installer on ' + d + ':, opened the drive'); }
  else { toast('Could not launch: ' + (r.error || 'unknown'), true); }
}
window.startInstall = startInstall;
async function unmountDrive(d) {
  const r = await api('/api/disc/unmount-drive', { drive: d });
  if (r && r.error) return toast(r.error, true);
  toast('Ejected ' + d + ':'); renderDiscs();
}
window.unmountDrive = unmountDrive;

// whole-window drag & drop -> upload -> route
const hint = $('#drophint');
window.addEventListener('dragover', e => { e.preventDefault(); hint.classList.add('show'); const dz = $('#dz'); if (dz) dz.classList.add('hot'); });
window.addEventListener('dragleave', e => { if (e.clientX === 0 && e.clientY === 0) { hint.classList.remove('show'); const dz = $('#dz'); if (dz) dz.classList.remove('hot'); } });
window.addEventListener('drop', async e => {
  e.preventDefault(); hint.classList.remove('show');
  const dz = $('#dz'); if (dz) dz.classList.remove('hot');
  const f = e.dataTransfer.files[0]; if (!f) return;
  const p = await upload(f);
  if (p) routeFile(p);
});

// ---------- engines ----------
function engineOk(id) { const e = HEALTH.engines.find(x => x.id === id); return !!(e && e.present); }
function missingBanner(only) {
  const miss = HEALTH.engines.filter(e => !e.present && e.id !== 'ffprobe' && (!only || e.id === only));
  if (!miss.length) return '';
  return `<div class="notice warn">${ic('info')}<span><b>${miss.map(e => esc(e.label)).join(' and ')} not found.</b>
    ${miss.map(e => esc(e.powers)).join('; ')} will not work until ${miss.length > 1 ? 'they are' : 'it is'} installed.
    <button type="button" class="linkbtn" data-act="engines">How to install</button></span></div>`;
}
function showEngines() {
  const rows = HEALTH.engines.map(e => `<tr>
    <td><b>${esc(e.label)}</b><div class="muted">${esc(e.powers)}</div></td>
    <td>${e.present ? `<span class="pill ok">found</span> <div class="muted">${esc(e.via || '')}</div>`
      : `<span class="pill bad">missing</span>${e.note ? `<div class="muted">${esc(e.note)}</div>` : ''}${e.install ? `<div style="margin-top:6px"><code>${esc(e.install)}</code></div>` : ''}`}</td></tr>`).join('');
  openModal(`<h3>Engines</h3>
    <p class="muted" style="margin:0 0 var(--sp-4)">Forge ships no binaries. It uses the tools already on this machine, found on your PATH, in <code>config.json</code> (<code>engines.ffmpeg</code>, <code>engines.ffprobe</code>, <code>engines.sevenzip</code>), or in the <code>FORGE_FFMPEG</code>, <code>FORGE_FFPROBE</code> and <code>FORGE_7Z</code> environment variables. Restart Forge after installing.</p>
    <div class="tablewrap"><table class="engtable"><thead><tr><th>Engine</th><th>Status</th></tr></thead><tbody>${rows}
    <tr><td><b>Disc tools</b><div class="muted">Mount, eject, build ISO</div></td>
      <td>${DISC_OK ? '<span class="pill ok">available</span>' : '<span class="pill">off</span>'}<div class="muted">${DISC_OK ? 'Built into Windows' : esc(HEALTH.disc.reason || '')}</div></td></tr></tbody></table></div>
    <p class="muted" style="margin:var(--sp-4) 0 0">Output folder: <code>${esc(HEALTH.outdir)}</code></p>
    <div class="modal-foot">${btn('closeModal', 'Close', '', 's-btn--outline')}</div>`);
}
window.showEngines = showEngines;

// ---------- search (Ctrl+K) ----------
const SEARCH_EXTRA = [
  { label: 'Home', icon: 'home', kw: 'start drop', run: () => setView('home') },
  { label: 'Video editor', icon: 'scissors', kw: 'timeline movie edit cut titles export', run: () => setView('edit') },
  { label: 'Open an archive', icon: 'folder', kw: 'zip 7z rar unpack extract browse', run: () => pickThen(p => openContainer(p)) },
  { label: 'New archive', icon: 'archive', kw: 'zip 7z compress password create', run: () => setView('archives') },
  { label: 'Open a disc image', icon: 'disc', kw: 'iso img disc browse extract', run: () => pickThen(p => openContainer(p)) },
  { label: 'Jobs', icon: 'layers', kw: 'queue progress tasks downloads', run: () => openJobs() },
  { label: 'Engines', icon: 'cpu', kw: 'ffmpeg 7-zip install missing', run: () => showEngines() }
];
const searchIn = $('#search'), searchList = $('#searchList');
let searchHits = [], searchSel = 0;
function searchItems() {
  return TOOLS.map(t => ({ label: t.label, icon: toolIcon(t.id), kw: (t.group + ' ' + t.accepts.join(' ') + ' ' + t.id.replace(/-/g, ' ')).toLowerCase(), hint: t.group, accepts: t.accepts, run: () => openMediaTool(t.id) })).concat(SEARCH_EXTRA);
}
function runSearch() {
  const q = searchIn.value.trim().toLowerCase();
  if (!q) { closeSearch(); return; }
  const words = q.replace(/\bto\b/g, ' ').split(/\s+/).filter(Boolean);
  const conv = /(\w+)\s+to\s+(\w+)/.exec(q);   // "mp4 to gif": takes mp4, makes gif
  searchHits = searchItems().map(it => {
    const hay = (it.label + ' ' + it.kw).toLowerCase(), lbl = it.label.toLowerCase();
    let score = words.reduce((a, w) => a + (hay.includes(w) ? (lbl.includes(w) ? 2 : 1) : 0), 0);
    if (conv && it.accepts && it.accepts.includes(conv[1]) && lbl.includes(conv[2])) score += 4;
    return { it, score };
  }).filter(x => x.score > 0).sort((a, b) => b.score - a.score).slice(0, 8).map(x => x.it);
  searchSel = 0;
  searchList.innerHTML = searchHits.length ? searchHits.map((it, i) => `<button type="button" class="s-menu__item" role="option" id="sr${i}" data-i="${i}" aria-selected="${i === 0}">${ic(it.icon)}<span>${esc(it.label)}</span>${it.hint ? `<small>${esc(it.hint)}</small>` : ''}</button>`).join('')
    : `<div class="empty">Nothing matches. Try "gif", "zip" or "audio".</div>`;
  searchList.hidden = false; searchIn.setAttribute('aria-expanded', 'true');
  if (searchHits.length) searchIn.setAttribute('aria-activedescendant', 'sr0');
}
function closeSearch() { searchList.hidden = true; searchIn.setAttribute('aria-expanded', 'false'); searchIn.removeAttribute('aria-activedescendant'); }
function pickSearch(i) { const it = searchHits[i]; if (!it) return; closeSearch(); searchIn.value = ''; searchIn.blur(); it.run(); }
searchIn.addEventListener('input', runSearch);
searchIn.addEventListener('focus', () => { if (searchIn.value.trim()) runSearch(); });
searchIn.addEventListener('keydown', e => {
  if (e.key === 'Escape') { closeSearch(); searchIn.blur(); return; }
  if (!searchHits.length || searchList.hidden) return;
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault();
    searchSel = (searchSel + (e.key === 'ArrowDown' ? 1 : searchHits.length - 1)) % searchHits.length;
    searchList.querySelectorAll('[role="option"]').forEach((b, i) => b.setAttribute('aria-selected', String(i === searchSel)));
    searchIn.setAttribute('aria-activedescendant', 'sr' + searchSel);
  } else if (e.key === 'Enter') { e.preventDefault(); pickSearch(searchSel); }
});
searchList.addEventListener('mousedown', e => e.preventDefault());   // keep focus in the field
searchList.addEventListener('click', e => { const b = e.target.closest('[data-i]'); if (b) pickSearch(+b.dataset.i); });
searchIn.addEventListener('blur', () => setTimeout(closeSearch, 120));

// ---------- boot ----------
async function lock() { try { await fetch('/api/logout', { method: 'POST' }); } catch {} location.href = '/gate.html'; }
$('#lockBtn').addEventListener('click', lock);
$('#lockBtnPhone').addEventListener('click', lock);
$('#engines').addEventListener('click', showEngines);
document.addEventListener('keydown', e => {
  if ((e.ctrlKey || e.metaKey) && e.key === 'k') { e.preventDefault(); searchIn.focus(); searchIn.select(); }
  else if (e.key === 'Escape' && $('#jobsTray').classList.contains('open') && !modal.hasAttribute('data-open')) closeJobs();
});
if (!isPhone()) searchIn.placeholder = 'Search tools, try "mp4 to gif"';
(async () => {
  HEALTH = await api('/api/health');
  DISC_OK = !!(HEALTH.disc && HEALTH.disc.available);
  document.body.classList.toggle('no-disc', !DISC_OK);
  $('#engines').innerHTML = enginesChips();
  TOOLS = await api('/api/tools');
  setView('home');
})();

// ---------- context-menu providers (shared UI) ----------
window.extractOne = async (container, entryPath) => {
  await api('/api/container/extract', { path: container, selection: [entryPath] });
  toast('Extracting ' + entryPath.split(/[\\/]/).pop() + '. Follow it in Jobs.'); openJobs();
};
window.sendToEditor = async (out) => {
  setView('edit');
  setTimeout(() => { if (window.forgeEditorImport) window.forgeEditorImport(out); else toast('Opened the editor. Add it from Import'); }, 300);
};
if (window.CTX) {
  const forgeOK = () => !!(window.forge && window.forge.reveal);
  CTX.register('entry', (el) => {
    const container = el.dataset.container, path = el.dataset.path, isDir = el.dataset.dir === '1';
    const items = [];
    if (!isDir) items.push({ icon: 'download', label: 'Extract this item', run: () => extractOne(container, path) });
    items.push({ icon: 'download', label: 'Extract all', run: () => extractContainer(container) });
    items.push({ icon: 'layers', label: 'Copy name', run: () => CTX.copyText(path) });
    return items;
  });
  CTX.register('job', (el) => {
    const j = jobsMap.get(el.dataset.id); if (!j) return [];
    const items = [];
    if (j.out) {
      items.push({ icon: 'download', label: 'Open result', run: () => { window.location.href = '/api/download?path=' + encodeURIComponent(j.out); } });
      if (forgeOK()) items.push({ icon: 'folder', label: 'Show in folder', run: () => window.forge.reveal(j.out) });
      items.push({ icon: 'layers', label: 'Copy output path', run: () => CTX.copyText(j.out) });
    }
    if (j.error) items.push({ icon: 'layers', label: 'Copy error', run: () => CTX.copyText(j.error) });
    items.push({ sep: true });
    items.push({ icon: 'close', label: 'Remove from list', run: () => { jobsMap.delete(el.dataset.id); paintJobs('#jobsList'); } });
    return items;
  });
  CTX.register('result', (el) => {
    const out = el.dataset.out; if (!out) return [];
    const items = [
      { icon: 'wand', label: 'Open in another tool', run: () => routeFile(out) },
      { icon: 'scissors', label: 'Send to the video editor', run: () => sendToEditor(out) }
    ];
    if (forgeOK()) items.push({ icon: 'folder', label: 'Show in folder', run: () => window.forge.reveal(out) });
    items.push({ icon: 'layers', label: 'Copy output path', run: () => CTX.copyText(out) });
    return items;
  });
}

// right-click shell integration: Explorer verbs arrive here as {verb, file}
if (window.forge && window.forge.onHandle) {
  window.forge.onHandle(job => {
    if (!job || !job.file) return;
    setStatus('Right-click: ' + job.verb + ' ' + job.file.split('/').pop());
    if (job.verb === 'mount') { setView('discs'); mountDisc(job.file); }
    else if (job.verb === 'extract') { extractContainer(job.file); openJobs(); }
    else routeFile(job.file);
  });
}
