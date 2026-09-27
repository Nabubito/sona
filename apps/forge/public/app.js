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

// ---------- in-app guidance ----------
const GUIDES = {
  home: {
    title: 'New here? Start with this',
    body: `<p><b>Forge is a free, private workshop for your files.</b> Three things people usually pay for, upload to strangers, or install separate apps for, all in one window, all on <b>this machine</b>. Nothing ever leaves your computer.</p>
      <p class="lead">What you can do here:</p>
      <ul>
        <li>🎬 <b>Media</b>: turn a video into a GIF, shrink a huge clip so it fits in an email, rip the audio out of a video, resize an image for the web.</li>
        <li>💿 <b>Discs</b>: open an <code>.iso</code> game or program and use it with no CD and no burning, or turn a folder into one <code>.iso</code> file.</li>
        <li>🗜️ <b>Archives</b>: squeeze a folder into one small <code>.zip</code>, password-protect files, or unpack a <code>.zip</code>/<code>.rar</code> someone sent you.</li>
      </ul>
      <p><b>To start:</b> drag any file onto this window and Forge shows you what it can do with it. Or click a toolset on the left.</p>`
  },
  discs: {
    title: 'What are Discs for?',
    body: `<p>A disc image (an <code>.iso</code> or <code>.img</code>) is an entire CD or DVD saved as a single file. This tab lets you use them with <b>no physical disc and no paid app</b>.</p>
      <p class="lead">What you can do:</p>
      <ul>
        <li>▶️ <b>Play or install</b> an old game or program from its <code>.iso</code>. Just <b>Mount</b> it and it appears as a drive (e.g. <code>E:</code>) as if you inserted the disc. No burning needed. <span class="muted">(Windows)</span></li>
        <li>📂 <b>Pull files out</b> of an <code>.iso</code> without mounting it (Open image, then Extract).</li>
        <li>🏗️ <b>Build your own <code>.iso</code></b> from any folder, handy for backups or to run in another program. Any size, no cap. <span class="muted">(Windows)</span></li>
      </ul>
      <p class="muted">To start: Mount or Open an image below, or make one from a folder.</p>`
  },
  media: {
    title: 'What is Media for?',
    body: `<p>A <b>free, private GIF maker and video/audio converter</b>. Convert and edit video, audio, GIFs, and images with <b>no ads, no upload, and no size limit</b>.</p>
      <p class="lead">What you can create:</p>
      <ul>
        <li>🎞️ A shareable <b>GIF</b> from a video clip or screen recording.</li>
        <li>📉 A <b>smaller MP4</b> that actually fits in an email or chat.</li>
        <li>🎵 An <b>MP3</b> pulled out of any video.</li>
        <li>🖼️ A <b>resized or reformatted image</b> ready for the web or a form.</li>
        <li>✂️ A <b>trimmed clip</b> with just the part you want.</li>
      </ul>
      <p><b>To start:</b> pick a tool below, choose a file, Run, then Save. Or drop a file on Home and it suggests the right tool.</p>`
  },
  archives: {
    title: 'What are Archives for?',
    body: `<p>Bundle many files into one smaller, tidy file, or open ones you receive. Powered by <b>7-Zip</b>, free.</p>
      <p class="lead">What you can do:</p>
      <ul>
        <li>📦 <b>Shrink a folder</b> of files into one smaller <code>.zip</code>/<code>.7z</code> to email, upload, or back up.</li>
        <li>🔒 <b>Password-protect</b> sensitive files with real AES-256 encryption.</li>
        <li>📤 <b>Open and unpack</b> a <code>.zip</code>/<code>.7z</code>/<code>.rar</code> someone sent you.</li>
        <li>✅ <b>Check a download is not corrupt</b> before you trust it (Test integrity).</li>
        <li>🪓 <b>Split</b> a huge archive into smaller parts.</li>
      </ul>
      <p><b>To start:</b> Open an archive to browse inside it, or New archive to create one.</p>`
  },
  jobs: {
    title: 'What is Jobs for?',
    body: `<p>Your <b>task tray</b>. Any operation that takes more than an instant (converting a video, making an ISO, zipping a folder) runs here so you can keep working while it finishes.</p>
      <p class="lead">What you will see:</p>
      <ul>
        <li>⏳ A live <b>progress bar</b> while a task runs.</li>
        <li>⬇️ A <b>download link</b> to the finished file.</li>
        <li>⚠️ The <b>reason in red</b> if something failed.</li>
      </ul>
      <p class="muted">Open this tray any time with the ⚙ gear on the left rail.</p>`
  },
  tool: {
    title: 'How this works',
    body: `<p>Pick a file, adjust the options if you want (the defaults are good), then press <b>Run</b>. Your result appears below with a <b>Save</b> button, and it never left your machine.</p>`
  }
};
function guideBlock(key) {
  const g = GUIDES[key]; if (!g) return '';
  const collapsed = localStorage.getItem('guide_' + key) === '0';
  return `<div class="guide ${collapsed ? 'collapsed' : ''}" id="guide_${key}">
    <div class="guide-h" onclick="toggleGuide('${key}')"><span>ⓘ ${esc(g.title)}</span><b>${collapsed ? '▸ show' : '▾ hide'}</b></div>
    <div class="guide-b">${g.body}</div></div>`;
}
window.toggleGuide = k => {
  const el = document.getElementById('guide_' + k); if (!el) return;
  const c = el.classList.toggle('collapsed');
  localStorage.setItem('guide_' + k, c ? '0' : '1');
  el.querySelector('.guide-h b').textContent = c ? '▸ show' : '▾ hide';
};

