'use strict';
//
// Text follow: turn the tracker's per frame outlines into text that rides on the thing you marked.
//
// The tracker (py/track.py) hands back, for every tracked frame and every marked thing, a box,
// the top of its outline and its centre, all as fractions of the frame. This file turns that into
// an ASS subtitle script that libass burns in, with the same font, look and colour tables the
// burned in words use (subs.js).
//
// Everything in the script is built here from numbers and fixed tables. The only typed text is
// each label, which goes through subs.cleanLine (strips every character libass could read as
// markup) and is capped in length. The filter string itself is a constant.

const SUBS = require('./subs');
// The motion (smoothing, fades, keeping inside the frame, pushing labels apart) lives in one file
// the page also runs for its live preview, so the preview and the burned file cannot drift apart.
const TM = require('../public/tagmotion');

const TAGS_MAX = TM.TAGS_MAX;
const NAME_MAX = 32;
const ASS_NAME = 'tags.ass';
const PLACES = ['above', 'on', 'below'];
const DEFAULT_COLORS = ['ember', 'sky', 'sage', 'flame'];

const own = (o, k) => typeof k === 'string' && Object.prototype.hasOwnProperty.call(o, k);
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : NaN; };

// The label list from the page, reduced to what we allow. Returns [] when nothing usable is left.
function normTags(list) {
  const out = [];
  if (!Array.isArray(list)) return out;
  const used = new Set();
  // Filter first, then stop at the cap: slicing first would let junk entries use up the four
  // slots and silently drop a good label behind them.
  for (const t of list.slice(0, 16)) {
    if (out.length >= TAGS_MAX) break;
    if (!t || typeof t !== 'object') continue;
    const id = Math.round(num(t.id));
    if (!Number.isInteger(id) || id < 0 || id >= TAGS_MAX || used.has(id)) continue;
    let name = SUBS.cleanLine(typeof t.name === 'string' ? t.name.slice(0, 200) : '');
    if (name.length > NAME_MAX) name = name.slice(0, NAME_MAX).trimEnd();
    if (!name) continue;
    used.add(id);
    out.push({
      id, name,
      place: PLACES.includes(t.place) ? t.place : 'above',
      color: own(SUBS.COLORS, t.color) ? t.color : DEFAULT_COLORS[out.length % DEFAULT_COLORS.length],
    });
  }
  return out;
}
function normLook(s) {
  const st = SUBS.normStyle(s);
  const v = s && typeof s === 'object' ? s : {};
  return { look: st.look, font: st.font, size: own(TM.SIZES, v.size) ? v.size : 'm', pointer: v.pointer !== false };
}

// ---- the ASS script ----------------------------------------------------------------------------
const cs = (sec) => Math.max(0, Math.round(sec * 100));
const stamp = (c) => {
  const h = Math.floor(c / 360000), m = Math.floor(c / 6000) % 60, s = Math.floor(c / 100) % 60, r = c % 100;
  return h + ':' + String(m).padStart(2, '0') + ':' + String(s).padStart(2, '0') + '.' + String(r).padStart(2, '0');
};
const hex2 = (n) => clamp(Math.round(n), 0, 255).toString(16).toUpperCase().padStart(2, '0');
// A base alpha (0 opaque .. 255 clear) faded toward clear by vis (1 shown .. 0 gone).
const fadeA = (base, vis) => hex2(255 - (255 - base) * clamp(vis, 0, 1));

