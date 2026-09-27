'use strict';
//
// Words burned into a clip: captions that came with an imported link, words heard by the
// speech to text helper, published lyrics lined up with what was heard, or lines you type.
//
// Whatever the source, the text is treated as hostile: libass (the renderer inside ffmpeg)
// understands a whole styling language (override blocks like {\fs900}, drawing commands,
// <font> tags, \N escapes). So no caption file ever reaches ffmpeg as it came. It is parsed
// here into plain cues, every tag and control sequence is stripped to bare text, only the cues
// inside the clip are kept and shifted to clip time, and a brand new small SRT is written for
// ffmpeg to read. What ffmpeg sees is ours.

const MAX_INPUT_BYTES = 5 * 1024 * 1024;
const MAX_CUES_IN = 8000;
const MAX_CUES_OUT = 400;         // a 5 minute clip of fast talk is ~150
const MAX_LINE_CHARS = 120;
const MAX_LINES_PER_CUE = 3;
const MIN_CUE_SEC = 0.25;
const FILLER_SEC = 0.05;          // the 10 ms "hold" cues some automatic captions carry
const TYPED_MAX_CHARS = 4000;
const TYPED_MAX_LINES = 120;

const LANG_RE = /^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{1,8}){0,2}$/;
const validLang = (c) => typeof c === 'string' && c.length <= 24 && LANG_RE.test(c);

// Characters that render as nothing but still steer a text renderer: C0 controls, DEL, zero
// width marks, line and paragraph separators, bidi overrides, the BOM. Built from code points
// on purpose. Typed as literals or escapes they are invisible in an editor, and one of them
// (U+2028) is a line terminator that breaks a regex literal in half.
const ch = (n) => String.fromCharCode(n);
const range = (a, b) => ch(a) + '-' + ch(b);
const INVISIBLE = new RegExp('[' + range(0x00, 0x1f) + range(0x7f, 0x9f) + range(0x200b, 0x200f) + range(0x2028, 0x202e) + range(0x2066, 0x2069) + ch(0xfeff) + ']', 'g');
const MAX_ROW_CHARS = 2000;       // a caption row this long is not a caption
const MAX_ROWS_PER_CUE = 50;

function parseTime(s) {
  const m = /^(?:(\d{1,3}):)?(\d{1,2}):(\d{2})[.,](\d{1,3})$/.exec(String(s).trim());
  if (!m) return NaN;
  return (Number(m[1] || 0) * 3600) + (Number(m[2]) * 60) + Number(m[3]) + Number((m[4] + '00').slice(0, 3)) / 1000;
}

const ENT = { '&amp;': '&', '&lt;': '', '&gt;': '', '&nbsp;': ' ', '&quot;': '"', '&#39;': "'", '&apos;': "'", '&lrm;': '', '&rlm;': '' };

// One line of text down to bare characters. Order matters: tags go before the entity pass,
// so an encoded "&lt;font&gt;" can never decode INTO a tag.
function cleanLine(s) {
  // Capped BEFORE any regex: megabytes of "<" on one line would stall the only thread.
  let t = String(s || '').slice(0, MAX_ROW_CHARS);
  t = t.replace(/<[^>]{0,200}>/g, '');             // <c>, <00:00:01.000>, <i>, <font ...>
  t = t.replace(/\{[^}]{0,200}\}/g, '');           // {\an8}, {\fs900}, {\p1}
  t = t.replace(/&[a-z#0-9]{2,6};/gi, (e) => (e.toLowerCase() in ENT ? ENT[e.toLowerCase()] : ''));
  t = t.replace(/[<>{}\\]/g, '');                  // anything left that libass could read as markup
  t = t.replace(INVISIBLE, ' ');
  t = t.replace(/\s+/g, ' ').trim();
  if (t.length > MAX_LINE_CHARS) t = t.slice(0, MAX_LINE_CHARS - 3).trimEnd() + '...';
  return t;
}

// VTT or SRT in, [{ start, end, lines[] }] out. Anything it does not understand is skipped.
function parseCues(text) {
  let src = String(text || '');
  if (src.length > MAX_INPUT_BYTES) src = src.slice(0, MAX_INPUT_BYTES);
  if (src.charCodeAt(0) === 0xfeff) src = src.slice(1);
  src = src.replace(/\r\n?/g, '\n');
  const cues = [];
  for (const block of src.split(/\n{2,}/)) {
    if (cues.length >= MAX_CUES_IN) break;
    const rows = block.split('\n');
    const ti = rows.findIndex((r) => r.includes('-->'));
    if (ti < 0) continue;
    const m = /^\s*([0-9:.,]+)\s+-->\s+([0-9:.,]+)/.exec(rows[ti]);
    if (!m) continue;
    const start = parseTime(m[1]), end = parseTime(m[2]);
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) continue;
    const lines = rows.slice(ti + 1, ti + 1 + MAX_ROWS_PER_CUE).map(cleanLine).filter(Boolean);
    cues.push({ start, end, lines });
  }
  return cues;
}

