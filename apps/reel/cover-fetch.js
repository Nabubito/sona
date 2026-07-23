// Reel — album cover backfill.
// Fills missing covers (albums.art IS NULL) from Apple's free, keyless iTunes
// Search API. Resumable: a try is stamped in art_tried, so misses aren't retried
// every run, and a crash/restart picks up where it left off. The server reads the
// art column live, so covers appear on the next page load — no restart needed.
//
//   node cover-fetch.js            # backfill everything still missing
//   node cover-fetch.js 25         # only the first 25 (smoke test)
//   node cover-fetch.js --retry    # also re-try past misses (art_tried set, art still null)
'use strict';
const fs = require('fs');
const path = require('path');
const https = require('https');
const { open, migrate, ART_DIR, APP } = require('./db');

const PROGRESS = path.join(APP, 'cover-progress.json');
const args = process.argv.slice(2);
const RETRY = args.includes('--retry');
const LIMIT = parseInt(args.find(a => /^\d+$/.test(a)) || '0', 10) || 0;

// ---------- fuzzy match (reject iTunes' "closest popular album" fallbacks) ----------
const STOP = /\b(the|of|and|a|an|in|on|to|disc|cd|vol|volume|pt|part|remaster|remastered|deluxe|edition|expanded|version|feat|featuring|original|soundtrack|ost)\b/g;
const norm = s => String(s || '').toLowerCase()
  .replace(/\[[^\]]*\]|\([^)]*\)/g, ' ').replace(/&/g, ' and ')
  .replace(/[^a-z0-9]+/g, ' ').replace(STOP, ' ').replace(/\s+/g, ' ').trim();
const toks = s => norm(s).split(' ').filter(w => w.length > 1);
function contain(want, got){ const W = toks(want); if (!W.length) return 1; const G = new Set(toks(got)); let h = 0; for (const w of W) if (G.has(w)) h++; return h / W.length; }

function get(url){
  return new Promise((res, rej) => {
    const req = https.get(url, { headers: { 'User-Agent': 'Reel/1.0 (personal music library; cover art)' } }, r => {
      const chunks = []; r.on('data', c => chunks.push(c));
      r.on('end', () => res({ status: r.statusCode, buf: Buffer.concat(chunks) }));
    });
    req.on('error', rej);
    req.setTimeout(15000, () => req.destroy(new Error('timeout')));
  });
}

async function findCover(artist, title){
  const term = encodeURIComponent((artist + ' ' + title).replace(/\[[^\]]*\]|\([^)]*\)/g, ' ').replace(/\s+/g, ' ').trim());
  const r = await get('https://itunes.apple.com/search?term=' + term + '&entity=album&limit=6');
  if (r.status === 403 || r.status === 429) { const e = new Error('throttled'); e.throttled = true; throw e; }
  if (r.status !== 200) return null;
  let j; try { j = JSON.parse(r.buf.toString()); } catch { return null; }
  if (!j.results || !j.results.length) return null;
  let best = null, bestScore = 0;
  for (const c of j.results){
    if (!c.artworkUrl100) continue;
    const tScore = contain(title, c.collectionName);
    const aScore = contain(artist, c.artistName);
    if (tScore < 0.6 || aScore < 0.5) continue;          // guard against wrong-album fallbacks
    const score = tScore * 0.65 + aScore * 0.35;
    if (score > bestScore){ best = c; bestScore = score; }
  }
  return best;
}

