'use strict';
// Attic — the manifest. Every shot that lands on the PC is recorded here:
// where it lives in the Camera Roll, where it was archived in the private vault,
// its dimensions, byte size, capture device/facing, optional geotag, and a sha256
// so we never double-archive the same frame.
const { DatabaseSync } = require('node:sqlite');
const path = require('path');

const DB_PATH = path.join(__dirname, 'cam.db');
const db = new DatabaseSync(DB_PATH);

db.exec(`
  CREATE TABLE IF NOT EXISTS photos (
    id          TEXT PRIMARY KEY,
    ts          INTEGER NOT NULL,
    filename    TEXT NOT NULL,
    roll_path   TEXT NOT NULL,
    vault_path  TEXT,
    archived    INTEGER DEFAULT 0,
    w           INTEGER,
    h           INTEGER,
    bytes       INTEGER,
    device      TEXT,
    facing      TEXT,
    lat         REAL,
    lon         REAL,
    hash        TEXT,
    fav         INTEGER DEFAULT 0,
    note        TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_photos_ts ON photos(ts DESC);
  CREATE INDEX IF NOT EXISTS idx_photos_hash ON photos(hash);
`);

// Migration: video support. Older databases predate these columns — add them
// in place so the manifest can hold clips alongside stills.
//   kind: 'photo' | 'video'   ·   dur: clip length in seconds (videos only)
for (const ddl of [`kind TEXT DEFAULT 'photo'`, `dur REAL`]) {
  try { db.exec(`ALTER TABLE photos ADD COLUMN ${ddl}`); } catch {}
}

const stmts = {
  insert: db.prepare(`INSERT INTO photos
    (id,ts,filename,roll_path,vault_path,archived,w,h,bytes,device,facing,lat,lon,hash,kind,dur,fav,note)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,0,'')`),
  byId:    db.prepare(`SELECT * FROM photos WHERE id=?`),
  byHash:  db.prepare(`SELECT * FROM photos WHERE hash=? LIMIT 1`),
  del:     db.prepare(`DELETE FROM photos WHERE id=?`),
  setFav:  db.prepare(`UPDATE photos SET fav=? WHERE id=?`),
  setNote: db.prepare(`UPDATE photos SET note=? WHERE id=?`),
  markArchived: db.prepare(`UPDATE photos SET archived=1, vault_path=? WHERE id=?`),
};

module.exports = {
  db,
  insert(rec) {
    stmts.insert.run(
      rec.id, rec.ts, rec.filename, rec.roll_path, rec.vault_path || null,
      rec.archived ? 1 : 0, rec.w || null, rec.h || null, rec.bytes || null,
      rec.device || null, rec.facing || null, rec.lat ?? null, rec.lon ?? null,
      rec.hash || null, rec.kind || 'photo', rec.dur ?? null
    );
    return stmts.byId.get(rec.id);
  },
  get: (id) => stmts.byId.get(id),
  byHash: (h) => stmts.byHash.get(h),
  remove: (id) => stmts.del.run(id),
  setFav: (id, v) => stmts.setFav.run(v ? 1 : 0, id),
  setNote: (id, n) => stmts.setNote.run(String(n || ''), id),
  markArchived: (id, vaultPath) => stmts.markArchived.run(vaultPath, id),
  list({ limit = 120, offset = 0, fav = false } = {}) {
    const where = fav ? 'WHERE fav=1' : '';
    return db.prepare(`SELECT * FROM photos ${where} ORDER BY ts DESC LIMIT ? OFFSET ?`).all(limit, offset);
  },
  stats() {
    const total = db.prepare(`SELECT COUNT(*) n, COALESCE(SUM(bytes),0) b FROM photos`).get();
    const archived = db.prepare(`SELECT COUNT(*) n FROM photos WHERE archived=1`).get();
    const fav = db.prepare(`SELECT COUNT(*) n FROM photos WHERE fav=1`).get();
    return { total: total.n, bytes: total.b, archived: archived.n, fav: fav.n };
  },
  todayCount(startOfDayMs) {
    return db.prepare(`SELECT COUNT(*) n FROM photos WHERE ts>=?`).get(startOfDayMs).n;
  },
};