// Automatic captions roll: every long cue repeats the previous line above the new one, with 10 ms
// filler cues between. Burned in raw, each sentence shows twice and the text flickers. Keep only
// what is NEW in each cue, drop the fillers, merge repeats, and never let two cues overlap.
function normalize(cues) {
  const out = [];
  let prevRawLast = '';
  for (const c of cues) {
    const rawLast = c.lines.length ? c.lines[c.lines.length - 1] : '';
    if (c.end - c.start < FILLER_SEC || !c.lines.length) { if (rawLast) prevRawLast = rawLast; continue; }
    let lines = c.lines;
    if (lines.length >= 2 && prevRawLast && lines[0] === prevRawLast) lines = lines.slice(1);
    prevRawLast = rawLast;
    lines = lines.slice(0, MAX_LINES_PER_CUE);
    const text = lines.join('\n');
    if (!text) continue;
    const last = out[out.length - 1];
    if (last && last.text === text && c.start - last.end < 1.0) { last.end = Math.max(last.end, c.end); continue; }
    if (last && c.start < last.end) last.end = c.start;
    out.push({ start: c.start, end: c.end, text });
  }
  return out.filter((c) => c.end - c.start >= FILLER_SEC);
}

// Keep what overlaps [start, end) of the clip, in clip time (the cut starts at zero).
function windowCues(cues, start, end) {
  const len = end - start, out = [];
  for (const c of cues) {
    if (c.end <= start || c.start >= end) continue;
    const s = Math.max(0, c.start - start), e = Math.min(len, c.end - start);
    if (e - s < MIN_CUE_SEC) continue;
    out.push({ start: s, end: e, text: c.text });
    if (out.length >= MAX_CUES_OUT) break;
  }
  return out;
}

const stamp = (t) => {
  const ms = Math.max(0, Math.round(t * 1000));
  const p = (n, w) => String(n).padStart(w, '0');
  return p(Math.floor(ms / 3600000), 2) + ':' + p(Math.floor(ms / 60000) % 60, 2) + ':' + p(Math.floor(ms / 1000) % 60, 2) + ',' + p(ms % 1000, 3);
};
const toSrt = (cues) => cues.map((c, i) => (i + 1) + '\n' + stamp(c.start) + ' --> ' + stamp(c.end) + '\n' + c.text + '\n').join('\n');

// A caption file (from an imported link) cut to the clip. Returns { srt, cues }.
function buildClipSrt(rawText, start, end) {
  const cues = windowCues(normalize(parseCues(rawText)), Number(start), Number(end));
  return { srt: toSrt(cues), cues: cues.length };
}

