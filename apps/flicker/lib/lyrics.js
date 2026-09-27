'use strict';
//
// Real lyrics for songs, so burned in words say what was actually sung.
//
// A speech model guesses at sung words but hears their TIMING well. So for music the words come
// from published lyrics and only the timing comes from the model: transcribe.py lines the two up
// and rejects lyrics that do not match what it heard.
//
// The lookup goes to ONE fixed public host (LRCLIB: free, open, no key) and only when you ask for
// lyrics. What is sent is the artist and song title, nothing else. Switch it off in config
// (lyrics.enabled: false). Everything that comes back is treated as hostile text: size capped,
// parsed defensively, and every line goes through the subtitle cleaner.

const SUBS = require('./subs');

const HOST = 'https://lrclib.net';
const TIMEOUT_MS = 6_000;
const MAX_BYTES = 1536 * 1024;     // a real answer is 100 to 300 KB
const MAX_LINES = 400;
const UA = 'lyrics-lookup/1.0';    // deliberately generic: it says nothing about you or this app
const FIELD_MAX = 300;

let ENABLED = true;
const setEnabled = (on) => { ENABLED = on !== false; };
const enabled = () => ENABLED;

// Figure dash through horizontal bar, built from code points so the source stays plain ASCII.
const DASHES = new RegExp('[' + String.fromCharCode(0x2012) + '-' + String.fromCharCode(0x2015) + ']', 'g');

// Words that describe the upload, not the song.
const JUNK = /\b(official|video|audio|lyrics?|lyric video|hd|hq|4k|remaster(ed)?|live|version|visuali[sz]er|mv|m\/v|full album|with lyrics)\b/gi;
const tokens = (s) => String(s || '').toLowerCase().replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, ' ').trim().split(' ').filter(Boolean);

// { artist, track } from engine metadata, or from an "Artist - Title (whatever)" title or file name.
function guessSong(info) {
  if (!info || typeof info !== 'object') return null;
  const music = (Array.isArray(info.categories) && info.categories.includes('Music')) || !!info.track || !!info.artist;
  // Sliced FIRST: this can run on metadata a hostile page fully controls.
  let artist = typeof info.artist === 'string' ? info.artist.slice(0, FIELD_MAX) : '';
  let track = typeof info.track === 'string' ? info.track.slice(0, FIELD_MAX) : '';
  if (!artist || !track) {
    const title = String(info.title || '').slice(0, FIELD_MAX).replace(DASHES, '-');
    const m = /^(.{1,80}?)\s+-\s+(.{1,120})$/.exec(title);
    if (m) { artist = artist || m[1]; track = track || m[2]; }
  }
  track = String(track).replace(/[([{][^)\]}]{0,80}[)\]}]/g, ' ').replace(JUNK, ' ').replace(/\s+/g, ' ').trim();
  artist = String(artist).replace(/[([{][^)\]}]{0,80}[)\]}]/g, ' ').replace(/\s+/g, ' ').trim();
  if (!music || artist.length < 2 || track.length < 2) return null;
  return { artist: artist.slice(0, 80), track: track.slice(0, 120) };
}

// Returns clean lyric lines, or null. Never throws.
async function find(song) {
  if (!ENABLED || !song || !song.artist || !song.track) return null;
  try {
    const url = HOST + '/api/search?track_name=' + encodeURIComponent(song.track) + '&artist_name=' + encodeURIComponent(song.artist);
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), TIMEOUT_MS);
    let text = '';
    try {
      // identity: a small gzip body can inflate to hundreds of MB before any cap sees it.
      const r = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'application/json', 'Accept-Encoding': 'identity' }, redirect: 'error', signal: ac.signal });
      if (!r.ok || !r.body) return null;
      if (Number(r.headers.get('content-length') || 0) > MAX_BYTES) { ac.abort(); return null; }
      // Count bytes AS THEY ARRIVE and hang up past the cap.
      const reader = r.body.getReader(), dec = new TextDecoder();
      let got = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        got += value.byteLength;
        if (got > MAX_BYTES) { ac.abort(); return null; }
        text += dec.decode(value, { stream: true });
      }
      text += dec.decode();
    } finally { clearTimeout(timer); }
    const list = JSON.parse(text);
    if (!Array.isArray(list)) return null;
    const want = new Set(tokens(song.track));
    for (const x of list.slice(0, 20)) {
      if (!x || x.instrumental || typeof x.plainLyrics !== 'string' || x.plainLyrics.length < 40) continue;
      const got = tokens(x.trackName);
      const shared = got.filter((t) => want.has(t)).length;
      if (!got.length || shared / Math.max(want.size, got.length) < 0.6) continue;   // a different song that merely matched the search
      const lines = x.plainLyrics.split(/\r?\n/).map(SUBS.cleanLine).filter(Boolean).slice(0, MAX_LINES);
      if (lines.length >= 4) return lines;
    }
  } catch { /* offline, slow, or nonsense came back: carry on without lyrics */ }
  return null;
}

module.exports = { guessSong, find, setEnabled, enabled, FILE_NAME: 'lyrics.txt' };