// ---------- per-tab toolbar ----------
// Each tab gets buttons for ITS OWN system (the old shared row was disc-centric).
// [iconId, label, onclick]. Icons are glyphs, no image files.
const TB_EMOJI = { open: '📂', openimg: '💿', mount: '⏏️', makeiso: '🏗️', gif: '🎞️', compress: '🗜️', resize: '📐', audio: '🎵', openarch: '📦', newarch: '➕', editor: '✂️', jobs: '⚙️' };
const TOOLBARS = {
  home: [['open', 'Open file', 'pickThen(p=>routeFile(p))'], ['editor', 'Video editor', "setView('edit')"], ['jobs', 'Jobs', 'openJobs()']],
  discs: [['openimg', 'Open image', 'pickThen(p=>openContainer(p))'], ['mount', 'Mount', 'pickThen(p=>mountDisc(p))'], ['makeiso', 'Make ISO', 'pickThen(p=>makeIsoFromFolder(p),true)'], ['jobs', 'Jobs', 'openJobs()']],
  media: [['open', 'Open file', 'pickThen(p=>routeFile(p))'], ['gif', 'Make GIF', "pickThen(p=>openMediaTool('video-to-gif',p))"], ['compress', 'Compress', "pickThen(p=>openMediaTool('compress-video',p))"], ['audio', 'Extract audio', "pickThen(p=>openMediaTool('extract-audio',p))"], ['jobs', 'Jobs', 'openJobs()']],
  archives: [['openarch', 'Open archive', 'pickThen(p=>openContainer(p))'], ['newarch', 'New archive', 'pickThen(p=>addArchiveInput(p))'], ['jobs', 'Jobs', 'openJobs()']],
  edit: []
};
function renderToolbar(name) {
  const tb = document.getElementById('toolbar'); if (!tb) return;
  const items = (TOOLBARS[name] || []).filter(([ico]) => DISC_OK || !['mount', 'makeiso'].includes(ico));
  if (!items.length) { tb.style.display = 'none'; tb.innerHTML = ''; return; }
  tb.style.display = '';
  tb.innerHTML = items.map(([ico, label, act]) =>
    `<button onclick="${act.replace(/"/g, '&quot;')}"><i class="tbi">${TB_EMOJI[ico] || '•'}</i><span>${label}</span></button>`).join('');
}

// ---------- navigation ----------
// Bumped whenever the view changes, so a slow async render never paints over a newer one.
let viewSeq = 0;
function setView(name) {
  viewSeq++;
  document.body.dataset.tab = name;
  document.querySelectorAll('.nav').forEach(b => b.classList.toggle('active', b.dataset.view === name));
  view.className = 'view';  // reset so the editor's full-bleed class never leaks into other tabs
  renderToolbar(name);
  ({ home: renderHome, discs: renderDiscs, media: renderMedia, edit: window.renderEditor, archives: renderArchives, jobs: renderJobs }[name] || renderHome)();
  setStatus(name.charAt(0).toUpperCase() + name.slice(1));
}
function setStatus(msg, right) {
  const m = document.getElementById('stMsg'); if (m && msg !== undefined) m.textContent = msg;
  const r = document.getElementById('stRight'); if (r && right !== undefined) r.textContent = right;
}
document.querySelectorAll('.nav[data-view]').forEach(b => b.onclick = () => {
  if (b.dataset.view === 'jobs') { $('#jobsTray').classList.toggle('open'); return; }
  setView(b.dataset.view);
});
$('#themeBtn').onclick = () => {
  const b = document.body, t = b.dataset.theme === 'dark' ? 'light' : 'dark';
  b.dataset.theme = t; $('#themeBtn').textContent = t === 'dark' ? '☾' : '☀';
};