// Lines that came from listening instead of from a caption file. They are already in clip time.
// They still go through the same cleaning: the words came out of a model, fed audio of unknown
// origin, so they are no more trusted than a caption file is.
function cuesToSrt(cues, len) {
  const out = [];
  for (const c of Array.isArray(cues) ? cues : []) {
    if (out.length >= MAX_CUES_OUT) break;
    const s = Math.max(0, Number(c && c.start)), e = Math.min(Number(len), Number(c && c.end));
    const text = cleanLine(c && c.text);
    if (!Number.isFinite(s) || !Number.isFinite(e) || e - s < 0.15 || !text) continue;
    const last = out[out.length - 1];
    const start = last && s < last.end ? last.end : s;
    if (e - start < 0.15) continue;
    out.push({ start, end: Math.max(e, start + MIN_CUE_SEC), text });
  }
  return { srt: toSrt(out), cues: out.length };
}

// Typed words: one caption per line, shown one after another, sharing the clip evenly.
// A single line stays up for the whole clip. Same cleaning as every other source.
function typedCues(text, len) {
  const lines = String(text || '').slice(0, TYPED_MAX_CHARS).split(/\r?\n/).map(cleanLine).filter(Boolean).slice(0, TYPED_MAX_LINES);
  const L = Number(len);
  if (!lines.length || !(L > 0)) return [];
  const each = L / lines.length;
  return lines.map((t, i) => ({ start: i * each, end: i === lines.length - 1 ? L : (i + 1) * each, text: t }));
}

// Caption tracks worth offering for an imported link: human made first, then the automatic
// track in the video's own language. Machine translated tracks are left out.
function pickLangs(info) {
  const out = [], seen = new Set();
  const add = (code, auto) => {
    if (!validLang(code) || seen.has(code + auto) || out.length >= 8) return;
    seen.add(code + auto);
    out.push({ code, auto, label: code.replace(/-orig$/i, '').toUpperCase() + (auto ? ' auto' : '') });
  };
  const usable = (tracks) => Array.isArray(tracks) && tracks.some((t) => t && (t.ext === 'vtt' || t.ext === 'srt'));
  const man = info && info.subtitles && typeof info.subtitles === 'object' ? info.subtitles : {};
  const auto = info && info.automatic_captions && typeof info.automatic_captions === 'object' ? info.automatic_captions : {};
  const manKeys = Object.keys(man).filter((k) => k !== 'live_chat' && usable(man[k]));
  manKeys.filter((k) => /^en\b/i.test(k)).forEach((k) => add(k, false));
  manKeys.filter((k) => !/^en\b/i.test(k)).slice(0, 5).forEach((k) => add(k, false));
  const autoKeys = Object.keys(auto).filter((k) => usable(auto[k]));
  const orig = autoKeys.find((k) => /-orig$/i.test(k));
  if (orig && !manKeys.includes(orig.replace(/-orig$/i, ''))) add(orig, true);
  else if (!manKeys.some((k) => /^en\b/i.test(k)) && autoKeys.includes('en')) add('en', true);
  return out;
}

const SRT_NAME = 'subs.srt';

// ---- look, font and colour ---------------------------------------------------------------------
// The page sends three short NAMES. Nothing typed is ever copied into the filter: each name is
// looked up here and the filter text is assembled from these constants only. An unknown name
// quietly becomes the default. That is what keeps "pick your own style" from turning into "write
// your own ffmpeg filtergraph".
const INK = '161311', CREAM = 'F4EEE6';   // Sona charcoal and warm white: the edge colours
const LOOKS = {
  outline: { label: 'Outline', style: 'BorderStyle=1,Outline=2.2,Shadow=0.8' },
  box:     { label: 'Box',     style: 'BorderStyle=3,Outline=1.4,Shadow=0', box: true },
  shadow:  { label: 'Shadow',  style: 'BorderStyle=1,Outline=0.7,Shadow=2.6' },
};
// System fonts by family name. libass asks the system for them and falls back to a close face
// when one is missing, so every choice renders something on every machine.
const FONTS = {
  arial:   { label: 'Clean',      name: 'Arial',         bold: 1, css: 'Arial, Helvetica, sans-serif' },
  impact:  { label: 'Impact',     name: 'Impact',        bold: 0, css: 'Impact, "Arial Narrow Bold", sans-serif' },
  georgia: { label: 'Classic',    name: 'Georgia',       bold: 1, css: 'Georgia, "Times New Roman", serif' },
  comic:   { label: 'Playful',    name: 'Comic Sans MS', bold: 1, css: '"Comic Sans MS", "Comic Sans", cursive' },
  mono:    { label: 'Typewriter', name: 'Courier New',   bold: 1, css: '"Courier New", Courier, monospace' },
};
const COLORS = {
  white:  { label: 'White',  hex: 'FFFFFF' },
  ember:  { label: 'Ember',  hex: 'E7A94C' },
  flame:  { label: 'Flame',  hex: 'E1712B' },
  sage:   { label: 'Sage',   hex: 'A8C77F' },
  sky:    { label: 'Sky',    hex: '8CC3F0' },
  black:  { label: 'Black',  hex: '111111', dark: true },
};
const DEFAULT_STYLE = { look: 'outline', font: 'arial', color: 'white' };
const own = (o, k) => typeof k === 'string' && Object.prototype.hasOwnProperty.call(o, k);

