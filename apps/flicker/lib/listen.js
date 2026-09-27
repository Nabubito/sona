'use strict';
//
// Listen: speech to text for burned in words, with faster-whisper on the CPU.
//
// Optional. Flicker works without it; the page shows how to add it. What keeps it from
// taking over the machine:
//   - CPU only, a fixed number of threads, below normal priority.
//   - ONE transcription at a time, however many renders are running.
//   - Clips up to limits.maxListenSeconds only.
//   - Offline: the model must already be on disk, and the child is told not to touch the network.
// The child only ever reads a short mono wav that OUR ffmpeg wrote a moment earlier.

const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const PROC = require('./proc');

const SCRIPT = path.join(__dirname, '..', 'py', 'transcribe.py');
const WAV_NAME = 'listen.wav';
const JSON_NAME = 'listen.json';
const LYRICS_NAME = 'lyrics.txt';
const TIMEOUT_MS = 10 * 60_000;

// ffmpeg args for the wav: the clip range only, mono 16 kHz, pinned to local files like every other cut.
const wavArgs = (src, start, len) => ['-y', '-nostdin', '-v', 'error', '-protocol_whitelist', 'file',
  '-ss', Number(start).toFixed(1), '-t', Number(len).toFixed(1), '-i', src, '-vn', '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le', WAV_NAME];

function createListen(opts) {
  // opts: { python (absolute path or ''), model, threads, ready (bool from detection) }
  let state = { python: opts.python || '', model: opts.model, threads: opts.threads, ready: !!opts.ready };
  const available = () => state.ready && !!state.python && fs.existsSync(SCRIPT);
  const set = (next) => { state = Object.assign({}, state, next); };

  // One at a time. Callers line up on this chain.
  let chain = Promise.resolve();
  function exclusive(fn) {
    const run = chain.then(fn, fn);
    chain = run.then(() => {}, () => {});
    return run;
  }

  // Resolves [{start,end,text}] (with .source = 'heard' | 'lyrics') or [].
  // hold.proc is set while the child runs so a cancel can kill it. isDead() lets a render that
  // was cancelled while waiting in line skip its turn.
  function transcribe(dir, hold, isDead) {
    return exclusive(() => new Promise((resolve) => {
      if (isDead && isDead()) return resolve([]);
      if (!available()) return resolve([]);
      const env = Object.assign({}, process.env, {
        HF_HUB_OFFLINE: '1', HF_HUB_DISABLE_SYMLINKS_WARNING: '1', PYTHONIOENCODING: 'utf-8',
        OMP_NUM_THREADS: String(state.threads),
        // it has no business on the network; if anything in it ever tried, it would hit a dead port
        HTTP_PROXY: 'http://127.0.0.1:9', HTTPS_PROXY: 'http://127.0.0.1:9', http_proxy: 'http://127.0.0.1:9', https_proxy: 'http://127.0.0.1:9', NO_PROXY: '', no_proxy: '',
      });
      // For a song the caller has dropped the published lyrics next to the wav. transcribe.py uses
      // them for the WORDS only if they match what it hears; otherwise it ignores them.
      const args = [SCRIPT, WAV_NAME, JSON_NAME, state.model, String(state.threads)];
      try { if (fs.statSync(path.join(dir, LYRICS_NAME)).isFile()) args.push(LYRICS_NAME); } catch { /* no lyrics, plain listening */ }
      let p;
      try { p = spawn(state.python, args, { cwd: dir, env, windowsHide: true, stdio: 'ignore' }); }
      catch { return resolve([]); }
      PROC.lower(p);
      if (hold) hold.proc = p;
      let done = false;
      const fin = (ok) => {
        if (done) return; done = true; clearTimeout(killer); if (hold) hold.proc = null;
        if (!ok) return resolve([]);
        try {
          const st = fs.statSync(path.join(dir, JSON_NAME));
          if (!st.isFile() || st.size > 2 * 1024 * 1024) return resolve([]);
          const j = JSON.parse(fs.readFileSync(path.join(dir, JSON_NAME), 'utf8'));
          const cues = Array.isArray(j.cues) ? j.cues : [];
          cues.source = j.source === 'lyrics' ? 'lyrics' : 'heard';   // rides along on the array
          resolve(cues);
        } catch { resolve([]); }
      };
      const killer = setTimeout(() => { PROC.killTree(p); fin(false); }, TIMEOUT_MS);
      p.on('error', () => fin(false));
      p.on('close', (code) => fin(code === 0));
    }));
  }

  return { available, transcribe, set, get model() { return state.model; } };
}

module.exports = { createListen, wavArgs, WAV_NAME, LYRICS_NAME, SCRIPT };