// ---------- home ----------
function renderHome() {
  view.innerHTML = `
    <h1>Forge</h1>
    <div class="sub">Discs, media, and archives in one workshop. Your files never leave the box.</div>
    ${missingBanner()}
    ${guideBlock('home')}
    <div class="dropzone" id="dz">
      <b>Drop any file here</b>
      Or click to pick a file from disk
      <div class="fmts">iso · img · zip · 7z · rar · mp4 · mov · gif · webp · png · jpg · mp3 · wav …</div>
    </div>
    <div class="cards">
      <div class="card"><h3>⊙ Discs</h3>
        <button class="tool" onclick="pickThen(p=>openContainer(p))">Open image</button>
        <button class="tool" onclick="setView('discs')">${DISC_OK ? 'Mount / make ISO' : 'Browse / extract images'}</button></div>
      <div class="card"><h3>▷ Media</h3>
        <button class="tool" onclick="setView('media')">All ${TOOLS.length || ''} media tools</button>
        <button class="tool" onclick="pickThen(p=>routeFile(p))">Convert a file</button></div>
      <div class="card"><h3>▤ Archives</h3>
        <button class="tool" onclick="pickThen(p=>openContainer(p))">Open archive</button>
        <button class="tool" onclick="setView('archives')">New archive</button></div>
    </div>`;
  const dz = $('#dz');
  dz.onclick = () => pickThen(p => routeFile(p));
}

// ---------- drop router ----------
async function routeFile(p) {
  const info = await api('/api/inspect', { path: p });
  if (!info.supported) { toast('No tool for .' + info.ext + ' yet'); return; }
  const box = `<h3 style="margin-bottom:6px">${esc(info.name)}</h3>
    <div class="muted" style="margin-bottom:14px">Pillar: ${info.pillar}. Pick an action.</div>
    <div class="row">${info.verbs.map((v, i) =>
      `<button class="btn" onclick="doVerbAt(${i})">${esc(v.label)}</button>`).join('')}</div>`;
  window._verbCtx = { verbs: info.verbs, p };
  openModal(box);
}
window.doVerbAt = i => { const c = window._verbCtx; if (c && c.verbs[i]) doVerb(c.verbs[i], c.p); };
window.doVerb = (v, p) => {
  closeModal();
  if (v.kind === 'container') openContainer(p);
  else if (v.kind === 'disc' && v.id === 'mount') mountDisc(p);
  else if (v.kind === 'media') openMediaTool(v.id, p);
};

// ---------- container browser (disc + archive) ----------
async function openContainer(p) {
  setView('discs');
  viewSeq++;   // the archive listing below owns the view now
  view.innerHTML = `<div class="muted">Reading ${esc(p)} …</div>`;
  const info = await api('/api/inspect', { path: p });
  const mySeq = viewSeq;
  const data = await api('/api/container/list', { path: p });
  if (mySeq !== viewSeq) return;
  if (data.error) { view.innerHTML = `<div class="result">Could not read: ${esc(data.error)}</div>`; return; }
  const isDisc = info.pillar === 'disc';
  const totalSz = data.entries.reduce((a, e) => a + (e.size || 0), 0);
  const verbs = isDisc
    ? `${DISC_OK ? `<button class="btn" data-p="${esc(p)}" onclick="mountDisc(this.dataset.p)">Mount</button>` : ''}
       <button class="btn ${DISC_OK ? 'ghost' : ''}" data-p="${esc(p)}" onclick="extractContainer(this.dataset.p)">Extract all</button>`
    : `<button class="btn" data-p="${esc(p)}" onclick="extractContainer(this.dataset.p)">Extract all</button>
       <button class="btn ghost" data-p="${esc(p)}" onclick="testContainer(this.dataset.p)">Test integrity</button>`;
  view.innerHTML = `
    <div class="pathbar"><b>${esc(p)}</b> <span class="badge">${esc(data.type || info.ext)}</span></div>
    <div class="row" style="margin-bottom:14px">${verbs}</div>
    <table><thead><tr><th>Name</th><th class="sz">Size</th><th class="sz">Packed</th><th>Modified</th></tr></thead>
    <tbody>${data.entries.slice(0, 500).map(e => `<tr class="${e.dir ? 'dir' : ''}" data-ctx="entry" data-container="${esc(p)}" data-path="${esc(e.path)}" data-dir="${e.dir ? 1 : 0}">
      <td>${esc(e.path)}</td><td class="sz">${e.dir ? '' : fmt(e.size)}</td>
      <td class="sz">${e.packed != null ? fmt(e.packed) : ''}</td><td class="muted">${esc(e.modified)}</td></tr>`).join('')}</tbody></table>
    <div class="statusbar"><span>${data.entries.length} items</span><span>${fmt(totalSz)} total</span><span>${esc(data.type)}</span></div>`;
}
window.extractContainer = async (p) => {
  const r = await api('/api/container/extract', { path: p });
  toast('Extracting… (see Jobs)'); openJobs();
};
window.testContainer = async (p) => {
  const r = await api('/api/container/test', { path: p });
  toast(r.ok ? '✓ ' + r.message : '✗ ' + (r.message || 'failed'));
};
window.mountDisc = async (p) => {
  const r = await api('/api/disc/mount', { path: p });
  if (r.error) return toast('Mount failed: ' + r.error);
  toast(`Mounted as ${r.drive}: (${r.label || 'disc'})`);
  renderDiscs();
};

