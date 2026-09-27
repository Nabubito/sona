/* Flicker, by Sona: the page.
   House rules: no inline script or style (the CSP forbids both), styles set through classes or
   style.setProperty, and nothing typed or taken from a file name is ever put into the page as
   HTML (textContent only). Phone first. No long dashes in any visible text. */

(function () {
  'use strict';

  var $ = function (id) { return document.getElementById(id); };
  var S = {
    state: null, src: null, tool: 'cut', a: 0, b: 0,
    cutOut: 'video', audioFmt: 'mp3', gifW: 480,
    ratio: '9:16', mode: 'crop', color: 'black', zoom: 1, panX: 0.5, panY: 0.5,
    words: '', typed: '', style: null, song: null,
    raf: 0, playable: false, jobs: [], homeJobs: [], polling: 0, stripTimer: 0, songTimer: 0,
    dockOwner: 'app',
  };
  var PREVIEW_LONG = 960;
  var MIN_LEN = 0.5;

  /* ---------------- small helpers ---------------- */

  function show(el, on) { if (el) el.hidden = !on; }
  function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }
  function tenth(v) { return Math.round(Number(v) * 10) / 10; }
  function fmtClock(sec) {
    sec = Math.max(0, Number(sec) || 0);
    var m = Math.floor(sec / 60), s = sec - m * 60;
    var whole = Math.floor(s), t = Math.floor((s - whole) * 10 + 1e-6);
    return m + ':' + String(whole).padStart(2, '0') + '.' + t;
  }
  function fmtLen(sec) {
    sec = Number(sec) || 0;
    if (sec < 60) return (Math.round(sec * 10) / 10) + ' s';
    if (sec >= 3600 && sec % 3600 === 0) return plural(sec / 3600, 'hour');
    var m = Math.floor(sec / 60), s = Math.round(sec - m * 60);
    if (s === 60) { m++; s = 0; }
    return m + ' min' + (s ? ' ' + s + ' s' : '');
  }
  function plural(n, word) { n = Math.round(Number(n) * 10) / 10; return n + ' ' + word + (n === 1 ? '' : 's'); }
  function parseT(str) {
    var s = String(str || '').trim();
    if (!s) return NaN;
    var m = /^(?:(\d+):)?(\d+(?:\.\d*)?)$/.exec(s);
    if (!m) return NaN;
    return (m[1] ? Number(m[1]) * 60 : 0) + Number(m[2]);
  }
  function fmtBytes(n) {
    n = Number(n) || 0;
    var t = function (v) { return (Math.round(v * 10) / 10).toString(); };
    if (n >= 1073741824) return t(n / 1073741824) + ' GB';
    if (n >= 1048576) return t(n / 1048576) + ' MB';
    return Math.max(1, Math.round(n / 1024)) + ' KB';
  }

  var toastT = 0;
  function toast(msg) {
    var el = $('toast');
    el.textContent = msg;
    show(el, true);
    clearTimeout(toastT);
    toastT = setTimeout(function () { show(el, false); }, 3600);
  }

  function api(method, path, body) {
    var opts = { method: method, credentials: 'same-origin', headers: {} };
    if (body !== undefined) { opts.headers['Content-Type'] = 'application/json'; opts.body = JSON.stringify(body); }
    return fetch(path, opts).then(function (r) {
      if (r.status === 401) { location.href = '/gate.html'; return { status: 401, body: {} }; }
      return r.json().catch(function () { return {}; }).then(function (j) { return { status: r.status, body: j || {} }; });
    }).catch(function () { return { status: 0, body: { error: 'Could not reach Flicker. Is it still running?' } }; });
  }
  function errOf(r, fallback) { return (r && r.body && r.body.error) || fallback || 'Something went wrong. Try again.'; }

  // Pills. options: [{ value, label, disabled, title, swatch }]
  function buildSeg(el, options, current, onPick) {
    el.textContent = '';
    options.forEach(function (o) {
      var b = document.createElement('button');
      b.type = 'button';
      b.className = 'seg';
      b.textContent = o.label;
      b.setAttribute('aria-pressed', String(o.value) === String(current) ? 'true' : 'false');
      if (o.disabled) b.disabled = true;
      if (o.title) b.title = o.title;
      if (o.swatch) { b.style.setProperty('--swatch', o.swatch); b.setAttribute('aria-label', o.label); b.title = o.label; }
      if (o.font) { b.style.setProperty('font-family', o.font); b.style.setProperty('font-weight', String(o.weight || 700)); }
      b.addEventListener('click', function () {
        if (b.disabled) return;
        Array.prototype.forEach.call(el.children, function (c) { c.setAttribute('aria-pressed', c === b ? 'true' : 'false'); });
        onPick(o.value);
      });
      el.appendChild(b);
    });
  }

  function store(k, v) {
    try { if (v === undefined) return localStorage.getItem(k); localStorage.setItem(k, v); } catch (e) { return null; }
    return null;
  }

  /* ---------------- dock (the sticky primary action) ---------------- */

  var dockGoFn = null, dockAltFn = null;
  // cfg: { go: {label, disabled, fn} | null, alt: {label, fn} | null, save: {href, label} | null, msg, pct (0..100 or null) }
  function dock(cfg) {
    cfg = cfg || {};
    var d = $('dock');
    show(d, true);
    var go = $('dockGo'), alt = $('dockAlt'), save = $('dockSave');
    show(go, !!cfg.go);
    if (cfg.go) { go.textContent = cfg.go.label; go.disabled = !!cfg.go.disabled; dockGoFn = cfg.go.fn; }
    show(alt, !!cfg.alt);
    if (cfg.alt) { alt.textContent = cfg.alt.label; dockAltFn = cfg.alt.fn; }
    show(save, !!cfg.save);
    if (cfg.save) { save.href = cfg.save.href; save.textContent = cfg.save.label || 'Save'; save.setAttribute('download', ''); }
    show($('dockMsg'), !!cfg.msg);
    $('dockMsg').textContent = cfg.msg || '';
    var hasPct = typeof cfg.pct === 'number';
    show($('dockMeter'), hasPct);
    if (hasPct) $('dockFill').style.setProperty('width', clamp(cfg.pct, 0, 100) + '%');
  }
  function hideDock() { show($('dock'), false); }
  $('dockGo').addEventListener('click', function () { if (dockGoFn) dockGoFn(); });
  $('dockAlt').addEventListener('click', function () { if (dockAltFn) dockAltFn(); });

  /* ---------------- state and engines ---------------- */

  function loadState() {
    return api('GET', '/api/state').then(function (r) {
      if (r.status !== 200 || !r.body.ok) return;
      S.state = r.body;
      paintEngines();
      var li = S.state.engines.linkImport;
      show($('linkCard'), !!(li && li.enabled));
      $('linkChip').textContent = li && li.ok ? 'on' : 'needs yt-dlp';
      $('dropSmall').textContent = 'or tap to choose one from this device. Up to ' + fmtBytes(S.state.limits.maxUploadMB * 1048576) + ' and ' + fmtLen(S.state.limits.maxSourceSec) + '.';
      if (!S.state.engines.ffmpeg.ok) { $('homeErr').textContent = S.state.engines.ffmpeg.help; show($('homeErr'), true); }
      if (window.FLICKER_FOLLOW) window.FLICKER_FOLLOW.onState(S.state);
    });
  }

  function paintEngines() {
    var e = S.state.engines, ul = $('engines');
    ul.textContent = '';
    var rows = [
      ['Video engine (ffmpeg)', e.ffmpeg.ok ? (e.ffmpeg.burn ? 'ok' : 'partial') : 'bad', e.ffmpeg.ok ? 'Version ' + e.ffmpeg.version + '. Cut, audio, GIF and reframe are ready.' : '', e.ffmpeg.help],
      ['Speech to text', e.listen.ok ? 'ok' : 'off', e.listen.ok ? 'Model ' + e.listen.model + ', on the CPU. Heard words and lyrics are ready.' : 'Optional. Adds heard words and lyrics.', e.listen.help],
      ['Text follow', e.follow.ok ? 'ok' : 'off', e.follow.ok ? 'Tracker ready.' : 'Optional. Needs an NVIDIA graphics card.', e.follow.help],
      ['Link import', e.linkImport.ok ? 'ok' : e.linkImport.enabled ? 'bad' : 'off', e.linkImport.ok ? 'yt-dlp ' + e.linkImport.engine + ', every fetch goes through the private address guard. Keep yt-dlp updated.' : '', e.linkImport.help],
      ['Lyrics lookup', e.lyrics.ok ? 'ok' : 'off', e.lyrics.ok ? 'Asks a public lyrics service for an artist and song title, only when you pick Lyrics.' : '', e.lyrics.help],
      ['Name songs by sound', e.songId.ok ? 'ok' : 'off', '', e.songId.help],
    ];
    rows.forEach(function (r) {
      var li = document.createElement('li'); li.className = 'engine';
      var top = document.createElement('div'); top.className = 'engine-top';
      var b = document.createElement('b'); b.textContent = r[0];
      var p = document.createElement('span'); p.className = 'pill ' + (r[1] === 'ok' ? 'ok' : r[1] === 'bad' ? 'bad' : 'off');
      p.textContent = r[1] === 'ok' ? 'ready' : r[1] === 'bad' ? 'missing' : r[1] === 'partial' ? 'partial' : 'off';
      top.appendChild(b); top.appendChild(p); li.appendChild(top);
      if (r[2]) { var d = document.createElement('p'); d.className = 'fine'; d.textContent = r[2]; li.appendChild(d); }
      if (r[3]) { var h = document.createElement('p'); h.className = 'fine help'; h.textContent = r[3]; li.appendChild(h); }
      ul.appendChild(li);
    });
  }

  function recheck(btn) {
    btn.disabled = true;
    api('POST', '/api/engines/check').then(function (r) {
      btn.disabled = false;
      if (r.status === 200 && r.body.ok) { S.state = r.body; paintEngines(); if (window.FLICKER_FOLLOW) window.FLICKER_FOLLOW.onState(S.state); if (S.src) paintWords(); toast('Engines checked.'); }
    });
  }

  /* ---------------- drawer ---------------- */

  function openDrawer() { show($('scrim'), true); show($('drawer'), true); $('drawerClose').focus(); }
  function closeDrawer() { show($('scrim'), false); show($('drawer'), false); $('menuBtn').focus(); }
  $('menuBtn').addEventListener('click', openDrawer);
  $('drawerClose').addEventListener('click', closeDrawer);
  $('scrim').addEventListener('click', closeDrawer);
  document.addEventListener('keydown', function (ev) { if (ev.key === 'Escape' && !$('drawer').hidden) closeDrawer(); });
  $('recheck').addEventListener('click', function () { recheck($('recheck')); });
  $('lockBtn').addEventListener('click', function () { api('POST', '/api/logout').then(function () { location.href = '/gate.html'; }); });

  /* ---------------- home: sources ---------------- */

  function refreshSources() {
    return api('GET', '/api/sources').then(function (r) {
      var list = (r.body && r.body.sources) || [];
      var ul = $('srcList');
      ul.textContent = '';
      list.forEach(function (s) {
        var li = document.createElement('li');
        var row = document.createElement('div'); row.className = 'src-item'; row.tabIndex = 0; row.setAttribute('role', 'button');
        var th = document.createElement('span'); th.className = 'src-thumb';
        if (s.strip) th.style.setProperty('background-image', 'url(/api/source/' + s.id + '/strip)');
        var tx = document.createElement('span'); tx.className = 'src-text';
        var nm = document.createElement('span'); nm.className = 'src-name'; nm.textContent = s.name;
        var sub = document.createElement('span'); sub.className = 'src-sub'; sub.textContent = fmtClock(s.dur) + ' · ' + s.w + '×' + s.h + (s.audio ? '' : ' · no sound') + (s.origin === 'link' ? ' · from a link' : '');
        tx.appendChild(nm); tx.appendChild(sub);
        var x = document.createElement('button'); x.type = 'button'; x.className = 'btn sm ghost src-x'; x.textContent = 'Close';
        x.setAttribute('aria-label', 'Close ' + s.name);
        x.addEventListener('click', function (ev) { ev.stopPropagation(); api('POST', '/api/source/' + s.id + '/drop').then(refreshSources); });
        row.appendChild(th); row.appendChild(tx); row.appendChild(x);
        row.addEventListener('click', function () { openStudio(s.id); });
        row.addEventListener('keydown', function (ev) { if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); openStudio(s.id); } });
        li.appendChild(row);
        ul.appendChild(li);
      });
      show($('openSec'), list.length > 0);
      if (S.state) $('openNote').textContent = 'Open videos stay in the work folder for ' + plural(S.state.limits.sourceHours, 'hour') + ' after you last touch them.';
    });
  }

  /* ---------------- home: upload ---------------- */

  var uploading = null;
  function takeFile(file) {
    if (!file || uploading) return;
    show($('homeErr'), false);
    if (file.type && !/^video\//.test(file.type) && !/\.(mkv|mov|mp4|webm|m4v|avi|ts|3gp|ogv)$/i.test(file.name)) { $('homeErr').textContent = 'That is not a video file.'; show($('homeErr'), true); return; }
    if (S.state && file.size > S.state.limits.maxUploadMB * 1048576) { $('homeErr').textContent = 'That file is bigger than the upload limit (' + fmtBytes(S.state.limits.maxUploadMB * 1048576) + ').'; show($('homeErr'), true); return; }
    upload(file);
  }

  function xhr(method, path, body, headers, onProgress) {
    return new Promise(function (resolve) {
      var x = new XMLHttpRequest();
      x.open(method, path);
      Object.keys(headers || {}).forEach(function (k) { x.setRequestHeader(k, headers[k]); });
      if (onProgress && x.upload) x.upload.onprogress = function (ev) { if (ev.lengthComputable) onProgress(ev.loaded); };
      x.onload = function () { var j = {}; try { j = JSON.parse(x.responseText || '{}'); } catch (e) { j = {}; } resolve({ status: x.status, body: j }); };
      x.onerror = function () { resolve({ status: 0, body: {} }); };
      x.onabort = function () { resolve({ status: -1, body: {} }); };
      x.send(body);
    });
  }

  function paintUpload(pct, big) {
    show($('upMeter'), pct !== null);
    if (pct !== null) $('upFill').style.setProperty('width', clamp(pct, 0, 100) + '%');
    $('dropBig').textContent = big || 'Drop a video here';
  }

  function upload(file) {
    uploading = file;
    paintUpload(0, 'Copying it in, 0%');
    api('POST', '/api/upload', { size: file.size, name: file.name }).then(function (r) {
      if (r.status !== 200 || !r.body.id) return upFail(errOf(r));
      var id = r.body.id, part = r.body.part, at = 0;
      var step = function () {
        if (at >= file.size) {
          paintUpload(100, 'Having a look at it');
          return xhr('POST', '/api/source/' + id + '/finish', null, {}).then(function (f) {
            if (f.status !== 200 || !f.body.source) return upFail(errOf(f, 'Could not read that video.'));
            uploading = null;
            paintUpload(null);
            refreshSources();
            openStudio(id);
          });
        }
        var end = Math.min(file.size, at + part);
        return xhr('POST', '/api/source/' + id + '/part', file.slice(at, end), { 'Content-Type': 'application/octet-stream', 'X-Part-Offset': String(at) },
          function (loaded) { var pct = ((at + loaded) / file.size) * 100; paintUpload(Math.min(99, pct), 'Copying it in, ' + Math.floor(Math.min(99, pct)) + '%'); })
          .then(function (p) {
            if (p.status !== 200) return upFail(errOf(p, 'The upload stopped. Try again.'));
            at = end;
            return step();
          });
      };
      return step();
    });
  }
  function upFail(msg) {
    uploading = null;
    paintUpload(null);
    $('homeErr').textContent = msg;
    show($('homeErr'), true);
  }

  var drop = $('drop');
  $('fileInput').addEventListener('change', function () { var f = this.files && this.files[0]; this.value = ''; takeFile(f); });
  drop.addEventListener('keydown', function (ev) { if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); $('fileInput').click(); } });
  ['dragenter', 'dragover'].forEach(function (t) { document.addEventListener(t, function (ev) { if (!$('home').hidden) { ev.preventDefault(); drop.classList.add('over'); } }); });
  ['dragleave', 'drop'].forEach(function (t) { document.addEventListener(t, function (ev) { ev.preventDefault(); drop.classList.remove('over'); }); });
  document.addEventListener('drop', function (ev) { if ($('home').hidden) return; var f = ev.dataTransfer && ev.dataTransfer.files && ev.dataTransfer.files[0]; takeFile(f); });

  /* ---------------- home: link import (optional) ---------------- */

  var link = { url: '', found: null, subs: '', quality: 'best', audioFmt: 'mp3' };
  $('linkForm').addEventListener('submit', function (ev) {
    ev.preventDefault();
    var u = $('linkInput').value.trim();
    if (!/^https?:\/\//i.test(u)) { linkNote('That does not look like a link yet.'); return; }
    link.url = u; link.found = null;
    show($('linkInfo'), false);
    linkNote('Checking the link.');
    $('linkGo').disabled = true;
    api('POST', '/api/link/info', { u: u }).then(function (r) {
      $('linkGo').disabled = false;
      if (r.status !== 200 || !r.body.ok) return linkNote(errOf(r));
      linkNote('');
      paintLink(r.body.details);
    });
  });
  function linkNote(t) { $('linkNote').textContent = t; show($('linkNote'), !!t); }
  function paintLink(info) {
    link.found = info;
    $('linkTitle').textContent = info.title;
    $('linkMeta').textContent = [info.uploader, info.duration ? fmtClock(info.duration) : '', info.downloadable ? '' : 'cannot be imported'].filter(Boolean).join(' · ');
    show($('linkInfo'), true);
    ['linkStudio', 'linkVideo', 'linkAudio'].forEach(function (id) { $(id).disabled = !info.downloadable; });
    var subs = [{ value: '', label: 'None' }].concat((info.subs || []).map(function (s) { return { value: s.code, label: s.label }; }));
    link.subs = '';
    show($('linkSubsRow'), subs.length > 1);
    buildSeg($('linkSubs'), subs, '', function (v) { link.subs = v; });
    var q = [{ value: 'best', label: 'Best' }, { value: 'compat', label: 'Plays everywhere' }].concat((info.heights || []).filter(function (h) { return [2160, 1440, 1080, 720, 480].indexOf(h) >= 0; }).map(function (h) { return { value: String(h), label: h + 'p' }; }));
    buildSeg($('linkQuality'), q, link.quality, function (v) { link.quality = v; });
    buildSeg($('linkAudioFmt'), [{ value: 'mp3', label: 'MP3' }, { value: 'm4a', label: 'M4A' }, { value: 'opus', label: 'Opus' }], link.audioFmt, function (v) { link.audioFmt = v; });
  }
  function linkImport(mode) {
    if (!link.found) return;
    api('POST', '/api/link/import', { url: link.url, mode: mode, quality: link.quality, audioFormat: link.audioFmt, subs: link.subs }).then(function (r) {
      if (r.status !== 200 || !r.body.id) return linkNote(errOf(r));
      linkNote(mode === 'studio' ? 'Bringing it in. It opens in the studio when it lands.' : 'Saving it. The Save button appears below when it is ready.');
      watchJob({ id: r.body.id, title: link.found.title, kind: 'import', mode: mode, home: true });
      $('linkInput').value = '';
    });
  }
  $('linkStudio').addEventListener('click', function () { linkImport('studio'); });
  $('linkVideo').addEventListener('click', function () { linkImport('video'); });
  $('linkAudio').addEventListener('click', function () { linkImport('audio'); });

  /* ---------------- views ---------------- */

  function goHome() {
    stopLoop();
    try { $('video').pause(); } catch (e) { /* none */ }
    if (window.FLICKER_FOLLOW) window.FLICKER_FOLLOW.leave();
    S.src = null;
    show($('studio'), false); show($('home'), true);
    show($('backBtn'), false); show($('brand'), true); show($('barTitle'), false);
    hideDock();
    paintHomeJobs();
    refreshSources();
    window.scrollTo(0, 0);
  }
  $('backBtn').addEventListener('click', function () { if (history.state === 'studio') history.back(); else goHome(); });
  window.addEventListener('popstate', function () { if (S.src) goHome(); });

  /* ---------------- studio ---------------- */

  var video = $('video'), canvas = $('canvas'), ctx = canvas.getContext('2d');

  function openStudio(id) {
    api('GET', '/api/source/' + id).then(function (r) {
      if (r.status !== 200 || !r.body.ok) { toast(errOf(r)); return refreshSources(); }
      var s = r.body;
      S.src = s; S.song = s.song || null;
      S.a = 0; S.b = Math.min(s.dur, S.state ? S.state.limits.clip : s.dur);
      S.zoom = 1; S.panX = 0.5; S.panY = 0.5; S.playable = false;
      S.jobs = S.jobs.filter(function (j) { return j.src === id; });
      show($('home'), false); show($('studio'), true);
      show($('backBtn'), true); show($('brand'), false); show($('barTitle'), true);
      $('barTitle').textContent = s.name;
      $('srcMeta').textContent = fmtClock(s.dur) + ' · ' + s.w + '×' + s.h + ' · ' + Math.round(s.fps) + ' fps' + (s.audio ? '' : ' · no sound') + (s.captions ? ' · captions: ' + s.captions : '');
      if (history.state !== 'studio') history.pushState('studio', '');
      video.src = '/api/source/' + id + '/video';
      video.load();
      startStrip(id);
      startSongPoll(id);
      $('trimA').max = $('trimB').max = String(s.dur);
      setTool(S.tool === 'follow' ? 'follow' : S.tool, true);
      setTrim(S.a, S.b);
      paintJobs();
      if (S.state) $('keepNote').textContent = 'Renders can be saved for ' + plural(S.state.limits.fileMinutes, 'minute') + ' after they finish.';
      window.scrollTo(0, 0);
      startLoop();
    });
  }

  video.addEventListener('loadeddata', function () { S.playable = true; sizeCanvas(); seek(S.a); });
  video.addEventListener('error', function () { S.playable = false; });
  video.addEventListener('play', paintPlay);
  video.addEventListener('pause', paintPlay);

  function startStrip(id) {
    clearTimeout(S.stripTimer);
    $('strip').style.removeProperty('background-image');
    var tries = 0;
    (function attempt() {
      if (!S.src || S.src.id !== id) return;
      var img = new Image();
      img.onload = function () { if (S.src && S.src.id === id) $('strip').style.setProperty('background-image', 'url(' + img.src + ')'); };
      img.onerror = function () { if (tries++ < 40) S.stripTimer = setTimeout(attempt, 800); };
      img.src = '/api/source/' + id + '/strip?t=' + Date.now();
    })();
  }

  /* ---- canvas stage ---- */

  function outSize() {
    if (S.tool === 'reframe' && S.state) return S.state.reframe.sizes[S.ratio] || [1080, 1920];
    var w = (S.src && S.src.w) || video.videoWidth || 16, h = (S.src && S.src.h) || video.videoHeight || 9;
    return [w, h];
  }
  function sizeCanvas() {
    var wh = outSize(), k = PREVIEW_LONG / Math.max(wh[0], wh[1]);
    canvas.width = Math.max(2, Math.round(wh[0] * k));
    canvas.height = Math.max(2, Math.round(wh[1] * k));
    clampZoom();
    paintZoom();
  }
  function coverFit() {
    var wh = outSize();
    var vw = video.videoWidth || (S.src && S.src.w) || 16, vh = video.videoHeight || (S.src && S.src.h) || 16;
    return { cover: Math.max(wh[0] / vw, wh[1] / vh), fit: Math.min(wh[0] / vw, wh[1] / vh), vw: vw, vh: vh };
  }
  function zoomMin() { var cf = coverFit(); return S.mode === 'crop' ? 1 : cf.fit / cf.cover; }
  function zoomMax() { return (S.state && S.state.reframe.zoomMax) || 2.5; }
  function clampZoom() { S.zoom = clamp(S.zoom || 1, zoomMin(), zoomMax()); }
  // Where the picture lands on a canvas of cw x ch: the same arithmetic as the server's layout().
  function place(cw, ch) {
    var cf = coverFit();
    var k = (cw / outSize()[0]) * cf.cover * S.zoom;
    var dw = cf.vw * k, dh = cf.vh * k;
    if (S.mode === 'crop') { dw = Math.max(dw, cw); dh = Math.max(dh, ch); }
    return { dw: dw, dh: dh, x: (cw - dw) * S.panX, y: (ch - dh) * S.panY };
  }

  function draw() {
    var cw = canvas.width, ch = canvas.height;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.filter = 'none';
    ctx.clearRect(0, 0, cw, ch);
    var vw = video.videoWidth, vh = video.videoHeight;
    if (!vw || !vh || !S.playable) { ctx.fillStyle = '#0b0908'; ctx.fillRect(0, 0, cw, ch); return; }
    if (S.tool === 'reframe') {
      if (S.mode === 'blur') {
        var kb = Math.max(cw / vw, ch / vh), bw = vw * kb, bh = vh * kb;
        ctx.filter = 'blur(' + Math.max(1, 24 * (cw / outSize()[0])).toFixed(1) + 'px)';
        ctx.drawImage(video, -(bw - cw) / 2, -(bh - ch) / 2, bw, bh);
        ctx.filter = 'none';
      } else {
        var col = '#000000';
        if (S.mode === 'pad') S.state.reframe.colors.forEach(function (c) { if (c.id === S.color) col = c.hex; });
        ctx.fillStyle = col;
        ctx.fillRect(0, 0, cw, ch);
      }
      var p = place(cw, ch);
      ctx.drawImage(video, p.x, p.y, p.dw, p.dh);
    } else {
      ctx.drawImage(video, 0, 0, cw, ch);
    }
    if (wordsOn()) drawWordsSample(cw, ch);
  }

  // A sample line where burned in words will sit: same font, colour and edge the renderer uses
  // (libass sizes text against a 288 line frame, so 19 points is 19/288 of the height).
  function drawWordsSample(cw, ch) {
    var so = S.state && S.state.styles, st = S.style;
    if (!so || !st) return;
    var pick = function (list, id) { for (var i = 0; i < list.length; i++) if (list[i].id === id) return list[i]; return list[0]; };
    var font = pick(so.fonts, st.font), color = pick(so.colors, st.color), look = pick(so.looks, st.look);
    var gif = S.tool === 'gif';
    var px = Math.max(10, ch * ((gif ? 24 : 19) + (st.font === 'impact' ? 2 : 0)) / 288);
    var text = S.words === 'typed' && S.typed.trim() ? S.typed.trim().split(/\r?\n/)[0].slice(0, 60) : 'Your words appear here';
    ctx.save();
    ctx.font = (font.weight >= 700 ? 'bold ' : '') + px.toFixed(1) + 'px ' + font.css;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'alphabetic';
    var x = cw / 2, y = ch - ch * (gif ? 14 : 20) / 288;
    var edge = color.dark ? so.cream : so.ink;
    if (look.id === 'box') {
      var w = ctx.measureText(text).width + px * 0.8;
      ctx.fillStyle = color.dark ? 'rgba(244,238,230,.62)' : 'rgba(0,0,0,.58)';
      ctx.fillRect(x - w / 2, y - px * 1.05, w, px * 1.4);
    } else if (look.id === 'shadow') {
      ctx.fillStyle = color.dark ? 'rgba(244,238,230,.75)' : 'rgba(0,0,0,.72)';
      ctx.fillText(text, x + px * 0.12, y + px * 0.12);
    }
    if (look.id !== 'box') { ctx.lineWidth = Math.max(1.5, px * 0.14); ctx.lineJoin = 'round'; ctx.strokeStyle = edge; ctx.strokeText(text, x, y); }
    ctx.fillStyle = color.hex;
    ctx.fillText(text, x, y);
    ctx.restore();
  }

  function tick() {
    S.raf = 0;
    if (!S.src || $('studio').hidden) return;
    var now = video.currentTime || 0;
    if (!video.paused && (now >= S.b - 0.05 || now < S.a - 0.3)) seek(S.a);
    if (S.tool !== 'follow' || !window.FLICKER_FOLLOW || !window.FLICKER_FOLLOW.ownsStage()) draw();
    $('timeNow').textContent = fmtClock(now);
    $('head').style.setProperty('left', (clamp(now / (S.src.dur || 1), 0, 1) * 100) + '%');
    S.raf = requestAnimationFrame(tick);
  }
  function startLoop() { if (!S.raf) S.raf = requestAnimationFrame(tick); }
  function stopLoop() { if (S.raf) cancelAnimationFrame(S.raf); S.raf = 0; }
  function seek(sec) { if (!S.src) return; try { video.currentTime = clamp(sec, 0, S.src.dur || 0); } catch (e) { /* not ready yet */ } }
  function paintPlay() {
    $('playIco').textContent = '';
    var p = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    p.setAttribute('d', video.paused ? 'M8 5v14l11-7z' : 'M7 5h4v14H7zM13 5h4v14h-4z');
    $('playIco').appendChild(p);
    $('playBtn').setAttribute('aria-label', video.paused ? 'Play' : 'Pause');
  }
  $('playBtn').addEventListener('click', function () {
    if (!S.src || !S.playable) return;
    if (video.paused) {
      if (video.currentTime >= S.b - 0.05 || video.currentTime < S.a) seek(S.a);
      var p = video.play(); if (p && p.catch) p.catch(function () { /* the button still works next time */ });
    } else video.pause();
  });

  /* ---- drag to move, pinch or scroll to zoom (reframe) ---- */

  function paintZoom() {
    var lo = zoomMin(), hi = zoomMax();
    $('rfZoom').value = String(Math.round(100 * Math.log(S.zoom / lo) / Math.log(hi / lo)) || 0);
    $('rfZoomVal').textContent = Math.round(S.zoom * 100) + '%';
    show($('rfFit'), S.mode !== 'crop');
  }
  function setZoom(z, keep) {
    var cw = canvas.width, ch = canvas.height;
    var before = place(cw, ch);
    var px = keep ? keep.x : cw / 2, py = keep ? keep.y : ch / 2;
    var u = before.dw > 0 ? (px - before.x) / before.dw : 0.5, w = before.dh > 0 ? (py - before.y) / before.dh : 0.5;
    S.zoom = clamp(z, zoomMin(), zoomMax());
    var after = place(cw, ch);
    if (Math.abs(cw - after.dw) > 1) S.panX = clamp((px - u * after.dw) / (cw - after.dw), 0, 1);
    if (Math.abs(ch - after.dh) > 1) S.panY = clamp((py - w * after.dh) / (ch - after.dh), 0, 1);
    paintZoom();
  }
  $('rfZoom').addEventListener('input', function () { var lo = zoomMin(); setZoom(lo * Math.pow(zoomMax() / lo, clamp(Number(this.value) || 0, 0, 100) / 100)); });
  $('rfFit').addEventListener('click', function () { S.panX = 0.5; S.panY = 0.5; setZoom(zoomMin()); });
  $('rfFill').addEventListener('click', function () { setZoom(1); });
  $('rfCenter').addEventListener('click', function () { S.panX = 0.5; S.panY = 0.5; });
  canvas.addEventListener('wheel', function (e) {
    if (!S.src || S.tool !== 'reframe') return;
    e.preventDefault();
    var box = canvas.getBoundingClientRect(), sc = canvas.width / (box.width || 1);
    setZoom(S.zoom * Math.exp(-e.deltaY * 0.0015), { x: (e.clientX - box.left) * sc, y: (e.clientY - box.top) * sc });
  }, { passive: false });
  (function wirePan() {
    var pointers = {}, pinchDist = 0, pinchZoom = 1, dragging = false;
    var toCanvas = function (e) { var box = canvas.getBoundingClientRect(), s = canvas.width / (box.width || 1); return { x: (e.clientX - box.left) * s, y: (e.clientY - box.top) * s }; };
    var count = function () { return Object.keys(pointers).length; };
    canvas.addEventListener('pointerdown', function (e) {
      if (!S.src || S.tool !== 'reframe') return;
      pointers[e.pointerId] = toCanvas(e);
      try { canvas.setPointerCapture(e.pointerId); } catch (err) { /* fine */ }
      if (count() === 2) { var ids = Object.keys(pointers), a = pointers[ids[0]], b = pointers[ids[1]]; pinchDist = Math.hypot(a.x - b.x, a.y - b.y) || 1; pinchZoom = S.zoom; }
      dragging = true; $('stage').classList.add('panning'); e.preventDefault();
    });
    canvas.addEventListener('pointermove', function (e) {
      if (!dragging || !pointers[e.pointerId]) return;
      var now = toCanvas(e), was = pointers[e.pointerId];
      pointers[e.pointerId] = now;
      var cw = canvas.width, ch = canvas.height;
      if (count() >= 2) {
        var ids = Object.keys(pointers), a = pointers[ids[0]], b = pointers[ids[1]];
        setZoom(pinchZoom * ((Math.hypot(a.x - b.x, a.y - b.y) || 1) / pinchDist), { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
      } else {
        var p = place(cw, ch);
        if (Math.abs(cw - p.dw) > 1) S.panX = clamp(S.panX + (now.x - was.x) / (cw - p.dw), 0, 1);
        if (Math.abs(ch - p.dh) > 1) S.panY = clamp(S.panY + (now.y - was.y) / (ch - p.dh), 0, 1);
      }
    });
    var end = function (e) {
      delete pointers[e.pointerId];
      try { canvas.releasePointerCapture(e.pointerId); } catch (err) { /* fine */ }
      if (!count()) { dragging = false; $('stage').classList.remove('panning'); }
    };
    canvas.addEventListener('pointerup', end);
    canvas.addEventListener('pointercancel', end);
  })();

  /* ---- trim ---- */

  function maxLen() {
    if (!S.state) return 600;
    var L = S.state.limits;
    return S.tool === 'gif' ? L.gif : S.tool === 'follow' ? L.follow : L.clip;
  }
  function setTrim(a, b, moved) {
    if (!S.src) return;
    var dur = S.src.dur, mx = maxLen();
    a = tenth(a); b = tenth(b);
    if (!isFinite(a)) a = S.a;
    if (!isFinite(b)) b = S.b;
    a = clamp(a, 0, Math.max(0, dur - MIN_LEN));
    b = clamp(b, Math.min(dur, MIN_LEN), dur);
    if (b - a < MIN_LEN) { if (moved === 'a') b = Math.min(dur, a + MIN_LEN); else a = Math.max(0, b - MIN_LEN); }
    if (b - a > mx) { if (moved === 'a') b = tenth(a + mx); else a = tenth(b - mx); }
    S.a = a; S.b = Math.min(dur, b);
    $('trimA').value = String(S.a); $('trimB').value = String(S.b);
    $('shadeA').style.setProperty('width', (S.a / dur * 100) + '%');
    $('shadeB').style.setProperty('width', ((dur - S.b) / dur * 100) + '%');
    if (document.activeElement !== $('inA')) $('inA').value = fmtClock(S.a);
    if (document.activeElement !== $('inB')) $('inB').value = fmtClock(S.b);
    $('lenOut').textContent = fmtLen(S.b - S.a);
    paintToolNotes();
    if (window.FLICKER_FOLLOW) window.FLICKER_FOLLOW.onRange();
  }
  $('trimA').addEventListener('input', function () { setTrim(this.value, S.b, 'a'); seek(S.a); });
  $('trimB').addEventListener('input', function () { setTrim(S.a, this.value, 'b'); seek(Math.max(S.a, S.b - 0.1)); });
  [['inA', 'a'], ['inB', 'b']].forEach(function (pair) {
    var el = $(pair[0]);
    var commit = function () { var v = parseT(el.value); if (pair[1] === 'a') setTrim(v, S.b, 'a'); else setTrim(S.a, v, 'b'); el.value = fmtClock(pair[1] === 'a' ? S.a : S.b); };
    el.addEventListener('change', commit);
    el.addEventListener('keydown', function (ev) { if (ev.key === 'Enter') { ev.preventDefault(); el.blur(); commit(); } });
  });
  $('setIn').addEventListener('click', function () { setTrim(video.currentTime || 0, S.b, 'a'); });
  $('setOut').addEventListener('click', function () { setTrim(S.a, video.currentTime || 0, 'b'); });
  $('strip').addEventListener('pointerdown', function (e) {
    if (!S.src) return;
    var box = $('strip').getBoundingClientRect();
    seek(clamp((e.clientX - box.left) / (box.width || 1), 0, 1) * S.src.dur);
  });

  /* ---- tools ---- */

  function setTool(tool, quiet) {
    S.tool = tool;
    Array.prototype.forEach.call(document.querySelectorAll('.tab'), function (t) { t.setAttribute('aria-selected', t.getAttribute('data-tool') === tool ? 'true' : 'false'); });
    show($('pCut'), tool === 'cut'); show($('pGif'), tool === 'gif'); show($('pReframe'), tool === 'reframe'); show($('pFollow'), tool === 'follow');
    paintWords();
    if (S.src) { sizeCanvas(); setTrim(S.a, S.b); }
    if (window.FLICKER_FOLLOW) window.FLICKER_FOLLOW.onTool(tool === 'follow');
    if (tool !== 'follow') { S.dockOwner = 'app'; paintDock(); }
    if (!quiet) paintToolNotes();
  }
  Array.prototype.forEach.call(document.querySelectorAll('.tab'), function (t) { t.addEventListener('click', function () { setTool(t.getAttribute('data-tool')); }); });

  function buildToolPickers() {
    buildSeg($('cutOut'), [{ value: 'video', label: 'Video' }, { value: 'audio', label: 'Audio only' }], S.cutOut, function (v) { S.cutOut = v; show($('cutFmtRow'), v === 'audio'); paintWords(); paintToolNotes(); paintDock(); });
    buildSeg($('cutFmt'), [{ value: 'mp3', label: 'MP3' }, { value: 'm4a', label: 'M4A' }, { value: 'opus', label: 'Opus' }], S.audioFmt, function (v) { S.audioFmt = v; paintToolNotes(); });
    buildSeg($('gifW'), (S.state ? S.state.gifWidths : [320, 480, 640]).map(function (w) { return { value: w, label: w + ' px' }; }), S.gifW, function (v) { S.gifW = Number(v); });
    var sizes = S.state ? Object.keys(S.state.reframe.sizes) : ['9:16'];
    var ratioName = { '9:16': '9:16 tall', '4:5': '4:5', '1:1': '1:1 square', '3:4': '3:4', '16:9': '16:9 wide' };
    buildSeg($('rfRatio'), sizes.map(function (k) { return { value: k, label: ratioName[k] || k }; }), S.ratio, function (v) { var floor = Math.abs(S.zoom - zoomMin()) < 1e-6; S.ratio = v; sizeCanvas(); if (floor) S.zoom = zoomMin(); paintZoom(); });
    buildSeg($('rfMode'), [{ value: 'crop', label: 'Crop to fill' }, { value: 'blur', label: 'Blurred' }, { value: 'pad', label: 'Solid colour' }], S.mode, function (v) {
      var floor = Math.abs(S.zoom - zoomMin()) < 1e-6;
      S.mode = v; show($('rfColorRow'), v === 'pad');
      if (floor || v === 'crop') S.zoom = zoomMin();
      if (v !== 'crop' && floor) { S.panX = 0.5; S.panY = 0.5; }
      clampZoom(); paintZoom();
    });
    buildSeg($('rfColor'), (S.state ? S.state.reframe.colors : []).map(function (c) { return { value: c.id, label: c.label, swatch: c.hex }; }), S.color, function (v) { S.color = v; });
    show($('cutFmtRow'), S.cutOut === 'audio');
    show($('rfColorRow'), S.mode === 'pad');
  }

  function paintToolNotes() {
    if (!S.state || !S.src) return;
    var len = S.b - S.a, L = S.state.limits;
    $('cutNote').textContent = S.cutOut === 'audio' ? 'The sound of the range above, as ' + S.audioFmt.toUpperCase() + '.' : 'An exact cut of the range above, as an MP4 that plays everywhere.';
    $('gifNote').textContent = 'GIFs run up to ' + fmtLen(L.gif) + '. They loop, and have no sound.' + (len > L.gif ? ' Shorten the range.' : '');
    if (S.dockOwner === 'app') paintDock();
  }

  /* ---- words ---- */

  function wordsAllowed() { return S.tool === 'gif' || S.tool === 'reframe' || (S.tool === 'cut' && S.cutOut === 'video'); }
  function wordsOn() { return wordsAllowed() && !!S.words && S.tool !== 'follow'; }

  function paintWords() {
    var p = $('pWords');
    var allowed = wordsAllowed() && !!S.src && !!S.state;
    show(p, allowed);
    if (!allowed) return;
    var e = S.state.engines, so = S.state.styles;
    if (!S.style) {
      var saved = {};
      try { saved = JSON.parse(store('flicker_style') || '{}') || {}; } catch (err) { saved = {}; }
      var has = function (list, id) { return list.some(function (x) { return x.id === id; }); };
      S.style = { look: has(so.looks, saved.look) ? saved.look : so.defaults.look, font: has(so.fonts, saved.font) ? saved.font : so.defaults.font, color: has(so.colors, saved.color) ? saved.color : so.defaults.color };
    }
    var burn = e.ffmpeg.burn, listen = e.listen.ok && S.src.audio, lyricsReady = !!(S.song && S.song.lyrics);
    var opts = [{ value: '', label: 'Off' }, { value: 'typed', label: 'Type them', disabled: !burn }];
    opts.push({ value: 'listen', label: 'Heard', disabled: !burn || !listen, title: listen ? '' : 'Needs speech to text' });
    opts.push({ value: 'lyrics', label: 'Lyrics', disabled: !burn || !listen || !e.lyrics.ok, title: 'Published lyrics, timed by listening' });
    if (S.src.captions) opts.push({ value: 'captions', label: 'Captions', disabled: !burn });
    if (opts.some(function (o) { return o.value === S.words && o.disabled; })) S.words = '';
    if (S.words === 'captions' && !S.src.captions) S.words = '';
    buildSeg($('wordsMode'), opts, S.words, function (v) { S.words = v; paintWordsDetail(); });
    buildSeg($('wLook'), so.looks.map(function (x) { return { value: x.id, label: x.label }; }), S.style.look, function (v) { S.style.look = v; store('flicker_style', JSON.stringify(S.style)); });
    buildSeg($('wFont'), so.fonts.map(function (x) { return { value: x.id, label: x.label, font: x.css, weight: x.weight }; }), S.style.font, function (v) { S.style.font = v; store('flicker_style', JSON.stringify(S.style)); });
    buildSeg($('wColor'), so.colors.map(function (x) { return { value: x.id, label: x.label, swatch: x.hex }; }), S.style.color, function (v) { S.style.color = v; store('flicker_style', JSON.stringify(S.style)); });
    paintWordsDetail();
  }

  function paintWordsDetail() {
    var e = S.state.engines, len = S.b - S.a;
    show($('typedRow'), S.words === 'typed');
    show($('styleRows'), !!S.words);
    var note = '';
    if (!e.ffmpeg.burn) note = 'This ffmpeg cannot burn in text. See Engines in the menu.';
    else if (S.words === 'typed') note = 'Each line becomes one caption. One line stays up for the whole clip.';
    else if (S.words === 'listen') note = len > S.state.limits.listen ? 'Heard words work on clips up to ' + fmtLen(S.state.limits.listen) + '. Shorten the range.' : 'Flicker listens to the range on this machine and writes down what it hears.';
    else if (S.words === 'lyrics') note = 'The published lyrics, shown when they are sung. If they do not match what is heard, the heard words are used instead.';
    else if (S.words === 'captions') note = 'The captions that came with the link, cut to this range.';
    else if (!e.listen.ok) note = 'Heard words and lyrics need speech to text, which is not set up. See Engines in the menu.';
    else if (!S.src.audio) note = 'This video has no sound, so only typed words can be added.';
    $('wordsNote').textContent = note;
    paintSong();
    if (S.dockOwner === 'app') paintDock();
  }

  function startSongPoll(id) {
    clearTimeout(S.songTimer);
    var tries = 0;
    (function attempt() {
      if (!S.src || S.src.id !== id || !S.src.audio) return;
      api('GET', '/api/source/' + id + '/song').then(function (r) {
        if (!S.src || S.src.id !== id) return;
        if (r.status === 200 && r.body) { S.song = r.body; paintSong(); }
        if (r.status === 200 && r.body && r.body.state === 'hunting' && tries++ < 60) S.songTimer = setTimeout(attempt, 1500);
      });
    })();
  }
  function paintSong() {
    var on = S.words === 'lyrics';
    show($('songRow'), on);
    if (!on) return;
    var g = S.song || { state: 'hunting' };
    $('songLine').textContent = g.state === 'hunting' ? 'Working out what song this is.'
      : g.state === 'found' ? g.artist + ', ' + g.track + '. Lyrics ready.'
      : g.state === 'named' ? g.artist + ', ' + g.track + ', but no lyrics turned up. Try another spelling.'
      : 'Could not name this song. Type the artist and title to fetch the lyrics.';
    if (g.artist && !$('songArtist').value && !$('songTrack').value) { $('songArtist').value = g.artist; $('songTrack').value = g.track; }
  }
  $('songFind').addEventListener('click', function () {
    if (!S.src) return;
    var body = { artist: $('songArtist').value.trim(), track: $('songTrack').value.trim() };
    if (body.artist.length < 2 || body.track.length < 2) { $('songLine').textContent = 'Type both the artist and the song title.'; return; }
    $('songFind').disabled = true;
    $('songLine').textContent = 'Looking the lyrics up.';
    api('POST', '/api/source/' + S.src.id + '/song', body).then(function (r) {
      $('songFind').disabled = false;
      if (r.status !== 200 || !r.body.state) { $('songLine').textContent = errOf(r); return; }
      S.song = r.body; paintSong();
    });
  });
  $('typedText').addEventListener('input', function () { S.typed = this.value; if (S.dockOwner === 'app') paintDock(); });

  /* ---- render ---- */

  function goLabel() {
    if (S.tool === 'gif') return 'Make the GIF';
    if (S.tool === 'reframe') return 'Render ' + S.ratio;
    return S.cutOut === 'audio' ? 'Save the audio' : 'Render the clip';
  }
  function renderBlock() {
    if (!S.state || !S.src) return 'Loading.';
    if (!S.state.engines.ffmpeg.ok) return 'ffmpeg was not found.';
    var len = S.b - S.a;
    if (S.tool === 'gif' && len > S.state.limits.gif + 0.05) return 'GIFs run up to ' + fmtLen(S.state.limits.gif) + '.';
    if (S.tool === 'cut' && S.cutOut === 'audio' && !S.src.audio) return 'This video has no sound.';
    if (wordsOn() && S.words === 'typed' && !S.typed.trim()) return 'Type some words, or turn words off.';
    if (wordsOn() && (S.words === 'listen' || S.words === 'lyrics') && len > S.state.limits.listen + 0.05) return 'Heard words work on clips up to ' + fmtLen(S.state.limits.listen) + '.';
    if (wordsOn() && S.words === 'lyrics' && !(S.song && S.song.lyrics)) return 'Name the song first, so the lyrics can be found.';
    return '';
  }
  function paintDock() {
    if (!S.src || S.tool === 'follow') return;
    var own = function (j) { return j.src === S.src.id && j.kind !== 'follow' && j.kind !== 'followrender'; };
    var active = S.jobs.filter(function (j) { return own(j) && (j.state === 'queued' || j.state === 'running'); })[0];
    if (active) return dock({ msg: active.msg || 'Working on it.', pct: active.pct || 0, alt: { label: 'Cancel', fn: function () { api('POST', '/api/job/' + active.id + '/cancel'); } } });
    var last = S.jobs.filter(function (j) { return own(j) && j.state === 'ready' && !j.seen; })[0];
    var block = renderBlock();
    if (last) return dock({ save: { href: '/api/job/' + last.id + '/file', label: 'Save ' + (last.ext ? last.ext.toUpperCase() : 'file') }, alt: { label: 'Again', fn: function () { last.seen = true; paintDock(); } }, msg: last.name });
    dock({ go: { label: goLabel(), disabled: !!block, fn: render }, msg: block || '' });
  }

  function render() {
    if (!S.src || renderBlock()) return;
    var body = { tool: S.tool, start: S.a, end: S.b };
    if (S.tool === 'cut') { body.output = S.cutOut; body.audioFormat = S.audioFmt; }
    if (S.tool === 'gif') body.gifWidth = S.gifW;
    if (S.tool === 'reframe') { body.ratio = S.ratio; body.mode = S.mode; body.color = S.color; body.panX = S.panX; body.panY = S.panY; body.zoom = S.zoom; }
    if (wordsOn()) body.words = { mode: S.words, text: S.typed, style: S.style };
    try { video.pause(); } catch (e) { /* none */ }
    $('dockGo').disabled = true;
    api('POST', '/api/source/' + S.src.id + '/render', body).then(function (r) {
      if (r.status !== 200 || !r.body.id) { toast(errOf(r)); paintDock(); return; }
      watchJob({ id: r.body.id, title: S.src.name, kind: S.tool, src: S.src.id });
    });
  }

  /* ---- jobs ---- */

  var STAGE = { listening: 'Listening for the words', rendering: 'Rendering', cutting: 'Cutting the clip', frames: 'Getting frames ready', merging: 'Putting it together', opening: 'Opening it in the studio' };
  function watchJob(j) {
    j.state = 'queued'; j.pct = 0; j.msg = 'Waiting for a free slot.';
    if (j.home) S.homeJobs.unshift(j); else S.jobs.unshift(j);
    paintJobs(); paintHomeJobs();
    if (!j.home && S.dockOwner === 'app') paintDock();
    if (!S.polling) poll();
    return j;
  }
  function poll() {
    var active = S.jobs.concat(S.homeJobs).filter(function (j) { return j.state === 'queued' || j.state === 'running'; });
    if (!active.length) { S.polling = 0; return; }
    S.polling = 1;
    Promise.all(active.map(function (j) {
      return api('GET', '/api/job/' + j.id).then(function (r) {
        var v = r.body || {};
        if (r.status === 404) { j.state = 'error'; j.msg = 'That render expired.'; return; }
        if (!v.state) return;
        j.state = v.state; j.name = v.name; j.ext = v.ext; j.size = v.size;
        j.pct = v.state === 'queued' ? 2 : v.percent || 0;
        j.msg = v.state === 'queued' ? (v.position > 1 ? 'Number ' + v.position + ' in line.' : 'Next in line.')
          : v.state === 'running' ? (STAGE[v.stage] || (j.kind === 'import' ? 'Downloading' : 'Working')) + (v.percent ? ', ' + Math.round(v.percent) + '%' : '') + (v.speed ? ', ' + v.speed : '')
          : v.state === 'ready' ? 'Ready' + (v.subs === 'missing' ? ', but no words were found in that range' : '') + '.'
          : v.error || 'Did not work.';
        if (v.state === 'ready' && v.source && !j.opened) { j.opened = true; toast('It landed. Opening it in the studio.'); refreshSources(); openStudio(v.source); }
        if (v.state === 'ready' && j.onReady) j.onReady(v);
        if ((v.state === 'error' || v.state === 'cancelled') && j.onFail) j.onFail(v);
        if (j.onTick) j.onTick(v);
      });
    })).then(function () {
      paintJobs(); paintHomeJobs();
      if (S.dockOwner === 'app') paintDock();
      setTimeout(poll, 700);
    });
  }
  function jobRow(j) {
    var li = document.createElement('li');
    li.className = 'job' + (j.state === 'error' || j.state === 'cancelled' ? ' error' : '');
    var top = document.createElement('div'); top.className = 'job-top';
    var nm = document.createElement('span'); nm.className = 'job-name'; nm.textContent = j.name || j.title || 'Render';
    var st = document.createElement('span'); st.className = 'job-state'; st.textContent = j.state === 'ready' ? (j.size ? fmtBytes(j.size) : 'ready') : j.state === 'error' ? 'failed' : j.state;
    top.appendChild(nm); top.appendChild(st); li.appendChild(top);
    if (j.state === 'queued' || j.state === 'running') {
      var m = document.createElement('span'); m.className = 'meter'; var i = document.createElement('i'); i.style.setProperty('width', clamp(j.pct || 0, 0, 100) + '%'); m.appendChild(i); li.appendChild(m);
      var p = document.createElement('p'); p.className = 'fine'; p.textContent = j.msg || ''; li.appendChild(p);
    } else if (j.state === 'ready' && j.kind !== 'follow' && !j.opened) {
      var act = document.createElement('div'); act.className = 'job-actions';
      var a = document.createElement('a'); a.className = 'btn sm primary'; a.href = '/api/job/' + j.id + '/file'; a.setAttribute('download', ''); a.textContent = 'Save';
      var pv = document.createElement('a'); pv.className = 'btn sm ghost'; pv.href = '/api/job/' + j.id + '/preview'; pv.target = '_blank'; pv.rel = 'noopener'; pv.textContent = 'Preview';
      act.appendChild(a); act.appendChild(pv); li.appendChild(act);
      if (j.msg && j.msg !== 'Ready.') { var n = document.createElement('p'); n.className = 'fine'; n.textContent = j.msg; li.appendChild(n); }
    } else if (j.state !== 'ready') {
      var e = document.createElement('p'); e.className = 'fine err'; e.textContent = j.msg || ''; li.appendChild(e);
    } else {
      return null;
    }
    return li;
  }
  function paintJobs() {
    var ul = $('jobList'); ul.textContent = '';
    var mine = S.src ? S.jobs.filter(function (j) { return j.src === S.src.id && j.kind !== 'follow'; }) : [];
    mine.forEach(function (j) { var r = jobRow(j); if (r) ul.appendChild(r); });
    show($('jobsSec'), ul.children.length > 0);
  }
  function paintHomeJobs() {
    var ul = $('homeJobs'); ul.textContent = '';
    S.homeJobs.forEach(function (j) { var r = jobRow(j); if (r) ul.appendChild(r); });
    show($('homeJobsSec'), ul.children.length > 0);
  }

  /* ---------------- boot ---------------- */

  window.addEventListener('resize', function () { if (S.src) sizeCanvas(); });
  loadState().then(function () { buildToolPickers(); refreshSources(); });

  // What follow.js needs from the page.
  window.FLICKER_APP = {
    api: api, errOf: errOf, buildSeg: buildSeg, show: show, fmtClock: fmtClock, fmtLen: fmtLen, toast: toast, store: store, clamp: clamp,
    dock: dock, watchJob: watchJob, recheck: recheck,
    state: function () { return S.state; }, src: function () { return S.src; }, range: function () { return { a: S.a, b: S.b }; },
    video: function () { return video; }, tool: function () { return S.tool; },
    takeDock: function () { S.dockOwner = 'follow'; }, giveDock: function () { S.dockOwner = 'app'; paintDock(); },
    showMainStage: function (on) { show($('stage'), on); show($('transport'), on); show($('trim'), on); show($('rangeRow'), on); if (on) sizeCanvas(); },
  };
})();