function normStyle(s) {
  const v = s && typeof s === 'object' && !Array.isArray(s) ? s : {};
  return { look: own(LOOKS, v.look) ? v.look : DEFAULT_STYLE.look, font: own(FONTS, v.font) ? v.font : DEFAULT_STYLE.font, color: own(COLORS, v.color) ? v.color : DEFAULT_STYLE.color };
}
const ass = (rrggbb, alpha) => '&H' + (alpha || '00') + rrggbb.slice(4, 6) + rrggbb.slice(2, 4) + rrggbb.slice(0, 2);   // ASS is AABBGGRR

// The ffmpeg filter. Every character of it comes from the tables above: the file name is a
// constant read relative to the job dir (ffmpeg runs with that as its working dir, which
// sidesteps Windows path escaping inside a filtergraph entirely).
function subtitleFilter(kind, style) {
  const st = normStyle(style), look = LOOKS[st.look], font = FONTS[st.font], col = COLORS[st.color];
  const edge = col.dark ? CREAM : INK;                       // dark text gets a light edge, and the other way round
  const outline = look.box ? ass(col.dark ? CREAM : '000000', '70') : ass(edge);
  // condensed faces read small at the same point size, so they get a lift
  const size = (kind === 'gif' ? 24 : 19) + ({ impact: 2 }[st.font] || 0);
  return 'subtitles=' + SRT_NAME +
    ":force_style='FontName=" + font.name + ',Bold=' + font.bold + ',FontSize=' + size +
    ',PrimaryColour=' + ass(col.hex) + ',OutlineColour=' + outline + ',BackColour=' + ass(col.dark ? CREAM : '000000', '50') +
    ',' + look.style + ',MarginV=' + (kind === 'gif' ? 14 : 20) + ",Alignment=2'";
}

// What the page draws its pickers from, so the two can never drift apart.
const styleOptions = () => ({
  looks: Object.keys(LOOKS).map((id) => ({ id, label: LOOKS[id].label })),
  fonts: Object.keys(FONTS).map((id) => ({ id, label: FONTS[id].label, css: FONTS[id].css, weight: FONTS[id].bold ? 700 : 400 })),
  colors: Object.keys(COLORS).map((id) => ({ id, label: COLORS[id].label, hex: '#' + COLORS[id].hex, dark: !!COLORS[id].dark })),
  defaults: DEFAULT_STYLE,
  ink: '#' + INK, cream: '#' + CREAM,
});

module.exports = {
  LOOKS, FONTS, COLORS, INK, CREAM, assColour: ass, normStyle, styleOptions, validLang, parseCues, normalize, windowCues,
  toSrt, buildClipSrt, cuesToSrt, typedCues, pickLangs, cleanLine, subtitleFilter, SRT_NAME, MAX_INPUT_BYTES, TYPED_MAX_CHARS,
};