function buildAss(trackJson, tagList, lookIn, W, H) {
  const tracks = TM.readTracks(trackJson);
  const tags = normTags(tagList);
  const look = normLook(lookIn);
  W = clamp(Math.round(num(W)) || 0, 16, 7680); H = clamp(Math.round(num(H)) || 0, 16, 4320);
  if (!tracks || !tags.length) return { ass: '', events: 0 };
  const { plan, m } = TM.layout(tracks, tags, look, W, H);
  const size = m.size, ptr = m.ptr;
  const L = SUBS.LOOKS[look.look], F = SUBS.FONTS[look.font];

  const styles = [], events = [];
  for (const p of plan) {
    const col = SUBS.COLORS[p.tag.color];
    const edge = col.dark ? SUBS.CREAM : SUBS.INK;
    const outline = L.box ? SUBS.assColour(col.dark ? SUBS.CREAM : '000000', '70') : SUBS.assColour(edge);
    const bord = L.box ? Math.max(2, size * 0.12) : (L.label === 'Shadow' ? size * 0.04 : size * 0.1);
    const shad = L.label === 'Shadow' ? size * 0.12 : (L.box ? 0 : size * 0.035);
    styles.push('Style: T' + p.tag.id + ',' + F.name + ',' + size + ',' + SUBS.assColour(col.hex) + ',&H000000FF,' + outline + ',' +
      SUBS.assColour(col.dark ? SUBS.CREAM : '000000', '60') + ',' + (F.bold ? -1 : 0) + ',0,0,0,100,100,0,0,' +
      (L.box ? 3 : 1) + ',' + bord.toFixed(1) + ',' + shad.toFixed(1) + ',2,0,0,0,1');
    // the pointer is a small drawn triangle in the label's colour with the same edge
    styles.push('Style: P' + p.tag.id + ',Arial,' + size + ',' + SUBS.assColour(col.hex) + ',&H000000FF,' + SUBS.assColour(edge) + ',' +
      SUBS.assColour('000000', '60') + ',0,0,0,0,100,100,0,0,1,' + Math.max(1.5, size * 0.07).toFixed(1) + ',0,8,0,0,0,1');
    const aPrim = 0, aOut = L.box ? 0x70 : 0, aBack = 0x60;
    const rows = p.rows;
    for (let i = 0; i < rows.length; i++) {
      const r = rows[i];
      if (!r) continue;
      const nx = rows[i + 1] || r;
      const c0 = cs(i / tracks.fps), c1 = cs((i + 1) / tracks.fps);
      if (c1 <= c0) continue;
      const vis = (r.vis + (rows[i + 1] ? rows[i + 1].vis : 0)) / 2;
      const alpha = '\\1a&H' + fadeA(aPrim, vis) + '&\\3a&H' + fadeA(aOut, vis) + '&\\4a&H' + fadeA(aBack, vis) + '&';
      const an = p.tag.place === 'on' ? 5 : 2;
      const oy = p.tag.place === 'on' ? -size * 0.62 : 0;   // \an5 centres on the text box, the layout gave its bottom
      const mv = '\\move(' + r.x.toFixed(1) + ',' + (r.y + oy).toFixed(1) + ',' + nx.x.toFixed(1) + ',' + (nx.y + oy).toFixed(1) + ')';
      events.push('Dialogue: 1,' + stamp(c0) + ',' + stamp(c1) + ',T' + p.tag.id + ',,0,0,0,,{\\an' + an + mv + alpha + '}' + p.tag.name);
      if (ptr && p.tag.place === 'above') {
        const w = Math.round(ptr * 1.1);
        const pa = '\\1a&H' + fadeA(0, vis) + '&\\3a&H' + fadeA(0, vis) + '&';
        const pmv = '\\move(' + r.x.toFixed(1) + ',' + (r.y + 1).toFixed(1) + ',' + nx.x.toFixed(1) + ',' + (nx.y + 1).toFixed(1) + ')';
        events.push('Dialogue: 0,' + stamp(c0) + ',' + stamp(c1) + ',P' + p.tag.id + ',,0,0,0,,{\\an8' + pmv + pa + '\\p1}m ' + (-w) + ' 0 l ' + w + ' 0 0 ' + ptr + '{\\p0}');
      }
    }
  }
  const head = [
    '[Script Info]', 'ScriptType: v4.00+', 'PlayResX: ' + W, 'PlayResY: ' + H, 'WrapStyle: 2', 'ScaledBorderAndShadow: yes', '',
    '[V4+ Styles]',
    'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
    ...styles, '',
    '[Events]', 'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
  ];
  return { ass: head.concat(events).join('\n') + '\n', events: events.length };
}

// The filter for the burn. A constant: the script's name is fixed and read relative to the job dir.
const tagsFilter = () => 'ass=' + ASS_NAME;

module.exports = { buildAss, normTags, normLook, tagsFilter, ASS_NAME, TAGS_MAX, NAME_MAX, PLACES, DEFAULT_COLORS };
