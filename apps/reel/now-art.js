'use strict';
// Pull the official "Now That's What I Call Music" cover for every NOW edition in the
// library and apply it to ALL album rows of that edition — fixing the fragmented
// editions (NOW 21/26/19 split per-artist) that show the wrong individual-artist art.
// Source: MusicBrainz (release-group) + Cover Art Archive. iTunes does NOT carry the
// numbered NOW comps, which is why the original cover-fetch missed them. Year-matched
// so the right UK/US/regional pressing wins. Resumable via the log.
const fs = require('fs');
const path = require('path');
const https = require('https');
const { open, ART_DIR } = require('./db');
const THUMB_DIR = path.join(ART_DIR, '_thumb');
const UA = { 'User-Agent': 'Reel/1.0 (self-hosted personal music app)' };

function get(url, redirects = 0) {
  return new Promise((res, rej) => {
    const r = https.get(url, { headers: UA }, x => {
      if ([301, 302, 307, 308].includes(x.statusCode) && x.headers.location && redirects < 6) {
        x.resume(); return res(get(x.headers.location, redirects + 1));
      }
      const c = []; x.on('data', d => c.push(d)); x.on('end', () => res({ s: x.statusCode, h: x.headers, b: Buffer.concat(c) }));
    });
    r.on('error', rej); r.setTimeout(25000, () => r.destroy(new Error('timeout')));
  });
}
const sleep = ms => new Promise(r => setTimeout(r, ms));
const norm = s => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const slug = s => norm(s).replace(/\s+/g, '-');
const cleanTitle = t => t.replace(/\s*CD\s*\d.*/i, '').replace(/\s*\(disc.*/i, '').replace(/\s*-\s*$/, '').trim();
const yearOf = d => { const m = String(d || '').match(/^(\d{4})/); return m ? +m[1] : null; };

async function mbSearch(title) {
  const q = encodeURIComponent(`releasegroup:"${title}" AND type:compilation`);
  for (let a = 0; a < 4; a++) {
    try {
      const r = await get('https://musicbrainz.org/ws/2/release-group/?query=' + q + '&fmt=json&limit=8');
      if (r.s === 503 || r.s === 429) { await sleep(3000); continue; }
      if (r.s !== 200) return [];
      return (JSON.parse(r.b.toString())['release-groups'] || []);
    } catch { await sleep(3000); }
  }
  return [];
}
async function caaFront(mbid) {
  for (let a = 0; a < 3; a++) {
    try {
      const r = await get('https://coverartarchive.org/release-group/' + mbid + '/front-500');
      if (r.s === 200 && r.b.length > 2000) return r.b;
      if (r.s === 404) return null;
      await sleep(2500);
    } catch { await sleep(2500); }
  }
  return null;
}

(async () => {
  const db = open();
  const rows = db.prepare(`
    SELECT al.id, al.title, al.year FROM albums al
    WHERE LOWER(al.title) LIKE '%what i call music%' OR LOWER(al.title) LIKE '%what i call gold%'
  `).all();

  // group by cleaned title (keeps UK/US/regional editions distinct, folds CD1/CD2 +
  // the per-artist splits back together). Representative year = first non-null seen.
  const eds = new Map();
  for (const r of rows) {
    const key = cleanTitle(r.title);
    if (!eds.has(key)) eds.set(key, { ids: [], year: null, title: key });
    const e = eds.get(key); e.ids.push(r.id); if (!e.year && r.year) e.year = r.year;
  }
  const list = [...eds.values()];
  console.log(`NOW editions: ${list.length} | album-rows: ${rows.length}`);

  const setArt = db.prepare('UPDATE albums SET art = ? WHERE id = ?');
  let applied = 0, missed = 0, idsTouched = 0, n = 0;
  for (const ed of list) {
    n++;
    const cands = (await mbSearch(ed.title))
      .filter(g => { const t = norm(g.title); return /now/.test(t) && /call/.test(t); });
    let pick = null;
    if (cands.length) {
      if (ed.year) {
        pick = cands.slice().sort((a, b) => {
          const da = Math.abs((yearOf(a['first-release-date']) || 9999) - ed.year);
          const dbb = Math.abs((yearOf(b['first-release-date']) || 9999) - ed.year);
          return da - dbb || (b.score || 0) - (a.score || 0);
        })[0];
      } else pick = cands.sort((a, b) => (b.score || 0) - (a.score || 0))[0];
    }
    let buf = null;
    if (pick) { await sleep(1200); buf = await caaFront(pick.id); }
    if (buf) {
      const fname = 'now-' + slug(ed.title) + '.jpg';
      fs.writeFileSync(path.join(ART_DIR, fname), buf);
      for (const id of ed.ids) {
        setArt.run(fname, id);
        try { fs.unlinkSync(path.join(THUMB_DIR, id + '.jpg')); } catch { }   // bust stale thumb
        idsTouched++;
      }
      applied++;
      console.log(`  [${n}/${list.length}] OK  "${ed.title}" (${ed.year || '?'}) -> ${ed.ids.length} rows | ${pick.title} ${pick['first-release-date'] || ''}`);
    } else {
      missed++;
      console.log(`  [${n}/${list.length}] --  "${ed.title}" (${ed.year || '?'}) : ${cands.length ? 'no cover art' : 'no MB match'}`);
    }
    await sleep(1300);   // MusicBrainz: keep under 1 req/sec
  }
  db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  console.log(`DONE: ${applied} editions covered, ${missed} missed, ${idsTouched} album-rows updated`);
  db.close();
})();