// ---------- discs view ----------
async function renderDiscs() {
  if (!DISC_OK) {
    view.innerHTML = `
      <h1>Discs</h1><div class="sub">Browse and extract ISO images.</div>
      ${guideBlock('discs')}
      <div class="notice"><b>Mounting and building ISOs are Windows-only.</b> ${esc(HEALTH.disc.reason || '')}
        You can still open any disc image here to browse it and extract its files with 7-Zip.</div>
      <div class="section-title">Open an image</div>
      <button class="btn" onclick="pickThen(p=>openContainer(p))">Choose .iso / .img …</button>`;
    return;
  }
  const mySeq = viewSeq;
  const m = await api('/api/disc/mounted');
  if (mySeq !== viewSeq) return;
  view.innerHTML = `
    <h1>Discs</h1><div class="sub">Mount, browse, and build ISO images.</div>
    ${guideBlock('discs')}
    <div class="section-title">Mounted now</div>
    ${m.length ? `<table><thead><tr><th>Drive</th><th>Label</th><th class="sz">Size</th><th>Actions</th></tr></thead><tbody>
      ${m.filter(v => /^[A-Za-z]$/.test(v.drive)).map(v => `<tr><td><b>${v.drive}:</b></td><td>${esc(v.label)}</td><td class="sz">${fmt(v.size)}</td>
      <td class="row">
        <button class="btn" onclick="startInstall('${v.drive}')">▶ Start install</button>
        <button class="btn ghost" onclick="openDrive('${v.drive}')">Open in Explorer</button>
        ${v.path ? `<button class="btn ghost" onclick="unmountDrive('${v.drive}')">Eject</button>` : ''}
      </td></tr>`).join('')}</tbody></table>
      <p class="muted" style="margin-top:8px">▶ Start install runs the disc's setup or autorun, from the Forge app window.</p>`
      : '<div class="muted">Nothing mounted. Mount an image below to install or browse it.</div>'}
    <div class="section-title">Open an image</div>
    <button class="btn" onclick="pickThen(p=>openContainer(p))">Choose .iso / .img …</button>
    <div class="section-title">Make ISO from a folder</div>
    <div class="field"><label>Source folder</label>
      <div class="row"><input id="mkFolder" placeholder="path/to/folder" style="max-width:420px">
      <button class="btn ghost" onclick="pickThen(p=>{document.getElementById('mkFolder').value=p},true)">Browse…</button></div></div>
    <div class="field"><label>Volume label</label><input id="mkLabel" placeholder="MY_DISC"></div>
    <button class="btn" onclick="makeIso()">Build ISO</button>`;
}
window.makeIso = async () => {
  const folder = $('#mkFolder').value.trim(), label = $('#mkLabel').value.trim();
  if (!folder) return toast('Pick a source folder');
  const r = await api('/api/disc/make', { folder, label });
  if (r.error) return toast(r.error);
  toast('Building ISO… (see Jobs)'); openJobs();
};

// ---------- media ----------
function renderMedia() {
  const groups = {};
  TOOLS.forEach(t => (groups[t.group] = groups[t.group] || []).push(t));
  view.innerHTML = `<h1>Media</h1><div class="sub">Local ffmpeg tools. No upload, no caps, no ads.</div>
    ${engineOk('ffmpeg') ? '' : missingBanner('ffmpeg')}
    ${guideBlock('media')}
    <div class="cards">${Object.entries(groups).map(([g, ts]) => `<div class="card"><h3>${esc(g)}</h3>
      ${ts.map(t => `<button class="tool" onclick="openMediaTool('${t.id}')">${esc(t.label)}</button>`).join('')}</div>`).join('')}</div>`;
}
async function openMediaTool(id, inputPath) {
  const t = TOOLS.find(x => x.id === id);
  if (!t) return;
  const opts = (t.options || []).map(o => {
    if (o.type === 'select') return `<div class="field"><label>${esc(o.label)}</label><select data-k="${o.key}">${o.options.map(v => `<option ${v === o.default ? 'selected' : ''}>${v}</option>`).join('')}</select></div>`;
    return `<div class="field"><label>${esc(o.label)}</label><input data-k="${o.key}" value="${esc(o.default)}" type="${o.type === 'number' ? 'number' : 'text'}"></div>`;
  }).join('');
  view.innerHTML = `<div class="toolpage">
    <h1>${esc(t.label)}</h1><div class="sub">Accepts: ${t.accepts.join(', ')}</div>
    ${guideBlock('tool')}
    <div class="pathbar"><b id="inPath">${inputPath ? esc(inputPath) : '<span class="muted">no file chosen</span>'}</b>
      <button class="btn ghost" onclick="pickThen(p=>{window._in=p;document.getElementById('inPath').textContent=p})">Choose file</button></div>
    ${opts}
    <button class="btn" id="runBtn" onclick="runMedia('${id}')">Run</button>
    <div id="mout"></div></div>`;
  window._in = inputPath || null;
}
window.openMediaTool = openMediaTool;
window.runMedia = async (id) => {
  if (!window._in) return toast('Choose a file first');
  const opts = {};
  document.querySelectorAll('#view [data-k]').forEach(el => opts[el.dataset.k] = el.value);
  const btn = $('#runBtn'); btn.disabled = true; btn.textContent = 'Running…';
  $('#mout').innerHTML = `<div class="prog"><i id="pbar"></i></div>`;
  const r = await api('/api/media/run', { toolId: id, path: window._in, options: opts });
  btn.disabled = false; btn.textContent = 'Run';
  if (r.error) { $('#mout').innerHTML = `<div class="result">✗ ${esc(r.error)}</div>`; return; }
  const dl = '/api/download?path=' + encodeURIComponent(r.out);
  const ext = (r.out.split('.').pop() || '').toLowerCase();
  let preview = '';
  if (['gif', 'png', 'jpg', 'jpeg', 'webp', 'bmp'].includes(ext)) preview = `<img src="${dl}">`;
  else if (['mp4', 'webm', 'mov'].includes(ext)) preview = `<video src="${dl}" controls></video>`;
  else if (['mp3', 'wav', 'm4a', 'ogg', 'flac'].includes(ext)) preview = `<audio src="${dl}" controls></audio>`;
  const outFwd = r.out.replace(/\\/g, '/');
  $('#mout').innerHTML = `<div class="result" data-ctx="result" data-out="${esc(outFwd)}"><div class="row" style="justify-content:space-between">
    <b>${esc(r.out.split(/[\\/]/).pop())}</b>
    <span class="row" style="gap:8px"><a class="btn" href="${dl}">Save</a>
    ${window.forge ? `<button class="btn ghost" data-p="${esc(outFwd)}" onclick="window.forge.reveal(this.dataset.p)">Show in folder</button>` : ''}</span></div>
    <div style="margin-top:12px">${preview}</div></div>`;
  setStatus('Done: ' + r.out.split(/[\\/]/).pop());
};

// ---------- archives ----------
let archiveInputs = [];
function renderArchives() {
  view.innerHTML = `<h1>Archives</h1><div class="sub">Create zip / 7z with compression, password, and split volumes.</div>
    ${engineOk('sevenzip') ? '' : missingBanner('sevenzip')}
    ${guideBlock('archives')}
    <div class="section-title">Open an archive</div>
    <button class="btn ghost" onclick="pickThen(p=>openContainer(p))">Open .zip / .7z / .rar …</button>
    <div class="section-title">New archive</div>
    <div class="field"><label>Files to include</label>
      <div id="archFiles" class="muted">none</div>
      <button class="btn ghost" style="margin-top:8px" onclick="pickThen(p=>addArchiveInput(p))">Add file/folder…</button></div>
    <div class="row">
      <div class="field"><label>Format</label><select id="afmt"><option>7z</option><option>zip</option><option>tar</option></select></div>
      <div class="field"><label>Compression</label><select id="alvl"><option value="1">Fast</option><option value="5" selected>Balanced</option><option value="9">Max</option></select></div>
    </div>
    <div class="field"><label>Password (optional, AES-256)</label><input id="apw" type="text" placeholder="leave blank for none"></div>
    <div class="field"><label>Output archive path</label><input id="aout" placeholder="${esc(HEALTH.outdir)}/archive.7z" value="${esc(HEALTH.outdir)}/archive.7z"></div>
    <button class="btn" onclick="createArchive()">Create archive</button>`;
  renderArchInputs();
}
window.addArchiveInput = p => { archiveInputs.push(p); renderArchInputs(); };
function renderArchInputs() { const el = $('#archFiles'); if (el) el.innerHTML = archiveInputs.length ? archiveInputs.map(esc).join('<br>') : 'none'; }
window.createArchive = async () => {
  if (!archiveInputs.length) return toast('Add at least one file');
  const out = $('#aout').value.trim();
  await api('/api/archive/create', {
    inputs: archiveInputs, out, format: $('#afmt').value,
    level: Number($('#alvl').value), password: $('#apw').value.trim() || undefined
  });
  toast('Creating archive… (see Jobs)'); openJobs();
};

// ---------- jobs ----------
function renderJobs() { view.innerHTML = `<h1>Jobs</h1><div class="sub">Live queue and history.</div>${guideBlock('jobs')}<div id="jobsMain"></div>`; paintJobs('#jobsMain'); }
function paintJobs(sel) {
  const el = document.querySelector(sel) || $('#jobsList');
  const arr = [...jobsMap.values()].sort((a, b) => b.at - a.at);
  el.innerHTML = arr.length ? arr.map(j => `<div class="job" data-ctx="job" data-id="${esc(j.id)}">
    <div class="t"><b>${esc(j.label)}</b><span class="st ${j.status}">${j.status}</span></div>
    ${j.status === 'running' ? `<div class="prog"><i style="width:${j.progress}%"></i></div>` : ''}
    ${j.out ? `<a href="/api/download?path=${encodeURIComponent(j.out)}">↓ ${esc(String(j.out).split(/[\\/]/).pop())}</a>` : ''}
    ${j.error ? `<div class="muted" style="color:var(--err)">${esc(j.error)}</div>` : ''}
  </div>`).join('') : '<div class="muted">No jobs yet.</div>';
}
function openJobs() { $('#jobsTray').classList.add('open'); }
const es = new EventSource('/api/jobs/stream');
es.onmessage = e => {
  const m = JSON.parse(e.data);
  if (m.type === 'job') { jobsMap.set(m.job.id, m.job); paintJobs('#jobsList'); if (document.querySelector('#jobsMain')) paintJobs('#jobsMain'); if (window.onForgeJob) window.onForgeJob(m.job); }
  const running = [...jobsMap.values()].filter(j => j.status === 'running').length;
  const b = $('#jobBadge'); b.textContent = running || ''; b.classList.toggle('show', !!running);
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
function nativeFilePick(cb) {
  let inp = document.getElementById('_nativePick');
  if (!inp) { inp = document.createElement('input'); inp.type = 'file'; inp.id = '_nativePick'; inp.style.display = 'none'; document.body.appendChild(inp); }
  inp.value = '';
  inp.onchange = async () => {
    const f = inp.files[0]; if (!f) return;
    toast('Uploading ' + f.name + ' …');
    const r = await fetch('/api/upload?filename=' + encodeURIComponent(f.name), { method: 'POST', body: f });
    const j = await r.json();
    if (j.path) cb(j.path); else toast('Upload failed');
  };
  inp.click();
}
function makeIsoFromFolder(folder) {
  setView('discs');
  setTimeout(() => { const f = document.getElementById('mkFolder'); if (f) { f.value = folder; f.scrollIntoView(); } toast('Folder set. Add a label, then Build ISO'); }, 60);
}
async function openPicker(dir, cb, dirsOnly) {
  const d = await api('/api/fs?dir=' + encodeURIComponent(dir));
  if (d.error) { toast(d.error); return; }
  const rows = [
    d.parent ? `<div class="fsrow d" data-dir="${esc(d.parent)}">.. up</div>`
      : (d.roots || []).filter(r => r !== d.cwd).map(r => `<div class="fsrow d" data-dir="${esc(r)}">⌂ ${esc(r)}</div>`).join(''),
    dirsOnly ? `<div class="fsrow" data-pick="${esc(d.cwd)}"><b>Use this folder</b></div>` : '',
    ...d.entries.map(e => e.dir
      ? `<div class="fsrow d" data-dir="${esc(e.path)}">▸ ${esc(e.name)}</div>`
      : (dirsOnly ? '' : `<div class="fsrow" data-pick="${esc(e.path)}">${esc(e.name)}</div>`))
  ].join('');
  openModal(`<h3 style="margin-bottom:4px">${dirsOnly ? 'Pick a folder' : 'Pick a file'}</h3>
    <div class="pathbar"><b>${esc(d.cwd)}</b></div><div class="fslist">${rows}</div>
    <button class="btn ghost" onclick="closeModal()">Cancel</button>`);
  document.querySelectorAll('.fsrow').forEach(r => r.onclick = () => {
    if (r.dataset.dir) openPicker(r.dataset.dir, cb, dirsOnly);
    else { closeModal(); cb(r.dataset.pick); }
  });
}

// ---------- modal / toast / drop ----------
function openModal(html) { $('#modalBox').innerHTML = html; $('#modal').classList.remove('hidden'); }
function closeModal() { $('#modal').classList.add('hidden'); }
$('#modal').onclick = e => { if (e.target.id === 'modal') closeModal(); };
window.closeModal = closeModal;
let toastT;
function toast(msg) {
  let t = $('#toast'); if (!t) { t = document.createElement('div'); t.id = 'toast'; t.style.cssText = 'position:fixed;bottom:20px;left:50%;transform:translateX(-50%);background:var(--bg3);color:var(--tx);border:1px solid var(--line);padding:11px 18px;border-radius:12px;z-index:99;font-size:13px;box-shadow:0 12px 30px -10px rgba(0,0,0,.6)'; document.body.appendChild(t); }
  t.textContent = msg; t.style.opacity = 1; clearTimeout(toastT); toastT = setTimeout(() => t.style.opacity = 0, 2800);
}
window.openInExplorer = p => { if (window.forge) window.forge.openDrive(String(p).replace(/[:/\\]+$/, '') + ':'); else toast('Drive ' + p + ' is mounted'); };
window.openDrive = d => { if (window.forge) window.forge.openDrive(d + ':'); else toast('Drive ' + d + ': is mounted. Open it in Explorer'); };
window.startInstall = async d => {
  if (!window.forge) { toast('Start install runs in the Forge app window (npm run app)'); return; }
  setStatus('Launching installer on ' + d + ':…');
  const r = await window.forge.runInstaller(d);
  if (r.launched) { toast('▶ Launched ' + r.target); setStatus('Launched ' + r.target + ' from ' + d + ':'); }
  else if (r.opened) { toast('No installer found, opened ' + d + ':'); setStatus('No installer on ' + d + ':, opened the drive'); }
  else { toast('Could not launch: ' + (r.error || 'unknown')); }
};
window.unmountDrive = async d => {
  const r = await api('/api/disc/unmount-drive', { drive: d });
  if (r && r.error) return toast(r.error);
  toast('Ejected ' + d + ':'); renderDiscs();
};

// whole-window drag & drop -> upload -> route
const hint = $('#drophint');
window.addEventListener('dragover', e => { e.preventDefault(); hint.classList.add('show'); });
window.addEventListener('dragleave', e => { if (e.clientX === 0 && e.clientY === 0) hint.classList.remove('show'); });
window.addEventListener('drop', async e => {
  e.preventDefault(); hint.classList.remove('show');
  const f = e.dataTransfer.files[0]; if (!f) return;
  toast('Uploading ' + f.name + ' …');
  const r = await fetch('/api/upload?filename=' + encodeURIComponent(f.name), { method: 'POST', body: f });
  const j = await r.json();
  if (j.path) routeFile(j.path); else toast('Upload failed');
});

// ---------- engines ----------
function engineOk(id) { const e = HEALTH.engines.find(x => x.id === id); return !!(e && e.present); }
function missingBanner(only) {
  const miss = HEALTH.engines.filter(e => !e.present && e.id !== 'ffprobe' && (!only || e.id === only));
  if (!miss.length) return '';
  return `<div class="notice warn"><b>${miss.map(e => esc(e.label)).join(' and ')} not found.</b>
    ${miss.map(e => esc(e.powers)).join('; ')} will not work until ${miss.length > 1 ? 'they are' : 'it is'} installed.
    <a href="#" onclick="showEngines();return false">How to install</a></div>`;
}
function showEngines() {
  const rows = HEALTH.engines.map(e => `<tr>
    <td><b>${esc(e.label)}</b><div class="muted" style="font-size:12px">${esc(e.powers)}</div></td>
    <td>${e.present ? `<span class="pill ok">found</span> <span class="muted" style="font-size:11px">${esc(e.via || '')}</span>`
      : `<span class="pill bad">missing</span>${e.note ? `<div class="muted" style="font-size:12px">${esc(e.note)}</div>` : ''}`}</td>
    <td>${e.present ? '' : `<code>${esc(e.install)}</code>`}</td></tr>`).join('');
  openModal(`<h3 style="margin-bottom:4px">Engines</h3>
    <div class="muted" style="margin-bottom:12px">Forge ships no binaries. It uses the tools already on this machine, found on your PATH or set in <code>config.json</code> (<code>engines.ffmpeg</code>, <code>engines.ffprobe</code>, <code>engines.sevenzip</code>) or the <code>FORGE_FFMPEG</code> / <code>FORGE_FFPROBE</code> / <code>FORGE_7Z</code> environment variables. Restart Forge after installing.</div>
    <table><thead><tr><th>Engine</th><th>Status</th><th>Install</th></tr></thead><tbody>${rows}
    <tr><td><b>Disc tools</b><div class="muted" style="font-size:12px">Mount, eject, build ISO</div></td>
      <td>${DISC_OK ? '<span class="pill ok">available</span>' : '<span class="pill">off</span>'}</td>
      <td class="muted" style="font-size:12px">${DISC_OK ? 'Built into Windows' : esc(HEALTH.disc.reason || '')}</td></tr></tbody></table>
    <div class="muted" style="margin:12px 0">Output folder: <code>${esc(HEALTH.outdir)}</code></div>
    <button class="btn ghost" onclick="closeModal()">Close</button>`);
}
window.showEngines = showEngines;

// ---------- boot ----------
(async () => {
  HEALTH = await api('/api/health');
  DISC_OK = !!(HEALTH.disc && HEALTH.disc.available);
  document.body.classList.toggle('no-disc', !DISC_OK);
  const chips = HEALTH.engines.filter(e => e.id !== 'ffprobe').map(e =>
    `<span class="${e.present ? 'on' : 'off'}">${e.present ? '●' : '○'} ${esc(e.label)}</span>`);
  chips.push(`<span class="${DISC_OK ? 'on' : 'na'}">${DISC_OK ? '●' : '○'} discs</span>`);
  $('#engines').innerHTML = chips.join('');
  $('#engines').onclick = showEngines;
  TOOLS = await api('/api/tools');
  setView('home');
})();
$('#lockBtn').onclick = async () => { try { await fetch('/api/logout', { method: 'POST' }); } catch {} location.href = '/gate.html'; };
document.addEventListener('keydown', e => { if ((e.ctrlKey || e.metaKey) && e.key === 'k') { e.preventDefault(); $('#search').focus(); } });

// ---------- context-menu providers (shared UI) ----------
window.extractOne = async (container, entryPath) => {
  await api('/api/container/extract', { path: container, selection: [entryPath] });
  toast('Extracting ' + entryPath.split(/[\\/]/).pop() + '… (see Jobs)'); openJobs();
};
window.sendToEditor = async (out) => {
  setView('edit');
  setTimeout(() => { if (window.forgeEditorImport) window.forgeEditorImport(out); else toast('Opened editor. Add it from Import'); }, 300);
};
if (window.CTX) {
  const forgeOK = () => !!(window.forge && window.forge.reveal);
  CTX.register('entry', (el) => {
    const container = el.dataset.container, path = el.dataset.path, isDir = el.dataset.dir === '1';
    const items = [];
    if (!isDir) items.push({ label: '⬇ Extract this item', run: () => extractOne(container, path) });
    items.push({ label: '⬇ Extract all', run: () => extractContainer(container) });
    items.push({ label: '⧉ Copy name', run: () => CTX.copyText(path) });
    return items;
  });
  CTX.register('job', (el) => {
    const j = jobsMap.get(el.dataset.id); if (!j) return [];
    const items = [];
    if (j.out) {
      items.push({ label: '⬇ Open result', run: () => { window.location.href = '/api/download?path=' + encodeURIComponent(j.out); } });
      if (forgeOK()) items.push({ label: '📂 Show in folder', run: () => window.forge.reveal(j.out) });
      items.push({ label: '⧉ Copy output path', run: () => CTX.copyText(j.out) });
    }
    if (j.error) items.push({ label: '⧉ Copy error', run: () => CTX.copyText(j.error) });
    items.push({ sep: true });
    items.push({ label: '✕ Remove from list', run: () => { jobsMap.delete(el.dataset.id); paintJobs('#jobsList'); if (document.querySelector('#jobsMain')) paintJobs('#jobsMain'); } });
    return items;
  });
  CTX.register('result', (el) => {
    const out = el.dataset.out; if (!out) return [];
    const items = [
      { label: '↪ Open in another tool…', run: () => routeFile(out) },
      { label: '🎬 Send to Video Editor', run: () => sendToEditor(out) }
    ];
    if (forgeOK()) items.push({ label: '📂 Show in folder', run: () => window.forge.reveal(out) });
    items.push({ label: '⧉ Copy output path', run: () => CTX.copyText(out) });
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
