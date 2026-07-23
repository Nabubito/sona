// Reel indexer — walks configured roots, reads real audio tags +
// embedded cover art, and upserts rows into library.db (SQLite).
// Incremental: unchanged files (size+mtime) are not re-tagged, only re-stamped.
// Deleted files are pruned. FTS5 search table is rebuilt at the end.
// Run: node indexer.js   (progress: scan-progress.json, used by /api/scan-status)
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const mm = require('music-metadata');
const { open, migrate, sortName, ART_DIR, APP } = require('./db');

const CONFIG = JSON.parse(fs.readFileSync(path.join(APP, 'config.json'), 'utf8'));
const PROGRESS_PATH = path.join(APP, 'scan-progress.json');
const AUDIO_EXTS = new Set(['.mp3', '.flac', '.wav', '.ogg', '.m4a', '.aac', '.opus', '.wma']);
const IMG_EXTS = ['.jpg', '.jpeg', '.png', '.webp', '.gif', '.bmp'];
// preferred sidecar cover filenames, best first (matched on the filename stem, any image ext)
const COVER_STEMS = ['cover', 'folder', 'front', 'album', 'albumart', 'art', 'thumb', 'scan'];
const CONCURRENCY = 4; // gentle on a spinning HDD

const tid = p => crypto.createHash('md5').update(p).digest('hex').slice(0, 12);
const writeProgress = p => { try { fs.writeFileSync(PROGRESS_PATH, JSON.stringify(p)); } catch { } };

function walk(dir, out) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) walk(full, out);
    else if (e.isFile() && AUDIO_EXTS.has(path.extname(e.name).toLowerCase())) out.push(full);
  }
}