async function download(url){
  const r = await get(url);
  if (r.status !== 200 || !r.buf.length) return null;
  return r.buf;
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  if (!fs.existsSync(ART_DIR)) fs.mkdirSync(ART_DIR, { recursive: true });
  const db = open();
  migrate(db);
  if (!db.prepare('PRAGMA table_info(albums)').all().some(c => c.name === 'art_tried'))
    db.exec('ALTER TABLE albums ADD COLUMN art_tried INTEGER');

  const where = RETRY ? 'al.art IS NULL' : 'al.art IS NULL AND al.art_tried IS NULL';
  const rows = db.prepare(`
    SELECT al.id, al.title, ar.name AS artist, COUNT(t.id) AS tracks
    FROM albums al LEFT JOIN artists ar ON ar.id = al.artist_id
    LEFT JOIN tracks t ON t.album_id = al.id
    WHERE ${where} AND al.title IS NOT NULL AND al.title != '' AND al.artist_id IS NOT NULL
    GROUP BY al.id ORDER BY tracks DESC ${LIMIT ? 'LIMIT ' + LIMIT : ''}`).all();

  const setArt = db.prepare('UPDATE albums SET art = ?, art_tried = ? WHERE id = ?');
  const setTried = db.prepare('UPDATE albums SET art_tried = ? WHERE id = ?');

  const total = rows.length;
  let done = 0, found = 0, missed = 0;
  // iTunes rate-limits aggressively (a burst can 403 the whole IP for a while).
  // Pace gently (~12/min) and, on a throttle, wait LONG so the IP penalty clears
  // instead of staying hot. On throttle we DON'T advance or stamp — the album is
  // retried, never mis-recorded as a no-match. Tunable via env for tougher days.
  const BASE_DELAY = +process.env.COVER_DELAY || 5000;
  const THROTTLE_WAIT = +process.env.COVER_BACKOFF || 300000;   // 5 min cool-down
  const MAX_RETRY = +process.env.COVER_RETRY || 4;
  const started = Date.now();
  const writeProgress = (phase) => { try { fs.writeFileSync(PROGRESS, JSON.stringify({ phase, done, found, missed, total, started, updatedAt: Date.now() })); } catch {} };
  console.log(`cover-fetch: ${total} albums to look up${RETRY ? ' (incl. past misses)' : ''} @ ~18/min`);
  writeProgress('running');

  let i = 0, retry = 0;
  while (i < rows.length){
    const al = rows[i];
    let hit = null, threw = false, throttled = false;
    try { hit = await findCover(al.artist, al.title); }
    catch (e){ threw = true; throttled = !!e.throttled; }

    if (threw){
      retry++;
      if (retry <= MAX_RETRY){
        // transient (throttle or network) — wait and retry the SAME album, no stamp
        console.log(`  ${throttled ? 'throttled' : 'net error'} on "${al.artist} — ${al.title}" — wait ${throttled ? THROTTLE_WAIT/1000 : 5}s, retry ${retry}/${MAX_RETRY}`);
        writeProgress('running');
        await sleep(throttled ? THROTTLE_WAIT : 5000);
        continue;
      }
      // exhausted retries — leave UNstamped so a future run picks it up, move on
      console.log(`  giving up for now on "${al.artist} — ${al.title}" (still missing, will retry next run)`);
      retry = 0; i++; missed++; done++;
      await sleep(BASE_DELAY);
      continue;
    }
    retry = 0;

    if (hit){
      try {
        const buf = await download(hit.artworkUrl100.replace('100x100bb', '600x600bb')) || await download(hit.artworkUrl100);
        if (buf){ fs.writeFileSync(path.join(ART_DIR, al.id + '.jpg'), buf); setArt.run(al.id + '.jpg', Date.now(), al.id); found++; }
        else { setTried.run(Date.now(), al.id); missed++; }
      } catch { setTried.run(Date.now(), al.id); missed++; }
    } else {
      setTried.run(Date.now(), al.id); missed++;   // clean "no confident match" — stamp so we skip it next run
    }
    i++; done++;
    if (done % 10 === 0 || done === total){
      const pct = (done / total * 100).toFixed(1);
      const rate = done / ((Date.now() - started) / 60000);
      console.log(`  ${done}/${total} (${pct}%) — ${found} covers, ${missed} no-match — ~${rate.toFixed(0)}/min`);
      writeProgress('running');
    }
    await sleep(BASE_DELAY);
  }
  writeProgress('done');
  db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  console.log(`DONE: ${found} covers added, ${missed} without a confident match, in ${Math.round((Date.now() - started) / 1000)}s`);
  db.close();
})();
