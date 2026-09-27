/* Flicker text follow: five plain steps.
     1 Clip    pick the stretch on the trim rail (up to the follow limit)
     2 Mark    pause, tap the thing to follow; a glow shows what was picked
     3 Track   Flicker follows it through the clip; play it back, fix any moment it lost it
     4 Text    type what should ride on it, pick where and how it looks
     5 Render  save a video or a GIF
   The preview draws the text with tagmotion.js, the same code the server burns with, so what you
   see is what you get. No inline styles (CSP); typed text only ever goes in via textContent. */

(function () {
  'use strict';

  var APP = window.FLICKER_APP;
  var TM = window.FLICKER_TAGMOTION;
  if (!APP || !TM) return;
  var $ = function (id) { return document.getElementById(id); };
  var show = APP.show;

  var MAX_POINTS = 8, MAX_PROMPTS = 6;
  var STEP_TEXT = {
    1: ['Pick the clip', 'Set the start and end on the rail above. Pick a stretch where the thing you want to follow is easy to see.'],
    2: ['Mark the thing to follow', 'Pause on a frame where it is clearly visible, then tap it. A glow shows what Flicker picked. Tap more of it if a part is missing, or switch the tap to Take away to remove a part it got wrong.'],
    3: ['Preview the track', 'Flicker follows what you marked through the clip. Play it back: the placeholder label should stay on it. If it wanders off, tap Fix on that moment.'],
    4: ['Type the text', 'Type what should ride on each marked thing, then choose where it sits and how it looks. The preview shows exactly what will be burned in.'],
    5: ['Render', 'Pick video or GIF and render. The text is burned into the picture.'],
  };

  var F = {
    on: false, available: false, step: 1, srcId: '',
    job: null, sess: null, preparing: false,
    things: [], active: -1, tapMode: 'add',
    tracks: null, lostRaw: null, trackedSig: '', tracking: false, trackPoll: 0,
    look: { look: 'box', font: 'arial', size: 'm', pointer: true }, kind: 'video',
    render: null, layoutCache: null, raf: 0, segSeq: 0,
  };
  var fv = $('fvideo'), fc = $('fcanvas');

  /* ---------------- plumbing from the page ---------------- */

  function onState(state) {
    F.available = !!(state && state.engines.follow.ok);
    $('fSetupHelp').textContent = state ? state.engines.follow.help : '';
    paintTab();
    if (F.on) paint();
  }
  function paintTab() {
    var tab = document.querySelector('.tab[data-tool="follow"]');
    if (!tab) return;
    var dot = tab.querySelector('.dot');
    if (!F.available && !dot) { dot = document.createElement('span'); dot.className = 'dot'; dot.setAttribute('aria-hidden', 'true'); tab.appendChild(dot); tab.title = 'Needs setup'; }
    if (F.available && dot) { dot.remove(); tab.title = ''; }
  }

  function onTool(on) {
    var src = APP.src();
    if (src && src.id !== F.srcId) reset(src.id);
    F.on = on;
    if (!on) {
      try { fv.pause(); } catch (e) { /* none */ }
      stopLoop();
      APP.showMainStage(true);
      show($('fstage'), false);
      return;
    }
    APP.takeDock();
    paint();
  }
  function onRange() { if (F.on && F.step === 1) paint(); }
  function ownsStage() { return F.on && F.step >= 2 && !!F.sess; }
  function leave() { reset(''); F.on = false; stopLoop(); show($('fstage'), false); APP.showMainStage(true); }

  function reset(srcId) {
    clearTimeout(F.trackPoll);
    try { fv.pause(); } catch (e) { /* none */ }
    fv.removeAttribute('src');
    try { fv.load(); } catch (e) { /* none */ }
    F.srcId = srcId || ''; F.step = 1; F.job = null; F.sess = null; F.preparing = false;
    F.things = []; F.active = -1; F.tapMode = 'add';
    F.tracks = null; F.lostRaw = null; F.trackedSig = ''; F.tracking = false;
    F.render = null; F.layoutCache = null;
    $('fErr').textContent = ''; show($('fErr'), false);
  }

  function err(t) { $('fErr').textContent = t || ''; show($('fErr'), !!t); }
  function meter(pct) {
    show($('fMeter'), typeof pct === 'number');
    if (typeof pct === 'number') $('fFill').style.setProperty('width', APP.clamp(pct, 0, 100) + '%');
  }

  /* ---------------- painting the steps ---------------- */

  function maxStepReached() {
    if (!F.sess) return 1;
    if (!tracked()) return 2;
    if (!named()) return 4;
    return 5;
  }

  function paint() {
    if (!F.on) return;
    show($('fSetup'), !F.available);
    show($('fFlow'), F.available);
    if (!F.available) {
      APP.showMainStage(true); show($('fstage'), false);
      APP.dock({ go: { label: 'Text follow needs setup', disabled: true, fn: null }, alt: { label: 'Engines', fn: function () { $('menuBtn').click(); } } });
      return;
    }
    Array.prototype.forEach.call($('fSteps').children, function (li) {
      var n = Number(li.getAttribute('data-step'));
      li.className = n === F.step ? 'now' : n < maxStepReached() + 1 && canJump(n) && !(n === 1 && !F.sess) ? 'done' : '';
      li.setAttribute('aria-current', n === F.step ? 'step' : 'false');
    });
    $('fHead').textContent = F.step + '. ' + STEP_TEXT[F.step][0];
    $('fHint').textContent = STEP_TEXT[F.step][1];

    var stageOwned = F.step >= 2 && !!F.sess;
    APP.showMainStage(!stageOwned);
    show($('fstage'), stageOwned);
    show($('fMark'), F.step === 2 && !!F.sess);
    show($('fTrack'), F.step >= 3 && tracked());
    show($('fLost'), F.step === 3);
    show($('fText'), F.step === 4);
    show($('fRender'), F.step === 5);
    if (stageOwned) { sizeStage(); startLoop(); } else stopLoop();
    if (F.step !== 1 || !F.preparing) meter(F.tracking ? (F.trackPct || 0) : null);

    if (F.step === 1) paintStep1();
    if (F.step === 2) paintStep2();
    if (F.step === 3) paintStep3();
    if (F.step === 4) paintStep4();
    if (F.step === 5) paintStep5();
  }
  function canJump(n) { return n === 1 || (n === 2 && !!F.sess) || (n === 3 && tracked()) || (n === 4 && tracked()) || (n === 5 && tracked() && named()); }
  $('fSteps').addEventListener('click', function (ev) {
    var li = ev.target.closest('li');
    if (!li || F.tracking) return;
    var n = Number(li.getAttribute('data-step'));
    if (n !== F.step && canJump(n)) go(n);
  });
  function go(n) { F.step = n; err(''); paint(); if (n === 3 && !tracked()) startTrack(); }

  /* ---- step 1: the clip ---- */

  function paintStep1() {
    var r = APP.range(), st = APP.state(), max = st ? st.limits.follow : 60;
    var len = r.b - r.a;
    if (F.preparing) {
      APP.dock({ msg: F.prepMsg || 'Getting the clip ready.', pct: F.prepPct || 0, alt: { label: 'Cancel', fn: cancelPrep } });
      return;
    }
    var tooLong = len > max + 0.05;
    $('fHint').textContent = STEP_TEXT[1][1] + ' Text follow takes up to ' + APP.fmtLen(max) + '.';
    var sameAsSession = F.sess && Math.abs(F.sess.a - r.a) < 0.05 && Math.abs(F.sess.b - r.b) < 0.05;
    APP.dock({
      go: { label: sameAsSession ? 'Next: mark it' : 'Use this clip (' + APP.fmtLen(len) + ')', disabled: tooLong, fn: sameAsSession ? function () { go(2); } : prepare },
      msg: tooLong ? 'Shorten the range to ' + APP.fmtLen(max) + ' or less.' : '',
    });
  }

  function prepare() {
    var src = APP.src(), r = APP.range();
    if (!src) return;
    err('');
    F.preparing = true; F.prepPct = 0; F.prepMsg = 'Waiting for a free slot.';
    paint();
    APP.api('POST', '/api/source/' + src.id + '/follow', { start: r.a, end: r.b }).then(function (res) {
      if (res.status !== 200 || !res.body.id) { F.preparing = false; err(APP.errOf(res)); paint(); return; }
      var wanted = { a: r.a, b: r.b };
      F.job = APP.watchJob({
        id: res.body.id, title: src.name, kind: 'follow', src: src.id,
        onTick: function (v) {
          if (v.state === 'running') { F.prepPct = v.percent || 0; F.prepMsg = (v.stage === 'frames' ? 'Getting frames ready for the tracker' : 'Cutting the clip') + ', ' + Math.round(v.percent || 0) + '%'; if (F.step === 1) paint(); }
        },
        onReady: function (v) {
          if (!F.preparing) return;
          F.preparing = false;
          startSession(res.body.id, v.follow, wanted);
        },
        onFail: function (v) { if (!F.preparing) return; F.preparing = false; err(v.error || 'Could not get the clip ready.'); paint(); },
      });
    });
  }
  function cancelPrep() {
    if (F.job) APP.api('POST', '/api/job/' + F.job.id + '/cancel');
    F.preparing = false; paint();
  }

  function startSession(id, meta, range) {
    F.sess = { id: id, meta: meta, a: range.a, b: range.b };
    F.things = []; F.active = -1; F.tracks = null; F.trackedSig = ''; F.lostRaw = null; F.layoutCache = null;
    fv.src = '/api/follow/' + id + '/video';
    fv.load();
    $('fScrub').max = $('fScrub2').max = String(Math.max(0, meta.n - 1));
    newThing();
    F.step = 2;
    paint();
  }

  /* ---- step 2: mark ---- */

  function colorHex(id) {
    var st = APP.state(), c = st && st.styles.colors.filter(function (x) { return x.id === id; })[0];
    return c ? c.hex : '#E7A94C';
  }
  function freeId() { for (var i = 0; i < TM.TAGS_MAX; i++) if (!F.things.some(function (g) { return g.id === i; })) return i; return -1; }
  function freeColor() {
    var cols = (APP.state() && APP.state().tags.colors) || ['ember', 'sky', 'sage', 'flame'];
    for (var i = 0; i < cols.length; i++) if (!F.things.some(function (g) { return g.color === cols[i]; })) return cols[i];
    return cols[0];
  }
  function newThing() {
    var id = freeId();
    if (id < 0) return;
    F.things.push({ id: id, color: freeColor(), prompts: [], outline: null, outlineFrame: -1, name: '', place: 'above' });
    F.active = F.things.length - 1;
    F.tapMode = 'add';
  }
  function thingLabel(g) { return 'Thing ' + (F.things.indexOf(g) + 1); }

  function paintStep2() {
    APP.buildSeg($('fTapMode'), [{ value: 'add', label: 'Add to it' }, { value: 'remove', label: 'Take away' }], F.tapMode, function (v) { F.tapMode = v; });
    var box = $('fThings');
    box.textContent = '';
    F.things.forEach(function (g, i) {
      var row = document.createElement('div');
      row.className = 'thing' + (i === F.active ? ' on' : '');
      row.style.setProperty('--tag', colorHex(g.color));
      var dot = document.createElement('span'); dot.className = 'dot'; dot.setAttribute('aria-hidden', 'true');
      var nm = document.createElement('span'); nm.className = 't-name'; nm.textContent = thingLabel(g);
      var st = document.createElement('span'); st.className = 't-state';
      st.textContent = !g.prompts.length ? 'not marked yet' : g.outline && g.outline.length ? 'marked' : 'marked, no glow yet';
      var sel = document.createElement('button'); sel.type = 'button'; sel.className = 'btn sm ghost';
      sel.textContent = i === F.active ? 'Tapping this' : 'Tap this one';
      sel.disabled = i === F.active;
      sel.addEventListener('click', function () {
        F.active = i; F.tapMode = 'add';
        var last = g.prompts[g.prompts.length - 1];
        if (last) seekFrame(last.frame);
        paint();
      });
      var rm = document.createElement('button'); rm.type = 'button'; rm.className = 'btn sm ghost'; rm.textContent = 'Remove';
      rm.setAttribute('aria-label', 'Remove ' + thingLabel(g));
      rm.addEventListener('click', function () {
        F.things.splice(i, 1);
        F.active = Math.min(F.active, F.things.length - 1);
        if (!F.things.length) newThing();
        F.layoutCache = null;
        paint();
      });
      row.appendChild(dot); row.appendChild(nm); row.appendChild(st); row.appendChild(sel);
      if (F.things.length > 1) row.appendChild(rm);
      box.appendChild(row);
    });
    show($('fAddThing'), F.things.length < TM.TAGS_MAX);
    $('fAddThing').disabled = !F.things.every(function (g) { return g.prompts.length; });
    var ready = F.things.some(function (g) { return g.prompts.length; });
    APP.dock({
      go: { label: tracked() ? 'Next: see the track' : 'Next: track it', disabled: !ready, fn: function () { go(3); } },
      alt: { label: 'Back', fn: function () { go(1); } },
      msg: ready ? '' : 'Tap the thing to follow on the preview.',
    });
  }
  $('fAddThing').addEventListener('click', function () { newThing(); paint(); APP.toast('Pause where it is clear, then tap it.'); });

  function frameNow() {
    if (!F.sess) return 0;
    return Math.max(0, Math.min(F.sess.meta.n - 1, Math.round((fv.currentTime || 0) * F.sess.meta.fps)));
  }
  function seekFrame(i) {
    if (!F.sess) return;
    i = Math.max(0, Math.min(F.sess.meta.n - 1, i));
    try { fv.pause(); } catch (e) { /* none */ }
    fv.currentTime = i / F.sess.meta.fps + 0.001;
  }

  fc.addEventListener('click', function (ev) {
    if (!F.sess || F.step !== 2 || F.tracking) return;
    var rect = fc.getBoundingClientRect();
    var x = (ev.clientX - rect.left) / rect.width, y = (ev.clientY - rect.top) / rect.height;
    if (!(x >= 0 && x <= 1 && y >= 0 && y <= 1)) return;
    if (!fv.paused) { fv.pause(); return; }       // a first tap on a playing clip just stops it
    var g = F.things[F.active];
    if (!g) return;
    var f = frameNow();
    var pr = g.prompts.filter(function (p) { return p.frame === f; })[0];
    if (!pr) {
      if (g.prompts.length >= MAX_PROMPTS) g.prompts.shift();
      pr = { frame: f, points: [] };
      g.prompts.push(pr);
    }
    if (pr.points.length >= MAX_POINTS) pr.points.shift();
    pr.points.push([Math.round(x * 1e4) / 1e4, Math.round(y * 1e4) / 1e4, F.tapMode === 'remove' ? 0 : 1]);
    if (!pr.points.some(function (p) { return p[2] === 1; })) {
      pr.points.pop();
      if (!pr.points.length) g.prompts.splice(g.prompts.indexOf(pr), 1);
      APP.toast('Tap the thing itself first, then take away what does not belong.');
      return;
    }
    segPreview(g, pr);
    paint();
  });

  function segPreview(g, pr) {
    var seq = ++F.segSeq;
    $('fBadge').textContent = 'Looking';
    show($('fBadge'), true);
    APP.api('POST', '/api/follow/' + F.sess.id + '/seg', { frame: pr.frame, points: pr.points }).then(function (r) {
      if (seq !== F.segSeq) return;
      show($('fBadge'), false);
      if (r.status !== 200 || !r.body.ok) { err(APP.errOf(r)); if (r.status === 404) sessionGone(); return; }
      err('');
      g.outline = r.body.outline || [];
      g.outlineFrame = pr.frame;
      if (!r.body.box) APP.toast('Nothing picked there. Tap right on the thing.');
      paint();
    });
  }
  function sessionGone() { err('That clip expired. Pick the clip again.'); F.sess = null; F.step = 1; paint(); }

  /* ---- step 3: track ---- */

  function sig() { return JSON.stringify(F.things.map(function (g) { return [g.id, g.prompts]; })); }
  function tracked() { return !!F.tracks && F.trackedSig === sig(); }

  function startTrack() {
    var usable = F.things.filter(function (g) { return g.prompts.length; });
    if (!usable.length || F.tracking || !F.sess) return;
    F.tracking = true; F.trackPct = 0;
    err('');
    var mark = sig();
    APP.dock({ msg: 'Starting the tracker.', pct: 0 });
    meter(0);
    APP.api('POST', '/api/follow/' + F.sess.id + '/track', { objects: usable.map(function (g) { return { id: g.id, prompts: g.prompts }; }) }).then(function (r) {
      if (r.status !== 200 || !r.body.ok) {
        F.tracking = false; meter(null);
        if (r.status === 404) return sessionGone();
        err(APP.errOf(r)); F.step = 2; paint(); return;
      }
      pollTrack(mark);
    });
  }
  function pollTrack(mark) {
    clearTimeout(F.trackPoll);
    APP.api('GET', '/api/follow/' + F.sess.id + '/track').then(function (r) {
      var v = r.body || {};
      if (r.status === 404) { F.tracking = false; meter(null); return sessionGone(); }
      if (v.state === 'running') {
        F.trackPct = v.progress || 0;
        meter(F.trackPct);
        APP.dock({ msg: 'Following it through the clip, ' + Math.round(F.trackPct) + '%', pct: F.trackPct });
        F.trackPoll = setTimeout(function () { pollTrack(mark); }, 700);
        return;
      }
      F.tracking = false; meter(null);
      if (v.state === 'done') {
        F.tracks = TM.readTracks(v);
        F.lostRaw = (v.objects || []).map(function (o) { return { id: o.id, lost: o.lost || [] }; });
        F.trackedSig = mark;
        F.layoutCache = null;
        fv.currentTime = 0;
        paint();
        var p = fv.play(); if (p && p.catch) p.catch(function () { /* a tap on Play works */ });
      } else {
        err(v.code === 'followbusy' ? 'The graphics card is busy with something else right now. Try again when it is free.'
          : 'Tracking did not work on this one. Mark a bit more of it, or pick a clearer frame.');
        F.step = 2; paint();
      }
    });
  }

  function paintStep3() {
    if (F.tracking) return;
    var box = $('fLost');
    box.textContent = '';
    if (tracked() && F.lostRaw) {
      var fps = F.sess.meta.fps, rows = [];
      F.lostRaw.forEach(function (o) {
        var g = F.things.filter(function (q) { return q.id === o.id; })[0];
        if (!g) return;
        var merged = [];
        o.lost.forEach(function (sp) { var last = merged[merged.length - 1]; if (last && sp[0] - last[1] <= fps) last[1] = Math.max(last[1], sp[1]); else merged.push([sp[0], sp[1]]); });
        merged.forEach(function (sp) { if (sp[1] - sp[0] + 1 >= fps * 0.4 || sp[1] >= F.sess.meta.n - 2) rows.push({ g: g, span: sp }); });
      });
      rows.sort(function (a, b) { return a.span[0] - b.span[0]; });
      rows.slice(0, 5).forEach(function (item) {
        var toEnd = item.span[1] >= F.sess.meta.n - 2;
        var row = document.createElement('div'); row.className = 'lost-row';
        var tx = document.createElement('span');
        tx.textContent = thingLabel(item.g) + (toEnd ? ' leaves the shot at ' : ' was lost at ') + APP.fmtClock(item.span[0] / fps) + '.';
        var fix = document.createElement('button'); fix.type = 'button'; fix.className = 'btn sm ghost'; fix.textContent = 'Fix';
        fix.addEventListener('click', function () {
          F.active = F.things.indexOf(item.g); F.tapMode = 'add';
          go(2);
          seekFrame(Math.min(F.sess.meta.n - 1, item.span[0] + 2));
          APP.toast('Tap ' + thingLabel(item.g) + ' where it is now, then track again.');
        });
        row.appendChild(tx); row.appendChild(fix); box.appendChild(row);
      });
      if (!rows.length) { var ok = document.createElement('p'); ok.className = 'fine'; ok.textContent = 'It held on the whole way through.'; box.appendChild(ok); }
    }
    APP.dock({
      go: { label: 'Next: type the text', disabled: !tracked(), fn: function () { go(4); } },
      alt: { label: 'Back', fn: function () { go(2); } },
    });
  }

  /* ---- step 4: text ---- */

  function named() { return F.things.some(function (g) { return g.prompts.length && clean(g.name); }); }
  function clean(s) { return String(s || '').replace(/[<>{}\\]/g, '').replace(/\s+/g, ' ').trim().slice(0, 32); }

  function paintStep4() {
    var st = APP.state(), so = st.styles, box = $('fLabels');
    if (!box.querySelector('input') || box.getAttribute('data-for') !== sig()) {
      box.textContent = '';
      box.setAttribute('data-for', sig());
      F.things.filter(function (g) { return g.prompts.length; }).forEach(function (g) {
        var card = document.createElement('div'); card.className = 'label-card'; card.style.setProperty('--tag', colorHex(g.color));
        var head = document.createElement('div'); head.className = 't-head';
        var dot = document.createElement('span'); dot.className = 'dot'; dot.setAttribute('aria-hidden', 'true');
        var t = document.createElement('span'); t.textContent = thingLabel(g);
        head.appendChild(dot); head.appendChild(t);
        var inp = document.createElement('input'); inp.type = 'text'; inp.maxLength = 32; inp.placeholder = 'Text for ' + thingLabel(g).toLowerCase();
        inp.setAttribute('aria-label', 'Text for ' + thingLabel(g)); inp.value = g.name; inp.autocomplete = 'off';
        inp.addEventListener('input', function () { g.name = inp.value.slice(0, 32); F.layoutCache = null; paintStep4Dock(); });
        var place = document.createElement('div'); place.className = 'seg-row';
        APP.buildSeg(place, [{ value: 'above', label: 'Above it' }, { value: 'on', label: 'On it' }, { value: 'below', label: 'Below it' }], g.place, function (v) { g.place = v; F.layoutCache = null; });
        var cols = document.createElement('div'); cols.className = 'seg-row swatches';
        APP.buildSeg(cols, so.colors.map(function (c) { return { value: c.id, label: c.label, swatch: c.hex }; }), g.color, function (v) { g.color = v; card.style.setProperty('--tag', colorHex(v)); });
        card.appendChild(head); card.appendChild(inp); card.appendChild(place); card.appendChild(cols);
        box.appendChild(card);
      });
    }
    try { var saved = JSON.parse(APP.store('flicker_follow_look') || '{}') || {}; ['look', 'font', 'size'].forEach(function (k) { if (typeof saved[k] === 'string') F.look[k] = saved[k]; }); if (saved.pointer === false) F.look.pointer = false; } catch (e) { /* defaults */ }
    var keep = function () { APP.store('flicker_follow_look', JSON.stringify(F.look)); F.layoutCache = null; };
    APP.buildSeg($('fLook'), so.looks.map(function (x) { return { value: x.id, label: x.label }; }), F.look.look, function (v) { F.look.look = v; keep(); });
    APP.buildSeg($('fFont'), so.fonts.map(function (x) { return { value: x.id, label: x.label, font: x.css, weight: x.weight }; }), F.look.font, function (v) { F.look.font = v; keep(); });
    APP.buildSeg($('fSize'), [{ value: 's', label: 'Small' }, { value: 'm', label: 'Medium' }, { value: 'l', label: 'Large' }], F.look.size, function (v) { F.look.size = v; keep(); });
    APP.buildSeg($('fPtr'), [{ value: 'on', label: 'On' }, { value: 'off', label: 'Off' }], F.look.pointer ? 'on' : 'off', function (v) { F.look.pointer = v === 'on'; keep(); });
    paintStep4Dock();
  }
  function paintStep4Dock() {
    if (F.step !== 4) return;
    APP.dock({
      go: { label: 'Next: render', disabled: !named(), fn: function () { go(5); } },
      alt: { label: 'Back', fn: function () { go(3); } },
      msg: named() ? '' : 'Type the text for at least one marked thing.',
    });
  }

  /* ---- step 5: render ---- */

  function paintStep5() {
    var st = APP.state(), gifOk = F.sess && F.sess.meta.len <= st.limits.gif + 0.5;
    if (F.kind === 'gif' && !gifOk) F.kind = 'video';
    APP.buildSeg($('fKind'), [{ value: 'video', label: 'Video (MP4)' }, { value: 'gif', label: 'GIF', disabled: !gifOk, title: gifOk ? '' : 'GIFs run up to ' + APP.fmtLen(st.limits.gif) }], F.kind, function (v) { F.kind = v; paintStep5(); });
    var r = F.render;
    if (r && (r.state === 'queued' || r.state === 'running')) return APP.dock({ msg: r.msg || 'Rendering.', pct: r.pct || 0, alt: { label: 'Cancel', fn: function () { APP.api('POST', '/api/job/' + r.id + '/cancel'); } } });
    if (r && r.state === 'ready') return APP.dock({ save: { href: '/api/job/' + r.id + '/file', label: 'Save ' + (r.ext ? r.ext.toUpperCase() : 'file') }, alt: { label: 'Back', fn: function () { F.render = null; go(4); } }, msg: r.name });
    APP.dock({ go: { label: F.kind === 'gif' ? 'Render the GIF' : 'Render the video', fn: renderIt }, alt: { label: 'Back', fn: function () { go(4); } }, msg: r && r.state === 'error' ? r.msg : '' });
  }
  function renderIt() {
    var tags = F.things.filter(function (g) { return g.prompts.length && clean(g.name); }).map(function (g) { return { id: g.id, name: clean(g.name), place: g.place, color: g.color }; });
    if (!tags.length) { go(4); return; }
    try { fv.pause(); } catch (e) { /* none */ }
    APP.api('POST', '/api/follow/' + F.sess.id + '/render', { kind: F.kind, tags: tags, look: F.look, gifWidth: 480 }).then(function (res) {
      if (res.status !== 200 || !res.body.id) { if (res.status === 404) return sessionGone(); err(APP.errOf(res)); return; }
      var src = APP.src();
      F.render = APP.watchJob({
        id: res.body.id, title: (src ? src.name : 'clip') + ' (followed)', kind: 'followrender', src: src ? src.id : '',
        onTick: function () { if (F.step === 5) paintStep5(); },
      });
      paintStep5();
    });
  }

  /* ---------------- the follow stage ---------------- */

  function sizeStage() {
    if (!F.sess) return;
    var m = F.sess.meta, k = 960 / Math.max(m.w, m.h);
    var w = Math.max(2, Math.round(m.w * k)), h = Math.max(2, Math.round(m.h * k));
    if (fc.width !== w || fc.height !== h) { fc.width = w; fc.height = h; }
  }

  function currentLayout(placeholders) {
    if (!F.tracks || !F.sess) return null;
    var key = JSON.stringify([F.look, placeholders, F.things.map(function (g) { return [g.id, g.name, g.place]; })]);
    if (F.layoutCache && F.layoutCache.key === key) return F.layoutCache.value;
    var tags = F.things.filter(function (g) { return g.prompts.length && (placeholders || clean(g.name)); })
      .map(function (g) { return { id: g.id, name: placeholders ? (clean(g.name) || thingLabel(g)) : clean(g.name), place: g.place }; });
    var value = tags.length ? TM.layout(F.tracks, tags, F.look, F.sess.meta.w, F.sess.meta.h) : null;
    F.layoutCache = { key: key, value: value };
    return value;
  }

  function draw() {
    var ctx = fc.getContext('2d');
    if (!ctx || !F.sess) return;
    var W = fc.width, H = fc.height;
    ctx.clearRect(0, 0, W, H);
    if (fv.readyState >= 2) ctx.drawImage(fv, 0, 0, W, H);
    var f = frameNow();
    if (F.step === 2 && fv.paused) {
      F.things.forEach(function (g, gi) {
        var col = colorHex(g.color);
        if (g.outline && g.outlineFrame === f) {
          ctx.save();
          ctx.lineWidth = Math.max(2, W / 260);
          ctx.strokeStyle = col; ctx.fillStyle = col + '55';
          ctx.shadowColor = col; ctx.shadowBlur = gi === F.active ? 14 : 0;
          g.outline.forEach(function (poly) {
            if (!poly.length) return;
            ctx.beginPath();
            poly.forEach(function (p, k) { var X = p[0] * W, Y = p[1] * H; if (k) ctx.lineTo(X, Y); else ctx.moveTo(X, Y); });
            ctx.closePath(); ctx.fill(); ctx.stroke();
          });
          ctx.restore();
        }
        g.prompts.forEach(function (pr) {
          if (pr.frame !== f) return;
          pr.points.forEach(function (p) {
            ctx.beginPath();
            ctx.arc(p[0] * W, p[1] * H, Math.max(5, W / 110), 0, Math.PI * 2);
            ctx.fillStyle = p[2] ? '#FFFFFF' : '#161311';
            ctx.strokeStyle = col; ctx.lineWidth = 3;
            ctx.fill(); ctx.stroke();
          });
        });
      });
    }
    if (F.step >= 3 && tracked()) drawLabels(ctx, W, H, F.step === 3);
  }

  function drawLabels(ctx, W, H, placeholders) {
    var lay = currentLayout(placeholders);
    if (!lay) return;
    var st = APP.state(), so = st.styles;
    var font = so.fonts.filter(function (x) { return x.id === F.look.font; })[0] || so.fonts[0];
    var sx = W / F.sess.meta.w, sy = H / F.sess.meta.h;
    var tt = (fv.currentTime || 0) * F.tracks.fps;
    var i = Math.floor(tt), frac = tt - i, size = lay.m.size;
    lay.plan.forEach(function (p) {
      var a = p.rows[i], b = p.rows[i + 1] || a;
      if (!a) return;
      var x = (a.x + (b.x - a.x) * frac) * sx, y = (a.y + (b.y - a.y) * frac) * sy;
      var vis = a.vis + ((b.vis || 0) - a.vis) * frac;
      var g = F.things.filter(function (q) { return q.id === p.tag.id; })[0];
      var col = colorHex(g ? g.color : 'ember'), dark = g && g.color === 'black';
      var px = size * sy;
      ctx.save();
      ctx.globalAlpha = APP.clamp(vis, 0, 1);
      ctx.font = (font.weight || 700) + ' ' + px + 'px ' + font.css;
      ctx.textAlign = 'center'; ctx.textBaseline = 'alphabetic';
      var name = p.tag.name, tw = ctx.measureText(name).width;
      var baseY = p.tag.place === 'on' ? y - lay.m.boxH * sy / 2 + px * 0.42 : y - px * 0.22;
      if (F.look.look === 'box') {
        var padX = px * 0.28, padY = px * 0.16;
        ctx.fillStyle = dark ? 'rgba(244,238,230,.62)' : 'rgba(0,0,0,.56)';
        roundRect(ctx, x - tw / 2 - padX, baseY - px * 0.86 - padY, tw + padX * 2, px * 1.12 + padY * 2, px * 0.18);
        ctx.fill();
      } else if (F.look.look === 'shadow') {
        ctx.fillStyle = dark ? 'rgba(244,238,230,.75)' : 'rgba(0,0,0,.72)';
        ctx.fillText(name, x + px * 0.1, baseY + px * 0.1);
      } else {
        ctx.lineJoin = 'round'; ctx.lineWidth = px * 0.2; ctx.strokeStyle = dark ? so.cream : so.ink; ctx.strokeText(name, x, baseY);
      }
      ctx.fillStyle = col;
      ctx.fillText(name, x, baseY);
      if (p.tag.place === 'above' && lay.m.ptr) {
        var pw = lay.m.ptr * 1.1 * sx, ph = lay.m.ptr * sy;
        ctx.beginPath(); ctx.moveTo(x - pw, y + 1); ctx.lineTo(x + pw, y + 1); ctx.lineTo(x, y + 1 + ph); ctx.closePath();
        ctx.lineWidth = Math.max(1.5, size * 0.07 * sy); ctx.strokeStyle = dark ? so.cream : so.ink; ctx.fillStyle = col;
        ctx.fill(); ctx.stroke();
      }
      ctx.restore();
    });
  }
  function roundRect(ctx, x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y); ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r); ctx.closePath();
  }

  function loop() {
    F.raf = 0;
    if (!ownsStage()) return;
    draw();
    var f = frameNow(), t = APP.fmtClock(fv.currentTime || 0);
    if (document.activeElement !== $('fScrub')) $('fScrub').value = String(f);
    if (document.activeElement !== $('fScrub2')) $('fScrub2').value = String(f);
    $('fTime').textContent = t; $('fTime2').textContent = t;
    F.raf = requestAnimationFrame(loop);
  }
  function startLoop() { if (!F.raf) F.raf = requestAnimationFrame(loop); }
  function stopLoop() { if (F.raf) cancelAnimationFrame(F.raf); F.raf = 0; }

  function paintPlay() {
    var ico = $('fPlayIco');
    ico.textContent = '';
    var p = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    p.setAttribute('d', fv.paused ? 'M8 5v14l11-7z' : 'M7 5h4v14H7zM13 5h4v14h-4z');
    ico.appendChild(p);
    $('fPlay').setAttribute('aria-label', fv.paused ? 'Play' : 'Pause');
  }
  fv.addEventListener('play', paintPlay);
  fv.addEventListener('pause', paintPlay);
  fv.addEventListener('ended', function () { if (F.step >= 3) { fv.currentTime = 0; var p = fv.play(); if (p && p.catch) p.catch(function () {}); } });
  fv.addEventListener('error', function () { if (F.sess && fv.getAttribute('src')) sessionGone(); });
  $('fPlay').addEventListener('click', function () { if (fv.paused) { var p = fv.play(); if (p && p.catch) p.catch(function () {}); } else fv.pause(); });
  $('fPrev').addEventListener('click', function () { seekFrame(frameNow() - 1); });
  $('fNext').addEventListener('click', function () { seekFrame(frameNow() + 1); });
  $('fScrub').addEventListener('input', function () { seekFrame(Number(this.value) || 0); });
  $('fScrub2').addEventListener('input', function () { seekFrame(Number(this.value) || 0); });
  $('fRecheck').addEventListener('click', function () { APP.recheck($('fRecheck')); });
  window.addEventListener('resize', function () { if (ownsStage()) sizeStage(); });

  window.FLICKER_FOLLOW = { onState: onState, onTool: onTool, onRange: onRange, ownsStage: ownsStage, leave: leave };
  if (APP.state()) onState(APP.state());
})();