(async () => {
  const started = Date.now();
  const scanId = started;
  if (!fs.existsSync(ART_DIR)) fs.mkdirSync(ART_DIR, { recursive: true });

  const db = open();
  migrate(db);

  // ---- prepared statements ----
  const Q = {
    findArtist:   db.prepare('SELECT id FROM artists WHERE name = ?'),
    insArtist:    db.prepare('INSERT INTO artists (name, sort_name) VALUES (?, ?)'),
    findAlbum:    db.prepare('SELECT id, art FROM albums WHERE akey = ?'),
    insAlbum:     db.prepare('INSERT INTO albums (title, artist_id, year, akey) VALUES (?, ?, ?, ?)'),
    setAlbumArt:  db.prepare('UPDATE albums SET art = ? WHERE id = ?'),
    findTrack:    db.prepare('SELECT size, mtime FROM tracks WHERE id = ?'),
    touchTrack:   db.prepare('UPDATE tracks SET scan_id = ? WHERE id = ?'),
    upsertTrack:  db.prepare(`
      INSERT INTO tracks (id,path,title,artist_id,album_id,genre,year,track_no,disc,dur,ext,size,mtime,dir,fn,added_at,scan_id)
      VALUES (@id,@path,@title,@artist_id,@album_id,@genre,@year,@track_no,@disc,@dur,@ext,@size,@mtime,@dir,@fn,@added_at,@scan_id)
      ON CONFLICT(id) DO UPDATE SET
        title=CASE WHEN tracks.title_locked=1 THEN tracks.title ELSE @title END,
        artist_id=@artist_id, album_id=@album_id, genre=@genre, year=@year,
        track_no=@track_no, disc=@disc, dur=@dur, ext=@ext, size=@size, mtime=@mtime,
        dir=@dir, fn=@fn, scan_id=@scan_id`)
  };

  const artistCache = new Map();    // name -> id
  const albumCache = new Map();     // akey -> { id, art }
  const folderArtCache = new Map(); // dir -> absolute image path | null

  function artistId(name) {
    if (!name) return null;
    if (artistCache.has(name)) return artistCache.get(name);
    let row = Q.findArtist.get(name);
    const id = row ? row.id : Number(Q.insArtist.run(name, sortName(name)).lastInsertRowid);
    artistCache.set(name, id);
    return id;
  }

  function albumRef(title, albumArtist, year) {
    if (!title) return { id: null, art: undefined };
    const akey = `${(albumArtist || '').toLowerCase()}|${title.toLowerCase()}`;
    if (albumCache.has(akey)) return albumCache.get(akey);
    let row = Q.findAlbum.get(akey);
    let ref;
    if (row) ref = { id: row.id, art: row.art };
    else {
      const id = Number(Q.insAlbum.run(title, artistId(albumArtist), year || null, akey).lastInsertRowid);
      ref = { id, art: null };
    }
    albumCache.set(akey, ref);
    return ref;
  }

  function saveArt(albumRefObj, picture) {
    if (!albumRefObj.id || albumRefObj.art || !picture || !picture.data) return;
    const fmt = (picture.format || 'image/jpeg').split('/').pop().replace('jpeg', 'jpg');
    const file = `${albumRefObj.id}.${fmt}`;
    try {
      fs.writeFileSync(path.join(ART_DIR, file), Buffer.from(picture.data));
      Q.setAlbumArt.run(file, albumRefObj.id);
      albumRefObj.art = file;
    } catch { /* non-fatal */ }
  }

  // find a sidecar cover image sitting next to the audio (cover.jpg, folder.png, front.jpg, AlbumArt_*.jpg ...)
  function findFolderArt(dir) {
    if (folderArtCache.has(dir)) return folderArtCache.get(dir);
    let best = null;
    try {
      const imgs = fs.readdirSync(dir, { withFileTypes: true })
        .filter(e => e.isFile() && IMG_EXTS.includes(path.extname(e.name).toLowerCase()))
        .map(e => e.name);
      if (imgs.length) {
        // rank by preferred stem (cover/folder/front/...), else fall back to the first image present
        const rank = name => {
          const stem = path.basename(name, path.extname(name)).toLowerCase();
          for (let i = 0; i < COVER_STEMS.length; i++) {
            if (stem === COVER_STEMS[i] || stem.startsWith(COVER_STEMS[i])) return i;
          }
          return COVER_STEMS.length;
        };
        imgs.sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));
        best = path.join(dir, imgs[0]);
      }
    } catch { /* unreadable dir */ }
    folderArtCache.set(dir, best);
    return best;
  }

  // copy a sidecar image file into art/<albumId>.<ext> and record it on the album
  function saveArtFile(albumId, src) {
    if (!albumId || !src) return false;
    const ext = (path.extname(src).toLowerCase() === '.jpeg' ? '.jpg' : path.extname(src).toLowerCase()).slice(1) || 'jpg';
    const file = `${albumId}.${ext}`;
    try {
      fs.copyFileSync(src, path.join(ART_DIR, file));
      Q.setAlbumArt.run(file, albumId);
      return file;
    } catch { return false; }
  }

  // ---- transaction batching (one writer; commit every N for speed + safety) ----
  let inTxn = false, pending = 0;
  const begin = () => { if (!inTxn) { db.exec('BEGIN'); inTxn = true; } };
  const flush = () => { if (inTxn) { db.exec('COMMIT'); inTxn = false; pending = 0; } };
  const bump = () => { if (++pending >= 800) flush(); };

  // ---- phase 1: discover ----
  writeProgress({ phase: 'walking', scanned: 0, total: 0, started });
  const found = [];
  for (const root of CONFIG.roots) {
    const files = [];
    walk(root.path, files);
    for (const f of files) found.push({ root, full: f });
  }

  // ---- phase 2: read tags + upsert ----
  let scanned = 0, reused = 0, errors = 0, qi = 0;
  writeProgress({ phase: 'tagging', scanned: 0, total: found.length, reused, errors, started });

  async function worker() {
    while (qi < found.length) {
      const { root, full } = found[qi++];
      const ext = path.extname(full).toLowerCase();
      const id = tid(full);
      let st;
      try { st = fs.statSync(full); } catch { errors++; scanned++; continue; }
      const mtime = Math.floor(st.mtimeMs);

      const old = Q.findTrack.get(id);
      if (old && old.size === st.size && old.mtime === mtime) {
        begin(); Q.touchTrack.run(scanId, id); bump();
        reused++; scanned++;
      } else {
        const rel = path.relative(root.path, path.dirname(full)).split(path.sep).filter(Boolean);
        const dir = [root.name, ...rel].join('/');
        const fn = path.basename(full);
        const rec = {
          id, path: full, title: path.basename(fn, ext), artist_id: null, album_id: null,
          genre: null, year: null, track_no: null, disc: null, dur: null,
          ext: ext.slice(1), size: st.size, mtime, dir, fn, added_at: Date.now(), scan_id: scanId
        };
        let picture = null, albumArtist = '', albumTitle = '';
        try {
          const meta = await mm.parseFile(full, { duration: false });
          const c = meta.common;
          if (c.title)  rec.title = String(c.title).trim() || rec.title;
          if (c.artist) rec.artist_id = artistId(String(c.artist).trim());
          albumArtist = (c.albumartist || c.artist || '').toString().trim();
          albumTitle  = (c.album || '').toString().trim();
          if (Array.isArray(c.genre) && c.genre[0]) rec.genre = String(c.genre[0]).trim();
          if (c.year) rec.year = c.year;
          // "Now That's What I Call…" compilations get their own genre so the
          // whole collection lives under one bucket in the Genres facet
          // (path-based, so it survives re-tagging and every rescan).
          if (/now\s+that.?s\s+what\s+i\s+call/i.test(full)) rec.genre = "Now That's What I Call Music";
          if (c.track && c.track.no) rec.track_no = c.track.no;
          if (c.disk && c.disk.no) rec.disc = c.disk.no;
          if (meta.format.duration) rec.dur = Math.round(meta.format.duration);
          if (Array.isArray(c.picture) && c.picture[0]) picture = c.picture[0];
        } catch { errors++; }

        begin();
        const album = albumRef(albumTitle, albumArtist, rec.year);
        rec.album_id = album.id;
        if (album.id) {
          saveArt(album, picture);                       // 1) embedded tag art
          if (!album.art) {                              // 2) sidecar cover file in the folder
            const f = saveArtFile(album.id, findFolderArt(path.dirname(full)));
            if (f) album.art = f;
          }
        }
        Q.upsertTrack.run(rec);
        bump();
        scanned++;
      }
      if (scanned % 250 === 0) {
        flush(); // checkpoint so /api/* sees fresh data mid-scan
        writeProgress({ phase: 'tagging', scanned, total: found.length, reused, errors, started });
      }
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  flush();

  // ---- phase 3: prune deleted + rebuild search + dedupe orphans ----
  writeProgress({ phase: 'finalizing', scanned, total: found.length, reused, errors, started });
  db.exec('BEGIN');
  db.prepare('DELETE FROM tracks WHERE scan_id != ?').run(scanId);
  db.exec(`DELETE FROM albums  WHERE id NOT IN (SELECT DISTINCT album_id  FROM tracks WHERE album_id  IS NOT NULL)`);
  // Keep artists referenced by EITHER a track OR an album (compilation album-artists
  // like "Various Artists" have no track pointing at them, only albums — deleting
  // them used to trip a FOREIGN KEY constraint and abort the whole finalize phase).
  db.exec(`DELETE FROM artists WHERE id NOT IN (
             SELECT artist_id FROM tracks WHERE artist_id IS NOT NULL
             UNION
             SELECT artist_id FROM albums WHERE artist_id IS NOT NULL)`);

  // ---- backfill sidecar cover art for any album still missing it ----
  // (covers the existing library + tracks that were "reused" without re-reading tags)
  let artFilled = 0;
  for (const m of db.prepare(`
    SELECT al.id AS id, MIN(t.path) AS p
    FROM albums al JOIN tracks t ON t.album_id = al.id
    WHERE al.art IS NULL GROUP BY al.id`).all()) {
    const src = findFolderArt(path.dirname(m.p));
    if (src && saveArtFile(m.id, src)) artFilled++;
  }

  db.exec('DELETE FROM search');
  db.exec(`
    INSERT INTO search (title, artist, album, tid)
    SELECT t.title, COALESCE(ar.name,''), COALESCE(al.title,''), t.id
    FROM tracks t
    LEFT JOIN artists ar ON ar.id = t.artist_id
    LEFT JOIN albums  al ON al.id = t.album_id
  `);
  const total = db.prepare('SELECT COUNT(*) n FROM tracks').get().n;
  const sizeRow = db.prepare('SELECT COALESCE(SUM(size),0) s FROM tracks').get();
  db.prepare(`INSERT INTO meta (k,v) VALUES ('scannedAt',?) ON CONFLICT(k) DO UPDATE SET v=excluded.v`)
    .run(new Date().toISOString());
  db.exec('COMMIT');
  db.exec('PRAGMA wal_checkpoint(TRUNCATE)');

  writeProgress({ phase: 'done', scanned, total: found.length, reused, errors, started, finished: Date.now() });
  console.log(`Indexed ${total} tracks (${reused} reused, ${errors} tag errors, ${artFilled} sidecar covers, ${(sizeRow.s / 1e9).toFixed(1)} GB) in ${Math.round((Date.now() - started) / 1000)}s`);
  db.close();
})();
