// Forge Video Editor: a clean-room, free timeline editor in the familiar
// three-zone layout (left tab rail: Import / Filters /
// Transitions / Titles / Stickers / Pan&Zoom / Adjust) + preview player +
// full-width multi-track timeline. Our own CSS/icons; export never watermarks.
(function () {
  const A = (p, b) => window.fetch(p, b ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b) } : {}).then(r => { if (r.status === 401) location.href = '/gate.html'; return r.json(); });
  const E = s => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const mediaUrl = p => '/api/editor/media?path=' + encodeURIComponent(p);
  const thumbUrl = (p, t) => '/api/editor/thumb?path=' + encodeURIComponent(p) + '&t=' + (t || 0);
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const tc = s => { s = Math.max(0, s || 0); const h = Math.floor(s / 3600), m = Math.floor(s % 3600 / 60), ss = Math.floor(s % 60), f = Math.floor((s % 1) * (P ? P.canvas.fps : 30)); return (h ? String(h).padStart(2, '0') + ':' : '') + String(m).padStart(2, '0') + ':' + String(ss).padStart(2, '0') + '.' + String(f).padStart(2, '0'); };

  // ---- state ----
  let P = null;               // project
  let bin = [];               // imported media {src,name,type,duration,width,height,fps,hasAudio}
  let sel = null;             // {track:'video'|'overlay'|'audio', i:index}
  let tab = 'import';
  let pps = 48;               // pixels per second (zoom)
  let head = 0;               // playhead seconds
  let saveT = null;

  const TRACK = k => (P.tracks.find(t => t.kind === k) || { clips: [] });
  const clipDur = c => {
    if (c.kind === 'text' || c.kind === 'sticker' || c.kind === 'music') return Math.max(0.1, +c.duration || 3);
    if (c.type === 'image') return Math.max(0.1, +c.duration || 3);
    const ti = +c.trimIn || 0, to = (c.trimOut != null ? +c.trimOut : ti + (+c.duration || 3));
    return Math.max(0.1, to - ti);
  };
  // absolute start time on the base video track (sequential)
  const baseStart = i => TRACK('video').clips.slice(0, i).reduce((a, c) => {
    const d = clipDur(c); const tr = TRACK('video').clips[TRACK('video').clips.indexOf(c) + 1];
    return a + d;
  }, 0);
  function baseStarts() { // returns array of {start,dur} accounting for transition overlaps
    const cl = TRACK('video').clips; const out = []; let t = 0;
    cl.forEach((c, i) => {
      const d = clipDur(c);
      const tr = c.transitionIn;
      if (i > 0 && tr && tr.type && tr.type !== 'none' && +tr.duration > 0) t -= Math.min(+tr.duration, d - 0.05, out[i - 1].dur - 0.05);
      out.push({ start: t, dur: d }); t += d;
    });
    return out;
  }
  const totalDur = () => { const b = baseStarts(); return b.length ? b[b.length - 1].start + b[b.length - 1].dur : 0; };

  function save() { clearTimeout(saveT); saveT = setTimeout(() => A('/api/editor/save', { project: P }), 400); }

  // ---- boot ----
  async function renderEditor() {
    const view = document.getElementById('view');
    view.className = 'view editor';
    const projects = await A('/api/editor/projects');
    if (!P) {
      if (projects.length) P = await A('/api/editor/project?id=' + projects[0].id);
      else P = await A('/api/editor/new', { name: 'My Movie' });
    }
    rebuildBin();
    layout();
  }
  window.renderEditor = renderEditor;

  function rebuildBin() {
    // seed bin from clips already in project so reopening keeps media
    const seen = new Set(bin.map(b => b.src));
    ['video', 'overlay', 'audio'].forEach(k => TRACK(k).clips.forEach(c => {
      if (c.src && !seen.has(c.src)) { seen.add(c.src); bin.push({ src: c.src, name: c.name || c.src.split('/').pop(), type: c.type || (k === 'audio' ? 'audio' : 'video'), duration: c.duration, hasAudio: c.hasAudio }); }
    }));
  }

  // ---- layout ----
  function layout() {
    const view = document.getElementById('view');
    view.innerHTML = `
    <div class="ved">
      <div class="ved-top">
        <div class="ved-tabs">
          ${tabBtn('import', '📥', 'Import')}
          ${tabBtn('filters', '🎨', 'Filters')}
          ${tabBtn('transitions', '⇄', 'Transitions')}
          ${tabBtn('titles', 'T', 'Titles')}
          ${tabBtn('stickers', '★', 'Stickers')}
          ${tabBtn('panzoom', '🔍', 'Pan & Zoom')}
          ${tabBtn('adjust', '⚙', 'Adjust')}
        </div>
        <div class="ved-panel" id="vedPanel"></div>
        <div class="ved-preview">
          <div class="ved-projbar">
            <input id="vedName" class="ved-nameinput" value="${E(P.name)}" title="Project name">
            <span class="ved-canvas" id="vedCanvas">${P.canvas.width}×${P.canvas.height} · ${P.canvas.fps}fps</span>
            <span class="ved-spring"></span>
            <button class="ved-btn ghost" id="vedNew" title="New project">＋ New</button>
            <button class="ved-btn ghost" id="vedOpen" title="Open project">Projects</button>
            <button class="ved-export" id="vedExport">Export ▸</button>
          </div>
          <div class="ved-stage" id="vedStage">
            <div class="ved-screen" id="vedScreen">
              <div class="ved-framebox" id="vedFrameBox">
                <div id="vedPool" aria-hidden="true"></div>
                <canvas id="vedComposite"></canvas>
              </div>
              <div class="ved-noframe" id="vedNoframe">Add clips to the Video track</div>
              <div class="ved-loading" id="vedLoading" hidden>
                <div class="ved-spin"></div>
                <div class="ved-tip"><b id="vedTipHead"></b><span id="vedTipBody"></span></div>
              </div>
            </div>
          </div>
          <div class="ved-transport">
            <button class="ved-tb" id="tpStart" title="Start">⏮</button>
            <button class="ved-tb" id="tpPlay" title="Play/Pause">▶</button>
            <button class="ved-tb" id="tpEnd" title="End">⏭</button>
            <span class="ved-tcode" id="vedTcode">00:00.00</span>
            <span class="ved-spring"></span>
            <span class="ved-tcode dim" id="vedTtotal">00:00.00</span>
          </div>
        </div>
      </div>
      <div class="ved-timeline">
        <div class="ved-tltop">
          <div class="ved-tlbar">
            <button class="ved-tb" id="tlAdd" title="Add media">＋ Media</button>
            <button class="ved-tb" id="tlSplit" title="Split at playhead (S)">✂ Split</button>
            <button class="ved-tb" id="tlDup" title="Duplicate">⧉ Copy</button>
            <button class="ved-tb danger" id="tlDel" title="Delete (Del)">🗑 Delete</button>
            <span class="ved-sep"></span>
            <button class="ved-tb" id="tlTitle" title="Add title">T Title</button>
            <button class="ved-tb" id="tlAudio" title="Add music/audio">♪ Audio</button>
            <span class="ved-spring"></span>
            <span class="ved-selinfo" id="vedSelInfo"></span>
            <span class="ved-sep"></span>
            <button class="ved-tb" id="zOut" title="Zoom out">－</button>
            <input type="range" id="zSlide" min="12" max="200" value="${pps}" class="ved-zoom">
            <button class="ved-tb" id="zIn" title="Zoom in">＋</button>
          </div>
        </div>
        <div class="ved-tracks" id="vedTracks"></div>
      </div>
    </div>`;

    panel();
    timeline();
    wire();
    seekPreview(head);
    updateTimes();
  }
  const tabBtn = (id, ic, lb) => `<button class="ved-tab ${tab === id ? 'on' : ''}" data-tab="${id}"><i>${ic}</i><span>${lb}</span></button>`;

  function wire() {
    const $ = s => document.getElementById(s);
    document.querySelectorAll('.ved-tab').forEach(b => b.onclick = () => { tab = b.dataset.tab; document.querySelectorAll('.ved-tab').forEach(x => x.classList.toggle('on', x.dataset.tab === tab)); panel(); });
    $('vedName').onchange = e => { P.name = e.target.value.trim() || 'Untitled'; save(); };
    $('vedNew').onclick = newProject;
    $('vedOpen').onclick = openProjects;
    $('vedExport').onclick = exportDialog;
    $('vedCanvas').onclick = canvasDialog;
    $('tlAdd').onclick = () => addMedia();
    $('tlTitle').onclick = () => { tab = 'titles'; layout(); addTitle('simple'); };
    $('tlAudio').onclick = () => addMedia('audio');
    $('tlSplit').onclick = splitAtHead;
    $('tlDup').onclick = duplicateSel;
    $('tlDel').onclick = deleteSel;
    $('zIn').onclick = () => setZoom(pps * 1.4);
    $('zOut').onclick = () => setZoom(pps / 1.4);
    $('zSlide').oninput = e => setZoom(+e.target.value);
    $('tpPlay').onclick = togglePlay;
    $('tpStart').onclick = () => { seekPreview(0); };
    $('tpEnd').onclick = () => { seekPreview(totalDur() - 0.05); };
  }

  function setZoom(v) { pps = clamp(v, 12, 200); const z = document.getElementById('zSlide'); if (z) z.value = pps; timeline(); }

  // ---------- left panel (tab content) ----------
  function panel() {
    const el = document.getElementById('vedPanel');
    if (!el) return;
    if (tab === 'import') return panelImport(el);
    if (tab === 'filters') return panelFilters(el);
    if (tab === 'transitions') return panelTransitions(el);
    if (tab === 'titles') return panelTitles(el);
    if (tab === 'stickers') return panelStickers(el);
    if (tab === 'panzoom') return panelPanzoom(el);
    if (tab === 'adjust') return panelAdjust(el);
  }

  function panelHead(title, hint) { return `<div class="ved-ph"><h3>${title}</h3>${hint ? `<p>${hint}</p>` : ''}</div>`; }

  function panelImport(el) {
    el.innerHTML = panelHead('Import', 'Add clips, photos, and music. Click a thumbnail to drop it on the timeline.') +
      `<div class="ved-imp"><button class="ved-big" id="impBtn">＋ Add files</button></div>
       <div class="ved-bin" id="vedBin"></div>`;
    document.getElementById('impBtn').onclick = () => addMedia();
    paintBin();
  }
  function paintBin() {
    const el = document.getElementById('vedBin'); if (!el) return;
    if (!bin.length) { el.innerHTML = `<div class="ved-empty">No media yet.<br>Add a video, photo, or song.</div>`; return; }
    el.innerHTML = bin.map((b, i) => `<div class="ved-binitem" data-ctx="binitem" data-i="${i}" title="${E(b.name)}">
      <div class="ved-thumb">${b.type === 'audio' ? '<div class="ved-audioic">♪</div>' : `<img src="${thumbUrl(b.src, (b.duration || 2) / 3)}" loading="lazy">`}</div>
      <div class="ved-binname">${E(b.name)}</div>
      <div class="ved-bindur">${b.type === 'audio' ? '♪ ' : ''}${(b.duration || 0).toFixed(1)}s</div>
      <button class="ved-binadd">＋ Timeline</button></div>`).join('');
    el.querySelectorAll('.ved-binitem').forEach(it => {
      const i = +it.dataset.i;
      it.querySelector('.ved-binadd').onclick = e => { e.stopPropagation(); binToTimeline(i); };
      it.onclick = () => binToTimeline(i);
    });
  }

  const FILTERS = [
    ['none', 'Original'], ['vivid', 'Vivid'], ['warm', 'Warm'], ['cool', 'Cool'],
    ['bright', 'Bright'], ['contrast', 'Punch'], ['grayscale', 'B & W'], ['sepia', 'Sepia'], ['blur', 'Soft Blur']
  ];
  function panelFilters(el) {
    const c = selClip('video');
    el.innerHTML = panelHead('Filters', c ? 'Click a look to apply it to the selected clip.' : 'Select a clip on the timeline first.') +
      `<div class="ved-grid">${FILTERS.map(([id, lb]) => `<button class="ved-cell ${c && ((c.filter && c.filter.preset) || 'none') === id ? 'on' : ''}" data-f="${id}">
        <div class="ved-cellprev f-${id}"><span>Aa</span></div><span class="ved-celllb">${lb}</span></button>`).join('')}</div>`;
    el.querySelectorAll('[data-f]').forEach(b => b.onclick = () => {
      const cl = selClip('video'); if (!cl) return toastE('Select a clip first');
      cl.filter = cl.filter || {}; cl.filter.preset = b.dataset.f === 'none' ? null : b.dataset.f;
      panelFilters(el); timeline(); save(); seekPreview(head);
    });
  }

  const TRANSITIONS = [
    ['fade', 'Fade'], ['dissolve', 'Dissolve'], ['fadeblack', 'Fade Black'], ['fadewhite', 'Fade White'],
    ['wipeleft', 'Wipe ◄'], ['wiperight', 'Wipe ►'], ['wipeup', 'Wipe ▲'], ['wipedown', 'Wipe ▼'],
    ['slideleft', 'Slide ◄'], ['slideright', 'Slide ►'], ['circleopen', 'Circle Open'], ['circleclose', 'Circle Close'],
    ['radial', 'Radial'], ['pixelize', 'Pixelize'], ['smoothleft', 'Smooth ◄'], ['smoothright', 'Smooth ►']
  ];
  function panelTransitions(el) {
    const idx = sel && sel.track === 'video' ? sel.i : -1;
    const ok = idx > 0;
    const cur = ok ? TRACK('video').clips[idx].transitionIn : null;
    el.innerHTML = panelHead('Transitions', ok ? 'Applied between the previous clip and the selected one.' : 'Select the second clip of a pair (not the first).') +
      `<div class="ved-field"><label>Duration (s)</label><input id="trDur" type="number" step="0.1" min="0.2" value="${cur ? cur.duration : 1}" style="width:80px"></div>
       <div class="ved-grid">
        <button class="ved-cell ${!cur || cur.type === 'none' ? 'on' : ''}" data-t="none"><div class="ved-cellprev tr-none">✕</div><span class="ved-celllb">None</span></button>
        ${TRANSITIONS.map(([id, lb]) => `<button class="ved-cell ${cur && cur.type === id ? 'on' : ''}" data-t="${id}"><div class="ved-cellprev tr"><span>${lb.replace(/[A-Za-z ]/g, '') || '⇄'}</span></div><span class="ved-celllb">${lb}</span></button>`).join('')}
      </div>`;
    el.querySelectorAll('[data-t]').forEach(b => b.onclick = () => {
      if (!ok) return toastE('Select the 2nd clip of a pair');
      const cl = TRACK('video').clips[idx];
      const d = +document.getElementById('trDur').value || 1;
      cl.transitionIn = b.dataset.t === 'none' ? null : { type: b.dataset.t, duration: d };
      panelTransitions(el); timeline(); save();
    });
  }

  const TITLES = [
    ['simple', 'Simple', { size: 72, y: 'center', box: false }],
    ['lower', 'Lower Third', { size: 54, y: 'bottom', box: true }],
    ['bold', 'Big Bold', { size: 120, y: 'center', box: false }],
    ['caption', 'Caption Box', { size: 48, y: 'bottom', box: true, boxcolor: 'black@0.65' }]
  ];
  function panelTitles(el) {
    el.innerHTML = panelHead('Titles', 'Click a style to add text at the playhead. Double-click a title on the timeline to edit.') +
      `<div class="ved-grid tall">${TITLES.map(([id, lb, p]) => `<button class="ved-cell wide" data-tt="${id}">
        <div class="ved-cellprev title ${p.y}"><span style="font-size:${Math.max(14, p.size / 5)}px">${lb}</span></div>
        <span class="ved-celllb">${lb}</span></button>`).join('')}</div>`;
    el.querySelectorAll('[data-tt]').forEach(b => b.onclick = () => addTitle(b.dataset.tt));
  }

  function panelStickers(el) {
    el.innerHTML = panelHead('Stickers', 'Drop your own image as an overlay (logo, PNG, badge). Positioned and timed on the timeline.') +
      `<button class="ved-big" id="stkBtn">＋ Add image sticker</button>
       <div class="ved-note">Clean-room build: bring your own art. No bundled packs to pay for.</div>`;
    document.getElementById('stkBtn').onclick = addSticker;
  }

  function panelPanzoom(el) {
    const c = selClip('video');
    const isImg = c && c.type === 'image';
    const pz = c && c.panzoom || {};
    el.innerHTML = panelHead('Pan & Zoom', isImg ? 'Ken Burns motion for the selected photo.' : 'Select a photo clip on the timeline.') +
      (isImg ? `<div class="ved-grid">
        <button class="ved-cell ${!pz.enabled ? 'on' : ''}" data-pz="off"><div class="ved-cellprev">Static</div><span class="ved-celllb">None</span></button>
        <button class="ved-cell ${pz.enabled && pz.to !== 'out' ? 'on' : ''}" data-pz="in"><div class="ved-cellprev">⤢</div><span class="ved-celllb">Zoom In</span></button>
        <button class="ved-cell ${pz.enabled && pz.to === 'out' ? 'on' : ''}" data-pz="out"><div class="ved-cellprev">⤡</div><span class="ved-celllb">Zoom Out</span></button>
      </div>` : `<div class="ved-empty">Pan &amp; Zoom applies to photos.</div>`);
    el.querySelectorAll('[data-pz]').forEach(b => b.onclick = () => {
      const cl = selClip('video'); if (!cl || cl.type !== 'image') return;
      cl.panzoom = b.dataset.pz === 'off' ? null : { enabled: true, to: b.dataset.pz };
      panelPanzoom(el); save();
    });
  }

  function panelAdjust(el) {
    const c = selClip('video') || selClip('audio');
    if (!c) { el.innerHTML = panelHead('Adjust', 'Select a clip to tune color and audio.'); return; }
    const f = c.filter || {}; const isV = sel.track === 'video';
    el.innerHTML = panelHead('Adjust', `Fine-tune the selected ${isV ? 'clip' : 'audio'}.`) +
      (isV ? `<div class="ved-sliders">
        ${slider('Brightness', 'brightness', f.brightness ?? 0, -0.5, 0.5, 0.01)}
        ${slider('Contrast', 'contrast', f.contrast ?? 1, 0.3, 2, 0.01)}
        ${slider('Saturation', 'saturation', f.saturation ?? 1, 0, 3, 0.01)}
        ${slider('Gamma', 'gamma', f.gamma ?? 1, 0.3, 2, 0.01)}
      </div>` : '') +
      `<div class="ved-ph"><h3 style="margin-top:14px">Audio</h3></div>
       <div class="ved-sliders">
        ${slider('Volume', 'volume', c.volume ?? 1, 0, 3, 0.01)}
        ${slider('Fade in (s)', 'fadeIn', c.fadeIn ?? 0, 0, 5, 0.1)}
        ${slider('Fade out (s)', 'fadeOut', c.fadeOut ?? 0, 0, 5, 0.1)}
       </div>`;
    el.querySelectorAll('input[data-adj]').forEach(inp => inp.oninput = () => {
      const k = inp.dataset.adj, v = +inp.value;
      inp.nextElementSibling.textContent = v;
      if (['volume', 'fadeIn', 'fadeOut'].includes(k)) c[k] = v;
      else { c.filter = c.filter || {}; c.filter[k] = v; }
      save(); if (isV) timeline();
    });
  }
  const slider = (lb, k, v, mn, mx, st) => `<div class="ved-slider"><label>${lb}</label>
    <input type="range" data-adj="${k}" min="${mn}" max="${mx}" step="${st}" value="${v}"><b>${v}</b></div>`;

  function selClip(track) { return sel && sel.track === track ? TRACK(track).clips[sel.i] : null; }

  // ---------- media add ----------
  async function addMedia(forceKind) {
    window.pickThen(async (path) => {
      const info = await A('/api/editor/probe?path=' + encodeURIComponent(path));
      if (info.error) return toastE(info.error);
      if (!bin.find(b => b.src === info.src)) bin.push(info);
      if (tab === 'import') paintBin();
      const kind = forceKind || (info.type === 'audio' ? 'audio' : 'video');
      addBinInfoToTrack(info, kind);
    });
  }
  function binToTimeline(i) { const b = bin[i]; addBinInfoToTrack(b, b.type === 'audio' ? 'audio' : 'video'); }

  function addBinInfoToTrack(info, kind) {
    if (kind === 'audio') {
      const start = 0;
      TRACK('audio').clips.push({ id: rid(), kind: 'music', src: info.src, name: info.name, start, trimIn: 0, duration: info.duration || 10, volume: 1 });
      sel = { track: 'audio', i: TRACK('audio').clips.length - 1 };
    } else {
      const isImg = info.type === 'image';
      TRACK('video').clips.push(isImg
        ? { id: rid(), type: 'image', src: info.src, name: info.name, duration: 4, filter: {} }
        : { id: rid(), type: 'video', src: info.src, name: info.name, hasAudio: info.hasAudio, trimIn: 0, trimOut: info.duration || 5, duration: info.duration || 5, volume: 1, filter: {} });
      sel = { track: 'video', i: TRACK('video').clips.length - 1 };
    }
    save(); timeline(); updateTimes();
  }

  function addTitle(styleId) {
    const st = (TITLES.find(t => t[0] === styleId) || TITLES[0])[2];
    const c = { id: rid(), kind: 'text', text: 'Your text here', start: Math.round(head * 10) / 10, duration: 3, size: st.size, color: '#ffffff', y: st.y, box: !!st.box, boxcolor: st.boxcolor || 'black@0.5' };
    TRACK('overlay').clips.push(c);
    sel = { track: 'overlay', i: TRACK('overlay').clips.length - 1 };
    save(); timeline(); editTitle(c);
  }
  function addSticker() {
    window.pickThen(async (path) => {
      const c = { id: rid(), kind: 'sticker', src: path.replace(/\\/g, '/'), name: path.split(/[\\/]/).pop(), start: Math.round(head * 10) / 10, duration: 3, scale: 0.25, x: 'center', y: 'center' };
      TRACK('overlay').clips.push(c);
      sel = { track: 'overlay', i: TRACK('overlay').clips.length - 1 };
      save(); timeline();
    });
  }

  // ---------- timeline ----------
  function timeline() {
    const el = document.getElementById('vedTracks'); if (!el) return;
    const dur = Math.max(totalDur(), 10);
    const width = Math.max(dur * pps + 200, el.clientWidth || 600);
    const rows = [
      trackRow('overlay', 'T', 'Titles / Stickers'),
      trackRow('video', '▷', 'Video'),
      trackRow('audio', '♪', 'Audio')
    ].join('');
    el.innerHTML = `<div class="ved-ruler" style="width:${width}px" id="vedRuler">${ruler(dur)}</div>
      <div class="ved-lanes" style="width:${width}px">${rows}
      <div class="ved-head" id="vedHead" style="left:${head * pps}px"></div></div>`;
    bindTimeline();
  }
  function ruler(dur) {
    let s = ''; const step = pps < 25 ? 5 : pps < 60 ? 2 : 1;
    for (let t = 0; t <= dur + step; t += step) s += `<span class="ved-tick" style="left:${t * pps}px">${t}s</span>`;
    return s;
  }
  function trackRow(kind, ic, lb) {
    const clips = TRACK(kind).clips;
    let inner = '';
    if (kind === 'video') {
      const bs = baseStarts();
      inner = clips.map((c, i) => {
        const d = clipDur(c), left = bs[i].start * pps, w = d * pps;
        const on = sel && sel.track === 'video' && sel.i === i;
        const tr = c.transitionIn && c.transitionIn.type && c.transitionIn.type !== 'none';
        return `<div class="ved-clip ${on ? 'on' : ''} ${c.type}" data-ctx="clip" data-k="video" data-i="${i}" style="left:${left}px;width:${w}px">
          ${tr ? `<div class="ved-trbadge" title="${c.transitionIn.type}">⇄</div>` : ''}
          <div class="ved-cliptn" style="background-image:url('${thumbUrl(c.src, (+c.trimIn || 0) + 0.1)}')"></div>
          <div class="ved-cliplbl">${E(c.name || c.type)}${c.filter && c.filter.preset ? ' · ' + c.filter.preset : ''}</div>
          <div class="ved-h l" data-h="l"></div><div class="ved-h r" data-h="r"></div></div>`;
      }).join('');
    } else {
      inner = clips.map((c, i) => {
        const d = clipDur(c), left = (+c.start || 0) * pps, w = d * pps;
        const on = sel && sel.track === kind && sel.i === i;
        const label = c.kind === 'text' ? ('“' + (c.text || '').slice(0, 18) + '”') : (c.name || c.kind);
        return `<div class="ved-clip ${on ? 'on' : ''} ${kind} ${c.kind}" data-ctx="clip" data-k="${kind}" data-i="${i}" style="left:${left}px;width:${w}px">
          <div class="ved-cliplbl">${c.kind === 'text' ? 'T ' : c.kind === 'sticker' ? '★ ' : '♪ '}${E(label)}</div>
          <div class="ved-h l" data-h="l"></div><div class="ved-h r" data-h="r"></div></div>`;
      }).join('');
    }
    return `<div class="ved-track ${kind}">
      <div class="ved-thead"><b>${ic}</b><span>${lb}</span></div>
      <div class="ved-lane" data-track="${kind}">${inner || `<div class="ved-lanehint">${kind === 'video' ? 'Add clips from Import' : kind === 'overlay' ? 'Add a Title' : 'Add music'}</div>`}</div>
    </div>`;
  }

  function bindTimeline() {
    const lanes = document.querySelectorAll('.ved-lane');
    lanes.forEach(lane => {
      lane.onclick = e => {
        if (e.target.closest('.ved-clip')) return;
        const rect = lane.getBoundingClientRect();
        seekPreview(clamp((e.clientX - rect.left) / pps, 0, totalDur()));
      };
    });
    document.querySelectorAll('.ved-clip').forEach(cl => {
      const track = cl.dataset.k, i = +cl.dataset.i;
      cl.addEventListener('pointerdown', ev => startDrag(ev, track, i, cl));
      cl.addEventListener('dblclick', () => {
        const c = TRACK(track).clips[i];
        if (c.kind === 'text') editTitle(c);
      });
    });
    // ruler scrub
    const ruler = document.getElementById('vedRuler');
    if (ruler) ruler.onpointerdown = e => {
      const move = ev => { const r = ruler.getBoundingClientRect(); seekPreview(clamp((ev.clientX - r.left) / pps, 0, totalDur())); };
      move(e); const up = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); };
      window.addEventListener('pointermove', move); window.addEventListener('pointerup', up);
    };
  }

  function startDrag(ev, track, i, elc) {
    if (ev.button !== 0) return;   // let right-click open the context menu instead of starting a drag
    ev.preventDefault();
    const handle = ev.target.dataset.h;
    selectClip(track, i);
    const clips = TRACK(track).clips, c = clips[i];
    const x0 = ev.clientX;
    const startVals = { trimIn: +c.trimIn || 0, trimOut: c.trimOut, duration: clipDur(c), start: +c.start || 0 };
    let moved = false;
    const move = ev2 => {
      const dx = ev2.clientX - x0; if (Math.abs(dx) > 3) moved = true;
      const dsec = dx / pps;
      if (handle === 'l') { // trim start
        if (c.type === 'image' || c.kind) { /* start-based: for overlay/audio move start & shorten */
          if (track !== 'video') { c.start = Math.max(0, startVals.start + dsec); c.duration = Math.max(0.2, startVals.duration - dsec); }
          else { c.duration = Math.max(0.4, startVals.duration - dsec); } // image length
        } else { c.trimIn = clamp(startVals.trimIn + dsec, 0, (startVals.trimOut || startVals.duration) - 0.2); }
      } else if (handle === 'r') { // trim end / duration
        if (c.type === 'image' || c.kind) { c.duration = Math.max(0.4, startVals.duration + dsec); }
        else { c.trimOut = Math.max((+c.trimIn || 0) + 0.2, (startVals.trimOut || startVals.duration) + dsec); }
      } else { // body move
        if (track === 'video') { reorderDrag(i, dx); return; }
        else { c.start = Math.max(0, startVals.start + dsec); }
      }
      timeline(); updateTimes();
    };
    const up = () => {
      window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up);
      save(); if (moved) seekPreview(head);
    };
    window.addEventListener('pointermove', move); window.addEventListener('pointerup', up);
  }

  // reorder base clips by dragging over neighbours
  function reorderDrag(i, dx) {
    const clips = TRACK('video').clips;
    const bs = baseStarts();
    const center = bs[i].start + clipDur(clips[i]) / 2 + dx / pps;
    let target = i;
    for (let k = 0; k < clips.length; k++) { if (center > bs[k].start + clipDur(clips[k]) / 2) target = k; }
    target = clamp(target, 0, clips.length - 1);
    if (target !== i) { const [m] = clips.splice(i, 1); clips.splice(target, 0, m); sel = { track: 'video', i: target }; timeline(); }
  }

  function selectClip(track, i) { sel = { track, i }; document.querySelectorAll('.ved-clip').forEach(c => c.classList.toggle('on', c.dataset.k === track && +c.dataset.i === i)); updateSelInfo(); if (['filters', 'transitions', 'panzoom', 'adjust'].includes(tab)) panel(); }

  function updateSelInfo() {
    const el = document.getElementById('vedSelInfo'); if (!el) return;
    if (!sel) { el.textContent = ''; return; }
    const c = TRACK(sel.track).clips[sel.i]; if (!c) { el.textContent = ''; return; }
    el.textContent = `${sel.track}: ${c.name || c.kind || c.type} · ${clipDur(c).toFixed(1)}s`;
  }

  // ---------- clip ops ----------
  function splitAtHead() {
    const bs = baseStarts(); const clips = TRACK('video').clips;
    for (let i = 0; i < clips.length; i++) {
      const s = bs[i].start, e = s + clipDur(clips[i]);
      if (head > s + 0.05 && head < e - 0.05) {
        const c = clips[i]; const at = head - s;
        if (c.type === 'image') {
          const b = Object.assign({}, c, { id: rid(), duration: c.duration - at });
          c.duration = at; b.transitionIn = null; clips.splice(i + 1, 0, b);
        } else {
          const ti = +c.trimIn || 0; const cut = ti + at;
          const b = Object.assign({}, c, { id: rid(), trimIn: cut, transitionIn: null });
          c.trimOut = cut; clips.splice(i + 1, 0, b);
        }
        sel = { track: 'video', i: i + 1 }; save(); timeline(); toastE('Split'); return;
      }
    }
    toastE('Move the playhead over a clip to split');
  }
  function duplicateSel() {
    if (!sel) return toastE('Select a clip');
    const arr = TRACK(sel.track).clips; const c = Object.assign({}, arr[sel.i], { id: rid() });
    if (sel.track !== 'video') c.start = (+c.start || 0) + clipDur(c);
    arr.splice(sel.i + 1, 0, c); sel.i++; save(); timeline();
  }
  function deleteSel() {
    if (!sel) return toastE('Select a clip');
    TRACK(sel.track).clips.splice(sel.i, 1); sel = null; save(); timeline(); updateTimes(); updateSelInfo();
  }

  // ---------- title editor ----------
  function editTitle(c) {
    window.openModal(`<h3 style="margin-bottom:10px">Edit title</h3>
      <div class="ved-field"><label>Text</label><textarea id="ttText" rows="2" style="width:100%">${E(c.text)}</textarea></div>
      <div class="row" style="gap:12px;flex-wrap:wrap">
        <div class="ved-field"><label>Size</label><input id="ttSize" type="number" value="${c.size || 64}" style="width:80px"></div>
        <div class="ved-field"><label>Color</label><input id="ttColor" type="color" value="${(c.color || '#ffffff')}"></div>
        <div class="ved-field"><label>Position</label><select id="ttPos"><option value="top">Top</option><option value="center">Center</option><option value="bottom">Bottom</option></select></div>
        <div class="ved-field"><label>Duration (s)</label><input id="ttDur" type="number" step="0.1" value="${c.duration || 3}" style="width:80px"></div>
        <div class="ved-field"><label><input id="ttBox" type="checkbox" ${c.box ? 'checked' : ''}> Background box</label></div>
      </div>
      <div class="row" style="margin-top:14px;gap:8px"><button class="btn" id="ttOk">Apply</button><button class="btn ghost" onclick="closeModal()">Cancel</button></div>`);
    const pos = document.getElementById('ttPos'); if (pos) pos.value = c.y || 'center';
    document.getElementById('ttOk').onclick = () => {
      c.text = document.getElementById('ttText').value;
      c.size = +document.getElementById('ttSize').value || 64;
      c.color = document.getElementById('ttColor').value;
      c.y = document.getElementById('ttPos').value;
      c.duration = +document.getElementById('ttDur').value || 3;
      c.box = document.getElementById('ttBox').checked;
      window.closeModal(); save(); timeline(); seekPreview(head);
    };
  }

  // ---------- WYSIWYG canvas preview ----------
  // A small in-browser compositor: real video frames + live colour filters +
  // transitions + titles/stickers + playback with audio. It APPROXIMATES the
  // ffmpeg export (exotic transitions crossfade here, exact on render). Big
  // files stream via the Range endpoint, so seeking never downloads the whole file.
  const mediaEls = new Map();     // clipId -> {el, kind, ready, src}
  let musicEl = null;
  let playing = false, rafId = 0, playAnchorWall = 0, playAnchorHead = 0, seekTok = 0;

  const EDU_TIPS = [
    ['Private by design', 'Nothing you edit here is ever uploaded. Every frame renders on this machine.'],
    ['Free forever', 'Export in Full HD or 4K with no watermark. Reclaiming that is the whole point.'],
    ['How to', 'Press S to split the clip under the playhead. Delete removes the selected clip.'],
    ['How to', 'Drop a photo on the timeline, then open Pan & Zoom for a Ken Burns motion effect.'],
    ['How to', 'Add a Title, then double-click it on the timeline to edit the text, size and colour.'],
    ['How to', 'Select the SECOND clip of a pair, open Transitions, and pick a blend between them.'],
    ['Tip', 'Filters, transitions and titles preview live here. Export bakes them in exactly.'],
    ['Tip', 'The Audio track mixes music under your clips. Set fade-in and fade-out in Adjust.'],
    ['Did you know', 'Your projects autosave. Reopen them any time from the Projects button.'],
    ['Tip', 'Spacebar plays and pauses. Arrow keys nudge one frame; Shift+Arrow jumps a second.']
  ];
  let tipTimer = 0, tipIdx = 0;
  function startTips() {
    const tip = () => { const [h, b] = EDU_TIPS[tipIdx++ % EDU_TIPS.length]; const H = document.getElementById('vedTipHead'), B = document.getElementById('vedTipBody'); if (H) H.textContent = h; if (B) B.textContent = b; };
    tip(); clearInterval(tipTimer); tipTimer = setInterval(tip, 2600);
  }
  function showLoading() { const l = document.getElementById('vedLoading'); if (l && l.hidden) { l.hidden = false; startTips(); } }
  function hideLoading() { const l = document.getElementById('vedLoading'); if (l && !l.hidden) { l.hidden = true; clearInterval(tipTimer); } }

  function pool() { return document.getElementById('vedPool'); }
  function ensureMedia() {
    if (!P) return;
    // guarantee every clip has a stable id (projects made via the API may omit them)
    ['video', 'overlay', 'audio'].forEach(k => TRACK(k).clips.forEach(c => { if (!c.id) c.id = rid(); }));
    const wanted = new Set();
    TRACK('video').clips.forEach(c => {
      wanted.add(c.id);
      let m = mediaEls.get(c.id);
      if (!m) {
        let el;
        if (c.type === 'image') { el = new Image(); }
        else { el = document.createElement('video'); el.preload = 'auto'; el.muted = true; el.playsInline = true; }
        el.src = mediaUrl(c.src);
        m = { el, kind: c.type === 'image' ? 'image' : 'video', ready: false, src: c.src };
        const done = () => { m.ready = true; onMediaReady(); };
        if (c.type === 'image') el.onload = done; else { el.onloadeddata = done; el.oncanplay = done; }
        pool().appendChild(el);
        mediaEls.set(c.id, m);
      } else if (m.src !== c.src) { m.src = c.src; m.ready = false; m.el.src = mediaUrl(c.src); }
    });
    TRACK('overlay').clips.forEach(o => {   // sticker images
      if (o.kind !== 'sticker' || !o.src) return;
      const id = 'stk_' + o.id; wanted.add(id);
      if (!mediaEls.has(id)) { const el = new Image(); el.src = mediaUrl(o.src); const m = { el, kind: 'image', ready: false, src: o.src }; el.onload = () => { m.ready = true; }; pool().appendChild(el); mediaEls.set(id, m); }
    });
    const mus = TRACK('audio').clips[0];
    if (mus) { if (!musicEl) { musicEl = document.createElement('audio'); musicEl.preload = 'auto'; pool().appendChild(musicEl); } if (musicEl.dataset.src !== mus.src) { musicEl.src = mediaUrl(mus.src); musicEl.dataset.src = mus.src; } }
    for (const [id, m] of mediaEls) { if (!wanted.has(id)) { m.el.remove(); mediaEls.delete(id); } }
  }
  function onMediaReady() {
    const clips = TRACK('video').clips, bs = baseStarts();
    let idx = -1; for (let i = 0; i < clips.length; i++) if (head >= bs[i].start - 0.001 && head < bs[i].start + clipDur(clips[i])) { idx = i; break; }
    if (idx < 0) { hideLoading(); return; }
    const m = mediaEls.get(clips[idx].id);
    if (elReady(m)) { hideLoading(); if (!playing) drawFrame(head); }
  }

  function canvasSize() {
    const canvas = document.getElementById('vedComposite'); if (!canvas || !P) return null;
    const W = Math.min(1280, P.canvas.width), H = Math.round(W * P.canvas.height / P.canvas.width);
    if (canvas.width !== W || canvas.height !== H) { canvas.width = W; canvas.height = H; }
    return { canvas, ctx: canvas.getContext('2d'), W, H };
  }
  function presetPrev(p) { switch (p) { case 'vivid': return { saturation: 1.5, contrast: 1.12 }; case 'warm': return { saturation: 1.1, brightness: 0.05 }; case 'cool': return { saturation: 1.05, brightness: -0.02 }; case 'bright': return { brightness: 0.12, contrast: 1.05 }; case 'contrast': return { contrast: 1.3 }; case 'grayscale': return { saturation: 0 }; default: return {}; } }
  function cssFilter(filter) {
    if (!filter) return 'none';
    const f = { ...presetPrev(filter.preset), ...filter }, parts = [];
    if (f.brightness) parts.push(`brightness(${(1 + (+f.brightness || 0)).toFixed(3)})`);
    if (f.contrast != null && +f.contrast !== 1) parts.push(`contrast(${+f.contrast})`);
    if (f.saturation != null && +f.saturation !== 1) parts.push(`saturate(${+f.saturation})`);
    if (f.gamma != null && +f.gamma !== 1) parts.push(`brightness(${(1 / +f.gamma).toFixed(3)})`);
    if (filter.preset === 'sepia') parts.push('sepia(0.7)');
    if (filter.preset === 'blur' || f.blur) parts.push(`blur(${((+f.blur || 6) / 3).toFixed(1)}px)`);
    return parts.length ? parts.join(' ') : 'none';
  }
  function fitDraw(ctx, W, H, m, c) {
    const el = m.el;
    const iw = m.kind === 'image' ? el.naturalWidth : el.videoWidth;
    const ih = m.kind === 'image' ? el.naturalHeight : el.videoHeight;
    if (!iw || !ih) return;
    let scale = Math.min(W / iw, H / ih);
    if (c.type === 'image' && c.panzoom && c.panzoom.enabled) {
      const clips = TRACK('video').clips, bs = baseStarts(), i = clips.indexOf(c);
      const p = i >= 0 ? clamp((head - bs[i].start) / clipDur(c), 0, 1) : 0;
      scale *= c.panzoom.to === 'out' ? (1.15 - 0.15 * p) : (1 + 0.15 * p);
    }
    const dw = iw * scale, dh = ih * scale;
    ctx.drawImage(el, (W - dw) / 2, (H - dh) / 2, dw, dh);
  }
  // "ready to draw" = has at least one decoded frame (dimensions). A seeking video
  // keeps its last frame, so we don't gate on readyState (which dips during seeks).
  function elReady(m) { return m && (m.kind === 'image' ? (m.el.complete && m.el.naturalWidth > 0) : (m.el.videoWidth > 0)); }
  function drawClip(ctx, W, H, c) { const m = mediaEls.get(c.id); if (!elReady(m)) return false; ctx.save(); ctx.filter = cssFilter(c.filter); fitDraw(ctx, W, H, m, c); ctx.restore(); return true; }
  function drawTransitionClip(ctx, W, H, c, type, p) {
    const m = mediaEls.get(c.id); if (!elReady(m)) return;
    ctx.save(); ctx.filter = cssFilter(c.filter);
    if (/^wipe/.test(type)) {
      let x = 0, y = 0, w = W, h = H;
      if (type === 'wipeleft') w = W * p; else if (type === 'wiperight') { x = W * (1 - p); w = W * p; }
      else if (type === 'wipeup') h = H * p; else if (type === 'wipedown') { y = H * (1 - p); h = H * p; }
      ctx.beginPath(); ctx.rect(x, y, w, h); ctx.clip(); fitDraw(ctx, W, H, m, c);
    } else if (/^slide/.test(type)) {
      let tx = 0, ty = 0;
      if (type === 'slideleft') tx = W * (1 - p); else if (type === 'slideright') tx = -W * (1 - p);
      else if (type === 'slideup') ty = H * (1 - p); else if (type === 'slidedown') ty = -H * (1 - p);
      ctx.translate(tx, ty); fitDraw(ctx, W, H, m, c);
    } else { ctx.globalAlpha = p; fitDraw(ctx, W, H, m, c); }   // fade/dissolve/other -> crossfade
    ctx.restore();
  }
  function drawOverlays(ctx, W, H, t) {
    const sc = H / P.canvas.height;
    TRACK('overlay').clips.forEach(o => {
      const st = +o.start || 0; if (t < st || t >= st + clipDur(o)) return;
      if (o.kind === 'text') {
        const size = (+o.size || 64) * sc, lines = String(o.text || '').replace(/\r\n?/g, '\n').split('\n'), lineH = size * 1.32;
        ctx.save(); ctx.filter = 'none'; ctx.font = `700 ${size}px Arial, sans-serif`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
        const anchor = o.y || 'center';
        let yStart = anchor === 'top' ? size * 0.9 : anchor === 'bottom' ? H - lines.length * lineH - size * 0.3 + lineH / 2 : (H - lines.length * lineH) / 2 + lineH / 2;
        lines.forEach((ln, i) => {
          const y = yStart + i * lineH, tw = ctx.measureText(ln).width;
          if (o.box) { const a = (o.boxcolor && o.boxcolor.includes('@')) ? parseFloat(o.boxcolor.split('@')[1]) : 0.5; ctx.fillStyle = `rgba(0,0,0,${a})`; ctx.fillRect((W - tw) / 2 - 14 * sc, y - lineH / 2, tw + 28 * sc, lineH); }
          ctx.fillStyle = 'rgba(0,0,0,0.6)'; ctx.fillText(ln, W / 2 + 2 * sc, y + 2 * sc);
          ctx.fillStyle = o.color || '#fff'; ctx.fillText(ln, W / 2, y);
        });
        ctx.restore();
      } else if (o.kind === 'sticker') {
        const m = mediaEls.get('stk_' + o.id); if (!elReady(m)) return;
        ctx.save(); ctx.filter = 'none';
        const w = W * (+o.scale || 0.25), h = w * (m.el.naturalHeight / (m.el.naturalWidth || 1));
        ctx.drawImage(m.el, (W - w) / 2, (H - h) / 2, w, h);
        ctx.restore();
      }
    });
  }
  function drawFrame(t) {
    const cs = canvasSize(); if (!cs) return; const { ctx, W, H } = cs;
    const clips = TRACK('video').clips, bs = baseStarts();
    let idx = -1; for (let i = 0; i < clips.length; i++) if (t >= bs[i].start - 0.001 && t < bs[i].start + clipDur(clips[i])) { idx = i; break; }
    // during playback, hold the last frame if the current one isn't decoded yet (no black flicker)
    if (playing && idx >= 0 && !elReady(mediaEls.get(clips[idx].id))) return;
    ctx.filter = 'none'; ctx.globalAlpha = 1; ctx.fillStyle = '#000'; ctx.fillRect(0, 0, W, H);
    if (idx >= 0) {
      const c = clips[idx], tr = c.transitionIn; let handled = false;
      if (idx > 0 && tr && tr.type && tr.type !== 'none' && +tr.duration > 0) {
        const d = Math.min(+tr.duration, clipDur(c) - 0.05, bs[idx - 1].dur - 0.05);
        if (t < bs[idx].start + d) { const p = clamp((t - bs[idx].start) / d, 0, 1); drawClip(ctx, W, H, clips[idx - 1]); drawTransitionClip(ctx, W, H, c, tr.type, p); handled = true; }
      }
      if (!handled) drawClip(ctx, W, H, c);
    }
    drawOverlays(ctx, W, H, t);
  }

  function seekPreview(t) {
    if (!P) return;
    head = clamp(t, 0, Math.max(0.01, totalDur()));
    const hd = document.getElementById('vedHead'); if (hd) hd.style.left = (head * pps) + 'px';
    updateTimes(); ensureMedia();
    const clips = TRACK('video').clips, bs = baseStarts();
    const nf = document.getElementById('vedNoframe'); if (nf) nf.style.display = clips.length ? 'none' : '';
    let idx = -1; for (let i = 0; i < clips.length; i++) if (head >= bs[i].start - 0.001 && head < bs[i].start + clipDur(clips[i])) { idx = i; break; }
    if (idx >= 0) { const m = mediaEls.get(clips[idx].id); if (m && !elReady(m)) showLoading(); else hideLoading(); } else hideLoading();
    const tok = ++seekTok;
    const seekEl = (c, srcT) => { const m = mediaEls.get(c.id); if (!m || m.kind !== 'video') return; if (Math.abs(m.el.currentTime - srcT) > 0.05) { try { m.el.currentTime = Math.max(0, srcT); } catch {} m.el.addEventListener('seeked', () => { if (tok === seekTok) drawFrame(head); }, { once: true }); } };
    if (idx >= 0) {
      const c = clips[idx]; seekEl(c, (+c.trimIn || 0) + (head - bs[idx].start));
      const tr = c.transitionIn;
      if (idx > 0 && tr && tr.type && tr.type !== 'none' && +tr.duration > 0) { const pc = clips[idx - 1]; seekEl(pc, (+pc.trimIn || 0) + ((bs[idx].start - bs[idx - 1].start) + (head - bs[idx].start))); }
    }
    drawFrame(head);
  }
  function updateTimes() {
    if (!P) return;
    const a = document.getElementById('vedTcode'); if (a) a.textContent = tc(head);
    const b = document.getElementById('vedTtotal'); if (b) b.textContent = tc(totalDur());
  }

  function syncPlayback(t) {
    const clips = TRACK('video').clips, bs = baseStarts();
    let idx = -1; for (let i = 0; i < clips.length; i++) if (t >= bs[i].start - 0.001 && t < bs[i].start + clipDur(clips[i])) { idx = i; break; }
    clips.forEach((c, i) => {
      const m = mediaEls.get(c.id); if (!m || m.kind !== 'video') return;
      if (i === idx) {
        const srcT = (+c.trimIn || 0) + (t - bs[i].start);
        // tight threshold: if the element is playing, drift stays small (no seek); if play()
        // is blocked, this steps the frame forward so the preview still moves.
        if (Math.abs(m.el.currentTime - srcT) > 0.12) { try { m.el.currentTime = srcT; } catch {} }
        m.el.muted = false; m.el.volume = clamp(c.volume != null ? +c.volume : 1, 0, 1);
        if (m.el.paused) m.el.play().catch(() => {});
      } else { if (!m.el.paused) m.el.pause(); m.el.muted = true; }
    });
    const mus = TRACK('audio').clips[0];
    if (mus && musicEl) {
      const mt = t - (+mus.start || 0) + (+mus.trimIn || 0);
      if (mt >= 0 && t < (+mus.start || 0) + clipDur(mus)) {
        if (Math.abs(musicEl.currentTime - mt) > 0.35) { try { musicEl.currentTime = mt; } catch {} }
        musicEl.volume = clamp(mus.volume != null ? +mus.volume : 1, 0, 1);
        if (musicEl.paused) musicEl.play().catch(() => {});
      } else if (!musicEl.paused) musicEl.pause();
    }
  }
  function frameLoop() {
    if (!playing || !P) return;
    let t = playAnchorHead + (performance.now() - playAnchorWall) / 1000;
    if (t >= totalDur()) { pausePlay(); seekPreview(Math.max(0, totalDur() - 0.03)); return; }
    head = t; const hd = document.getElementById('vedHead'); if (hd) hd.style.left = (head * pps) + 'px';
    updateTimes(); syncPlayback(t); drawFrame(t);
    rafId = requestAnimationFrame(frameLoop);
  }
  function pausePlay() { playing = false; if (rafId) cancelAnimationFrame(rafId); rafId = 0; const b = document.getElementById('tpPlay'); if (b) b.textContent = '▶'; mediaEls.forEach(m => { if (m.kind === 'video') m.el.pause(); }); if (musicEl) musicEl.pause(); }
  function togglePlay() {
    if (!P) return;
    if (playing) { pausePlay(); return; }
    if (!TRACK('video').clips.length) return toastE('Add a clip first');
    ensureMedia(); hideLoading(); playing = true; playAnchorWall = performance.now(); playAnchorHead = head >= totalDur() - 0.05 ? 0 : head;
    const b = document.getElementById('tpPlay'); if (b) b.textContent = '⏸'; frameLoop();
  }

  // ---------- projects / canvas / export ----------
  async function newProject() {
    const name = prompt('New project name', 'My Movie'); if (name == null) return;
    P = await A('/api/editor/new', { name: name || 'My Movie' }); bin = []; sel = null; head = 0; layout();
  }
  async function openProjects() {
    const list = await A('/api/editor/projects');
    window.openModal(`<h3 style="margin-bottom:10px">Projects</h3>
      <div class="ved-projlist">${list.map(p => `<div class="ved-projrow" data-id="${p.id}">
        <b>${E(p.name)}</b><span>${p.clips} clips · ${new Date(p.updatedAt).toLocaleString()}</span>
        <button class="ved-del" data-del="${p.id}">🗑</button></div>`).join('') || '<div class="muted">No saved projects.</div>'}</div>
      <button class="btn ghost" style="margin-top:12px" onclick="closeModal()">Close</button>`);
    document.querySelectorAll('.ved-projrow').forEach(r => r.onclick = async e => {
      if (e.target.dataset.del) { await A('/api/editor/delete', { id: e.target.dataset.del }); openProjects(); return; }
      P = await A('/api/editor/project?id=' + r.dataset.id); bin = []; rebuildBin(); sel = null; head = 0; window.closeModal(); layout();
    });
  }
  function canvasDialog() {
    window.openModal(`<h3 style="margin-bottom:10px">Project settings</h3>
      <div class="row" style="gap:12px">
        <div class="ved-field"><label>Resolution</label><select id="cvRes">
          <option value="3840x2160">4K UHD (3840×2160)</option>
          <option value="1920x1080" selected>Full HD (1920×1080)</option>
          <option value="1280x720">HD (1280×720)</option>
          <option value="1080x1920">Vertical 9:16 (1080×1920)</option>
          <option value="1080x1080">Square (1080×1080)</option>
        </select></div>
        <div class="ved-field"><label>FPS</label><select id="cvFps"><option>24</option><option selected>30</option><option>60</option></select></div>
      </div>
      <div class="row" style="margin-top:14px;gap:8px"><button class="btn" id="cvOk">Apply</button><button class="btn ghost" onclick="closeModal()">Cancel</button></div>`);
    document.getElementById('cvRes').value = P.canvas.width + 'x' + P.canvas.height;
    document.getElementById('cvFps').value = String(P.canvas.fps);
    document.getElementById('cvOk').onclick = () => {
      const [w, h] = document.getElementById('cvRes').value.split('x').map(Number);
      P.canvas.width = w; P.canvas.height = h; P.canvas.fps = +document.getElementById('cvFps').value;
      window.closeModal(); save(); layout();
    };
  }

  let exportJobId = null;
  function exportDialog() {
    if (!TRACK('video').clips.length) return toastE('Add at least one clip first');
    window.openModal(`<h3 style="margin-bottom:6px">Export video</h3>
      <div class="muted" style="margin-bottom:12px">${P.canvas.width}×${P.canvas.height} · ${P.canvas.fps}fps · ${tc(totalDur())}. No watermark, ever.</div>
      <div class="row" style="gap:12px;flex-wrap:wrap">
        <div class="ved-field"><label>Format</label><select id="exFmt"><option value="mp4">MP4 (H.264)</option><option value="webm">WebM</option><option value="mov">MOV</option></select></div>
        <div class="ved-field"><label>Quality</label><select id="exQ"><option value="18">High (large)</option><option value="20" selected>Good</option><option value="24">Small</option></select></div>
      </div>
      <div id="exProg" style="margin-top:14px"></div>
      <div class="row" style="margin-top:14px;gap:8px"><button class="btn" id="exGo">Start export</button><button class="btn ghost" onclick="closeModal()">Cancel</button></div>`);
    document.getElementById('exGo').onclick = async () => {
      P.export = { format: document.getElementById('exFmt').value, crf: +document.getElementById('exQ').value };
      await A('/api/editor/save', { project: P });
      document.getElementById('exGo').disabled = true;
      document.getElementById('exProg').innerHTML = `<div class="prog"><i id="exBar" style="width:0%"></i></div><div class="muted" id="exMsg" style="margin-top:6px">Rendering…</div>`;
      const r = await A('/api/editor/render', { id: P.id });
      exportJobId = r.jobId;
    };
  }
  window.onForgeJob = job => {
    if (!exportJobId || job.id !== exportJobId) return;
    const bar = document.getElementById('exBar'), msg = document.getElementById('exMsg');
    if (bar) bar.style.width = (job.progress || 0) + '%';
    if (job.status === 'done' && msg) {
      const dl = '/api/download?path=' + encodeURIComponent(job.out);
      document.getElementById('exProg').innerHTML = `<div class="result"><b>✓ Done, no watermark</b>
        <video src="${mediaUrl(job.out)}" controls style="width:100%;margin-top:10px;border-radius:8px"></video>
        <div class="row" style="margin-top:10px;gap:8px"><a class="btn" href="${dl}">Save video</a>
        ${window.forge ? `<button class="btn ghost" data-p="${E(job.out.replace(/\\/g, '/'))}" onclick="window.forge.reveal(this.dataset.p)">Show in folder</button>` : ''}</div></div>`;
      exportJobId = null;
    } else if (job.status === 'error' && msg) { msg.innerHTML = `<span style="color:var(--err)">✗ ${E(job.error)}</span>`; exportJobId = null; document.getElementById('exGo').disabled = false; }
  };

  // ---------- utils ----------
  function rid() { return Math.random().toString(36).slice(2, 9); }
  function toastE(m) { if (window.toast) window.toast(m); }
  document.addEventListener('keydown', e => {
    if (document.body.dataset.tab !== 'edit') return;
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA' || e.target.tagName === 'SELECT') return;
    if (e.key === 's' || e.key === 'S') { splitAtHead(); }
    else if (e.key === 'Delete' || e.key === 'Backspace') { deleteSel(); }
    else if (e.key === ' ') { e.preventDefault(); togglePlay(); }
    else if (e.key === 'ArrowLeft') seekPreview(head - (e.shiftKey ? 1 : 1 / (P ? P.canvas.fps : 30)));
    else if (e.key === 'ArrowRight') seekPreview(head + (e.shiftKey ? 1 : 1 / (P ? P.canvas.fps : 30)));
  });

  // let the Media tab's "Send to Video Editor" drop a produced file straight in
  window.forgeEditorImport = async (path) => {
    const info = await A('/api/editor/probe?path=' + encodeURIComponent(path));
    if (info.error) return toastE(info.error);
    if (!bin.find(b => b.src === info.src)) bin.push(info);
    if (tab === 'import') paintBin();
    addBinInfoToTrack(info, info.type === 'audio' ? 'audio' : 'video');
  };

  // ---------- context menus (editor) ----------
  if (window.CTX) {
    const forgeOK = () => !!(window.forge && window.forge.reveal);
    window.CTX.register('clip', (el) => {
      const track = el.dataset.k, i = +el.dataset.i; selectClip(track, i);
      const c = TRACK(track).clips[i]; if (!c) return [];
      const items = [];
      if (track === 'video') {
        items.push({ label: '✂ Split at playhead', run: () => splitAtHead() });
        items.push({ label: '⧉ Duplicate', run: () => duplicateSel() });
        if (i > 0 && c.transitionIn && c.transitionIn.type && c.transitionIn.type !== 'none') items.push({ label: '⇄ Remove transition', run: () => { c.transitionIn = null; save(); timeline(); } });
        if (c.filter && c.filter.preset) items.push({ label: '🎨 Remove filter', run: () => { c.filter.preset = null; save(); timeline(); seekPreview(head); } });
        items.push({ label: (c.volume === 0 ? '🔊 Unmute' : '🔇 Mute'), run: () => { c.volume = c.volume === 0 ? 1 : 0; save(); timeline(); } });
        items.push({ label: '⚙ Adjust…', run: () => { tab = 'adjust'; layout(); } });
        if (forgeOK()) items.push({ label: '📂 Reveal source', run: () => window.forge.reveal(c.src) });
        items.push({ sep: true });
        items.push({ label: '🗑 Delete clip', danger: true, run: () => deleteSel() });
      } else {
        if (c.kind === 'text') items.push({ label: '✎ Edit title…', run: () => editTitle(c) });
        items.push({ label: '⧉ Duplicate', run: () => duplicateSel() });
        if (track === 'audio') items.push({ label: (c.volume === 0 ? '🔊 Unmute' : '🔇 Mute'), run: () => { c.volume = c.volume === 0 ? 1 : 0; save(); timeline(); } });
        if (c.src && forgeOK()) items.push({ label: '📂 Reveal source', run: () => window.forge.reveal(c.src) });
        items.push({ sep: true });
        items.push({ label: '🗑 Delete', danger: true, run: () => deleteSel() });
      }
      return items;
    });
    window.CTX.register('binitem', (el) => {
      const i = +el.dataset.i, b = bin[i]; if (!b) return [];
      const items = [{ label: '▷ Add to timeline', run: () => binToTimeline(i) }];
      if (b.type !== 'audio') items.push({ label: '♪ Add soundtrack to Audio track', run: () => addBinInfoToTrack(b, 'audio') });
      if (forgeOK()) items.push({ label: '📂 Reveal source', run: () => window.forge.reveal(b.src) });
      items.push({ sep: true });
      items.push({ label: '✕ Remove from bin', run: () => { bin.splice(i, 1); paintBin(); } });
      return items;
    });
  }
})();
