'use strict';
// One-time (resumable) batch: fill artist bios from Wikipedia.
// Biggest artists first so the player feels alive immediately.
// Resumable: bio_at is stamped on every attempt (hit OR miss), so a rerun
// only touches artists never tried. Re-trying misses later = just delete this
// file's effect per-artist via the ✨ button, or run with --retry-misses.

const { open, migrate } = require('./db');
const { fetchArtistBio } = require('./bio-fetch');

const RETRY_MISSES = process.argv.includes('--retry-misses');
const DELAY_MS = 150;            // ~6–7 req/s — gentle on Wikipedia
const sleep = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  const db = open();
  migrate(db);

  const where = RETRY_MISSES
    ? `WHERE (ar.bio IS NULL OR ar.bio = '')`     // every artist without a real bio
    : `WHERE ar.bio_at IS NULL`;                  // only never-tried (default)

  const rows = db.prepare(`
    SELECT ar.id, ar.name, COUNT(t.id) n
    FROM artists ar LEFT JOIN tracks t ON t.artist_id = ar.id
    ${where}
    GROUP BY ar.id ORDER BY n DESC`).all();

  const upd  = db.prepare(`UPDATE artists SET bio = ?, bio_src = 'wikipedia', bio_at = ? WHERE id = ?`);
  const miss = db.prepare(`UPDATE artists SET bio_src = 'none', bio_at = ? WHERE id = ?`);

  console.log(`[seed-bios] ${rows.length} artists to process${RETRY_MISSES ? ' (retrying misses)' : ''}`);
  const t0 = Date.now();
  let ok = 0, no = 0, i = 0;

  for (const a of rows) {
    i++;
    let res = null;
    try { res = await fetchArtistBio(a.name); } catch { /* network hiccup → treat as miss */ }
    if (res && res.bio) { upd.run(res.bio, Date.now(), a.id); ok++; }
    else { miss.run(Date.now(), a.id); no++; }

    if (i % 25 === 0 || i === rows.length) {
      const rate = i / ((Date.now() - t0) / 1000);
      const eta = Math.round((rows.length - i) / Math.max(rate, 0.1) / 60);
      console.log(`[${i}/${rows.length}] hit=${ok} miss=${no}  ~${eta}m left  · last: ${a.name}`);
    }
    await sleep(DELAY_MS);
  }

  console.log(`[seed-bios] DONE — ${ok} bios written, ${no} no-match, in ${Math.round((Date.now() - t0) / 60000)}m`);
  process.exit(0);
})();
