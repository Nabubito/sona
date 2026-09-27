'use strict';
//
// Song hunt: name the song in a video you opened, so its burned in words can carry the real
// lyrics instead of a model's guess at sung words.
//
// Three ways to a name, tried in this order:
//   1. The file name, when it reads "Artist - Title" (free, instant; lyrics.js guessSong).
//   2. The audio itself: an AcoustID fingerprint (made by ffmpeg's chromaprint muxer) looked up at
//      ONE fixed host, api.acoustid.org. Optional: it needs a free application key in config
//      (songId.acoustidKey) and an ffmpeg build that has chromaprint. Without both, it is skipped.
//   3. You type the artist and title.
// A name then goes to the lyrics lookup (lyrics.js), and transcribe.py lines the published words
// up with what it hears in the clip. If they do not agree the lyrics are dropped and the clip gets
// plain heard words.
//
// Everything that comes back is hostile text: size capped, parsed defensively, and every name
// goes through the subtitle cleaner before it is shown or looked up.

const { execFile, spawn } = require('child_process');
const SUBS = require('./subs');
const LYRICS = require('./lyrics');

const ACOUSTID = 'https://api.acoustid.org/v2/lookup';
const KEY_RE = /^[A-Za-z0-9_-]{6,64}$/;
const UA = 'song-lookup/1.0';               // generic on purpose
const TIMEOUT_MS = 8_000;
const MAX_BYTES = 512 * 1024;
const FP_SEC = 120;                         // seconds of audio fingerprinted
const FP_TIMEOUT_MS = 60_000;
const FP_MAX_CHARS = 64 * 1024;
const MIN_SCORE = 0.5;
const FIELD_MAX = 120;
const MANUAL_MAX = 12;                      // typed lookups per video

const cleanField = (s) => SUBS.cleanLine(String(s || '').slice(0, 300)).replace(/\s+/g, ' ').trim().slice(0, FIELD_MAX);

