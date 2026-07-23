// Reel — bogus-cover sweeper.
// The P2P-era junk signature: one embedded image (a street map, a website banner)
// stamped into many unrelated rips. Real album art is unique per album, so any art
// file whose bytes are reused across >=2 DISTINCT artists is junk. Same-artist reuse
// (multi-disc sets sharing one scan) is left alone. Clearing sets art=NULL + art_tried=NULL
// so cover-fetch.js re-pulls the correct cover from iTunes per album.
//   node tools-cover-clean.js          # report only
//   node tools-cover-clean.js --apply  # clear + delete orphaned junk files
'use strict';
const fs = require('fs'), path = require('path'), crypto = require('crypto');
const { open, ART_DIR } = require('./db');
const db = open();
const APPLY = process.argv.includes('--apply');

const albums = db.prepare(`SELECT al.id, al.title, al.art, ar.name artist
  FROM albums al LEFT JOIN artists ar ON ar.id = al.artist_id WHERE al.art IS NOT NULL`).all();

const byHash = new Map();
for (const a of albums){
  const p = path.join(ART_DIR, a.art);
  if (!fs.existsSync(p)) continue;
  const h = crypto.createHash('md5').update(fs.readFileSync(p)).digest('hex');
  if (!byHash.has(h)) byHash.set(h, []);
  byHash.get(h).push(a);
}

let mapHash = null;
try { mapHash = crypto.createHash('md5').update(fs.readFileSync(path.join(ART_DIR, '1850.jpg'))).digest('hex'); } catch {}

const ntitle = s => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const junk = [], spared = [];
for (const [h, list] of byHash){
  const titles = new Set(list.map(a => ntitle(a.title)));
  const artists = new Set(list.map(a => (a.artist || '').toLowerCase()));
  const isMap = h === mapHash;
  // junk = one image reused across >=3 different titles AND >=3 different artists (the P2P signature).
  // spares: VA compilations (one title), and a single artist reusing one photo across their discography.
  if (isMap || (titles.size >= 3 && artists.size >= 3)) junk.push({ h, list, isMap, titles: titles.size, artists: artists.size });
  else if (list.length >= 2) spared.push({ h, list, titles: titles.size, artists: artists.size });
}
junk.sort((a, b) => b.list.length - a.list.length);

const clearAlbums = [];
for (const j of junk){
  console.log(`${j.isMap ? '[THE MAP] ' : ''}${j.h.slice(0,8)} — ${j.list.length} albums / ${j.titles} different titles / ${j.artists} artists  (sample: ${j.list[0].art})`);
  console.log('    e.g. ' + j.list.slice(0, 5).map(a => `${a.artist || '?'} — ${a.title}`).join('  |  '));
  clearAlbums.push(...j.list);
}
console.log(`\n${junk.length} junk-image groups → ${clearAlbums.length} albums to clear (out of ${albums.length} with art)`);
if (spared.length){
  console.log(`\nSPARED ${spared.length} shared-cover groups that look like real compilations (one title, many artists):`);
  for (const s of spared.sort((a,b)=>b.list.length-a.list.length).slice(0,12))
    console.log(`    ${s.list.length}× "${s.list[0].title}" (${s.list[0].artist || '?'} …)`);
}

if (APPLY){
  const clr = db.prepare('UPDATE albums SET art = NULL, art_tried = NULL WHERE id = ?');
  db.transaction(() => { for (const a of clearAlbums) clr.run(a.id); })();
  let del = 0;
  for (const a of clearAlbums){ try { fs.unlinkSync(path.join(ART_DIR, a.art)); del++; } catch {} }
  db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  console.log(`CLEARED ${clearAlbums.length} albums, deleted ${del} orphan art files. They'll re-fetch from iTunes on the next cover-fetch run.`);
}
db.close();
