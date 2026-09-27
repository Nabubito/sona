/* Tag motion: where each piece of follow text sits on each tracked frame.
   One file, run in two places: the page draws its live preview with it, and the server
   (lib/labels.js) builds the burned in subtitle script with it. So what you preview is
   what you get, to the pixel.

   What makes the text look right rather than jittery:
     - A One Euro filter on every label: heavy smoothing while the thing stands still (no shake),
       light smoothing when it moves fast (no lag). Reset whenever the label reappears.
     - Hysteresis on visibility: a label hides only after the thing is gone for a few frames and
       returns only after it is back for a few, and it FADES instead of blinking.
     - Each label keeps inside the frame, and two labels that would overlap are pushed apart. */

(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.FLICKER_TAGMOTION = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var TAGS_MAX = 4;
  var SIZES = { s: 0.042, m: 0.056, l: 0.075 };          // font size as a share of video height
  var LIFT = { impact: 1.1 };                             // condensed faces read small
  var SHOW_AFTER = 2;      // tracked frames the thing must be back before its label returns
  var HIDE_AFTER = 4;      // tracked frames it must be gone before its label goes
  var FADE_SEC = 0.22;
  var MIN_AREA = 0.00015;  // an outline smaller than this share of the frame is noise

  function clamp(v, lo, hi) { return Math.min(hi, Math.max(lo, v)); }
  function num(v) { var n = Number(v); return isFinite(n) ? n : NaN; }

  // One Euro filter (Casiez, Roussel, Vogel 2012)
  function alphaFor(cutoff, dt) { var tau = 1 / (2 * Math.PI * cutoff); return 1 / (1 + tau / dt); }
  function oneEuro(minCutoff, beta, dCutoff) {
    var xPrev = null, dxPrev = null;
    return {
      reset: function () { xPrev = null; dxPrev = null; },
      step: function (x, dt) {
        if (xPrev === null) { xPrev = x; dxPrev = 0; return x; }
        var dx = (x - xPrev) / dt;
        var ad = alphaFor(dCutoff, dt);
        dxPrev = ad * dx + (1 - ad) * dxPrev;
        var a = alphaFor(minCutoff + beta * Math.abs(dxPrev), dt);
        xPrev = a * x + (1 - a) * xPrev;
        return xPrev;
      },
    };
  }

  // Tracker output, checked: a number is only trusted once it is finite and inside the frame.
  // Returns { fps, n, objects: { id: [frame|null] } } or null.
  function readTracks(tr) {
    if (!tr || typeof tr !== 'object') return null;
    var fps = num(tr.fps), n = Math.round(num(tr.n));
    if (!(fps > 0 && fps <= 60) || !(n > 0 && n <= 7200)) return null;
    var objects = {};
    var list = Array.isArray(tr.objects) ? tr.objects.slice(0, TAGS_MAX) : [];
    for (var k = 0; k < list.length; k++) {
      var o = list[k];
      var id = Math.round(num(o && o.id));
      if (!(id >= 0 && id < TAGS_MAX) || !Array.isArray(o.f)) continue;
      var f = new Array(n);
      for (var i = 0; i < n; i++) {
        f[i] = null;
        var r = o.f[i];
        if (!Array.isArray(r) || r.length < 9) continue;
        var v = [], bad = false;
        for (var j = 0; j < 9; j++) { var x = num(r[j]); if (!isFinite(x)) { bad = true; break; } v.push(clamp(x, 0, 1)); }
        if (bad || v[2] <= v[0] || v[3] <= v[1] || v[8] < MIN_AREA) continue;
        f[i] = { x0: v[0], y0: v[1], x1: v[2], y1: v[3], tx: v[4], ty: v[5], cx: v[6], cy: v[7], area: v[8] };
      }
      objects[id] = f;
    }
    return { fps: fps, n: n, objects: objects };
  }

  // Sizes in output pixels for a look ({ font, size, pointer }) at frame height H.
  function metrics(look, H) {
    var size = Math.round(H * (SIZES[look.size] || SIZES.m) * (LIFT[look.font] || 1));
    var charW = size * (look.font === 'mono' ? 0.62 : look.font === 'impact' ? 0.48 : 0.56);
    return {
      size: size, charW: charW, boxH: size * 1.25, gap: Math.round(size * 0.25),
      ptr: look.pointer === false ? 0 : Math.round(size * 0.45), margin: Math.round(H * 0.02),
    };
  }

  // tags: [{ id, name, place }]. Returns { plan: [{ tag, boxW, rows: [{x, y, vis}|null] }], m }.
  // y is the BOTTOM of the text box for every place; the renderer offsets for centring.
  function layout(tracks, tags, look, W, H) {
    var m = metrics(look, H);
    var dt = 1 / tracks.fps;
    var plan = tags.map(function (t) {
      var f = tracks.objects[t.id] || [];
      var boxW = Math.max(m.size, t.name.length * m.charW) + m.size * 0.5;
      var xs = oneEuro(1.0, 6, 1.0), ys = oneEuro(1.0, 6, 1.0);
      var rows = new Array(tracks.n);
      var seen = 0, missing = HIDE_AFTER, shown = false, fade = 0, last = null;
      // already there when the clip starts: show from the first frame, a fade in would read as a glitch
      if (f[0] && f[1]) { shown = true; fade = 1; }
      for (var i = 0; i < tracks.n; i++) {
        var r = f[i];
        if (r) { seen++; missing = 0; last = r; } else { missing++; seen = 0; }
        if (!shown && seen >= SHOW_AFTER) { shown = true; xs.reset(); ys.reset(); }
        if (shown && missing >= HIDE_AFTER) shown = false;
        fade = clamp(fade + (shown ? dt : -dt) / FADE_SEC, 0, 1);
        if (fade <= 0 || !last) { rows[i] = null; continue; }
        var x, y;
        if (t.place === 'on') { x = last.cx * W; y = last.cy * H + m.boxH / 2; }
        else if (t.place === 'below') { x = (last.x0 + last.x1) / 2 * W; y = last.y1 * H + m.gap + m.boxH; }
        else { x = last.tx * W; y = last.ty * H - m.gap - m.ptr; }
        rows[i] = { x: xs.step(x / H, dt) * H, y: ys.step(y / H, dt) * H, vis: fade };
      }
      return { tag: t, rows: rows, boxW: boxW };
    });

    // Keep inside the frame, then pull apart any two labels that would overlap on this frame.
    for (var i = 0; i < tracks.n; i++) {
      var live = plan.filter(function (p) { return p.rows[i]; });
      live.forEach(function (p) {
        var r = p.rows[i];
        r.x = clamp(r.x, p.boxW / 2 + m.margin, W - p.boxW / 2 - m.margin);
        r.y = clamp(r.y, m.boxH + m.margin, H - m.margin);
      });
      live.sort(function (a, b) { return a.rows[i].y - b.rows[i].y; });
      for (var a = 0; a < live.length; a++) {
        for (var b = a + 1; b < live.length; b++) {
          var A = live[a].rows[i], B = live[b].rows[i];
          if (Math.abs(A.x - B.x) < (live[a].boxW + live[b].boxW) / 2 && B.y - A.y < m.boxH) {
            var need = m.boxH - (B.y - A.y);
            if (A.y - need >= m.boxH + m.margin) A.y -= need; else B.y = Math.min(H - m.margin, B.y + need);
          }
        }
      }
    }
    return { plan: plan, m: m };
  }

  return { TAGS_MAX: TAGS_MAX, SIZES: SIZES, readTracks: readTracks, metrics: metrics, layout: layout };
});