function createSongHunt(deps) {
  const KEY = KEY_RE.test(String(deps.key || '')) ? String(deps.key) : '';
  const FFMPEG_FP = deps.ffmpeg || '';     // a build with the chromaprint muxer, or '' when none is known
  let fpOk = null;                          // lazily proven: the muxer really exists in that build

  function fingerprintReady() {
    if (fpOk !== null) return Promise.resolve(fpOk);
    return new Promise((resolve) => {
      if (!KEY || !FFMPEG_FP) { fpOk = false; return resolve(false); }
      execFile(FFMPEG_FP, ['-hide_banner', '-muxers'], { windowsHide: true, timeout: 15_000, maxBuffer: 4 * 1024 * 1024 }, (err, so) => {
        fpOk = !err && /\bchromaprint\b/.test(String(so || ''));
        resolve(fpOk);
      });
    });
  }

  async function capabilities() {
    return { fingerprint: !!KEY && await fingerprintReady(), lyrics: LYRICS.enabled() };
  }

  // The compressed base64 fingerprint of up to FP_SEC seconds from the start.
  function fingerprint(file, dur) {
    const len = Math.max(1, Math.min(FP_SEC, Math.floor(Number(dur) || 0)));
    return new Promise((resolve) => {
      let p;
      const args = ['-y', '-nostdin', '-v', 'error', '-protocol_whitelist', 'file', '-t', String(len), '-i', file,
        '-vn', '-ac', '2', '-ar', '44100', '-f', 'chromaprint', '-fp_format', 'base64', '-'];
      try { p = spawn(FFMPEG_FP, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] }); }
      catch { return resolve(null); }
      let out = '';
      let done = false;
      const fin = (ok) => { if (done) return; done = true; clearTimeout(killer); resolve(ok && out.trim().length >= 8 ? { fp: out.trim(), len } : null); };
      const killer = setTimeout(() => { try { p.kill(); } catch { /* gone */ } fin(false); }, FP_TIMEOUT_MS);
      p.stdout.on('data', (d) => { if (out.length < FP_MAX_CHARS) out += String(d); });
      p.on('error', () => fin(false));
      p.on('close', (code) => fin(code === 0));
    });
  }

  // Ask AcoustID who this is. Returns { artist, track } or null. Never throws.
  // dur is the WHOLE file's length: AcoustID only considers recordings of about that length.
  async function lookup(fp, dur) {
    if (!KEY || !fp || !/^[A-Za-z0-9_-]+$/.test(fp)) return null;
    try {
      const body = 'client=' + encodeURIComponent(KEY) + '&duration=' + Math.max(1, Math.round(Number(dur) || 0)) + '&meta=recordings&fingerprint=' + encodeURIComponent(fp);
      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(), TIMEOUT_MS);
      let text = '';
      try {
        const r = await fetch(ACOUSTID, {
          method: 'POST',
          headers: { 'User-Agent': UA, Accept: 'application/json', 'Accept-Encoding': 'identity', 'Content-Type': 'application/x-www-form-urlencoded' },
          body, redirect: 'error', signal: ac.signal,
        });
        if (!r.ok || !r.body) return null;
        if (Number(r.headers.get('content-length') || 0) > MAX_BYTES) { ac.abort(); return null; }
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
      const j = JSON.parse(text);
      if (!j || j.status !== 'ok' || !Array.isArray(j.results)) return null;
      const results = j.results.filter((x) => x && Number(x.score) >= MIN_SCORE).sort((a, b) => Number(b.score) - Number(a.score)).slice(0, 5);
      for (const res of results) {
        for (const rec of (Array.isArray(res.recordings) ? res.recordings : []).slice(0, 10)) {
          const track = cleanField(rec && rec.title);
          const artist = cleanField(rec && Array.isArray(rec.artists) && rec.artists[0] && rec.artists[0].name);
          if (track.length >= 2 && artist.length >= 2) return { artist, track };
        }
      }
    } catch { /* offline, slow, refused, or nonsense: no name from the audio */ }
    return null;
  }

  // The whole hunt for one video. Fills s.song = { state, artist, track, via, lyrics } and never throws.
  //   state: 'hunting' -> 'found' (lyrics ready) | 'named' (name but no lyrics) | 'none'
  async function hunt(s, prep) {
    if (!s || s.song) return;
    s.song = { state: 'hunting', artist: '', track: '', via: '', lyrics: null, manual: 0 };
    if (!LYRICS.enabled()) { s.song.state = 'none'; return; }
    const apply = async (song, via) => {
      if (!song) return false;
      const lines = await LYRICS.find(song);
      if (s.state === 'gone') return true;
      s.song.artist = song.artist; s.song.track = song.track; s.song.via = via;
      s.song.lyrics = lines || null;
      s.song.state = lines ? 'found' : 'named';
      return !!lines;
    };
    try {
      const byName = LYRICS.guessSong(s.songHint || { title: s.name, categories: ['Music'] });
      if (byName && await apply(byName, 'name')) return;
      if (s.meta && s.meta.audio && await fingerprintReady()) {
        const fp = await (prep ? prep(() => fingerprint(s.file, s.meta.dur)) : fingerprint(s.file, s.meta.dur));
        if (s.state === 'gone') return;
        const who = fp ? await lookup(fp.fp, s.meta.dur) : null;
        if (who && await apply(who, 'audio')) return;
      }
      if (s.song.state === 'hunting') s.song.state = 'none';
    } catch { if (s.song.state === 'hunting') s.song.state = 'none'; }
  }

  // You typed a name. Capped per video, and both fields cleaned.
  async function manual(s, body) {
    if (!LYRICS.enabled()) return { ok: false, code: 'nolyricslookup' };
    if (!s.song) s.song = { state: 'none', artist: '', track: '', via: '', lyrics: null, manual: 0 };
    if (s.song.manual >= MANUAL_MAX) return { ok: false, code: 'ratelimit' };
    const artist = cleanField(body && body.artist), track = cleanField(body && body.track);
    if (artist.length < 2 || track.length < 2) return { ok: false, code: 'badrequest' };
    s.song.manual++;
    const lines = await LYRICS.find({ artist, track });
    s.song.artist = artist; s.song.track = track; s.song.via = 'typed';
    s.song.lyrics = lines || null;
    s.song.state = lines ? 'found' : 'named';
    return { ok: true, song: view(s) };
  }

  function view(s) {
    const g = s && s.song;
    if (!g) return { state: 'none', artist: '', track: '', via: '', lyrics: false };
    return { state: g.state, artist: g.artist, track: g.track, via: g.via, lyrics: !!g.lyrics };
  }

  return { hunt, manual, view, capabilities, fingerprintReady };
}

module.exports = { createSongHunt, cleanField };
