// Reel — library datastore (node:sqlite, zero native build).
// The "house": schema is built once; indexer keeps pouring music in.
// Shared by indexer.js (writes) and server.js (reads). WAL lets both run at once.
'use strict';
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

const APP = __dirname;
const DB_PATH = path.join(APP, 'library.db');
const ART_DIR = path.join(APP, 'art');

function open() {
  const db = new DatabaseSync(DB_PATH);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA synchronous = NORMAL');
  db.exec('PRAGMA foreign_keys = ON');
  return db;
}

// idempotent — safe to run on every boot / scan
function migrate(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS artists (
      id        INTEGER PRIMARY KEY,
      name      TEXT NOT NULL UNIQUE,
      sort_name TEXT
    );

    CREATE TABLE IF NOT EXISTS albums (
      id        INTEGER PRIMARY KEY,
      title     TEXT NOT NULL,
      artist_id INTEGER REFERENCES artists(id),
      year      INTEGER,
      art       TEXT,                 -- filename in art/  (null = no cover)
      akey      TEXT NOT NULL UNIQUE  -- albumartist|title, lowercased
    );

    CREATE TABLE IF NOT EXISTS tracks (
      id          TEXT PRIMARY KEY,   -- md5(path)[:12], stable across scans
      path        TEXT NOT NULL UNIQUE,
      title       TEXT,
      artist_id   INTEGER REFERENCES artists(id),
      album_id    INTEGER REFERENCES albums(id),
      genre       TEXT,
      year        INTEGER,
      track_no    INTEGER,
      disc        INTEGER,
      dur         INTEGER,
      ext         TEXT,
      size        INTEGER,
      mtime       INTEGER,
      dir         TEXT,               -- "RootName/sub/sub" for the folder browser
      fn          TEXT,
      added_at    INTEGER,
      play_count  INTEGER DEFAULT 0,
      last_played INTEGER,
      scan_id     INTEGER             -- epoch of last scan that saw this file (for pruning)
    );
    CREATE INDEX IF NOT EXISTS idx_tracks_artist ON tracks(artist_id);
    CREATE INDEX IF NOT EXISTS idx_tracks_album  ON tracks(album_id);
    CREATE INDEX IF NOT EXISTS idx_tracks_genre  ON tracks(genre);
    CREATE INDEX IF NOT EXISTS idx_tracks_year   ON tracks(year);
    CREATE INDEX IF NOT EXISTS idx_tracks_dir    ON tracks(dir);
    CREATE INDEX IF NOT EXISTS idx_tracks_added  ON tracks(added_at);

    -- ranked full-text search; tid is carried but not indexed
    CREATE VIRTUAL TABLE IF NOT EXISTS search USING fts5(
      title, artist, album, tid UNINDEXED, tokenize = 'unicode61'
    );

    -- user state (survives restarts, unlike the old in-RAM world)
    CREATE TABLE IF NOT EXISTS favorites (
      tid      TEXT PRIMARY KEY,
      added_at INTEGER
    );
    CREATE TABLE IF NOT EXISTS playlists (
      id         INTEGER PRIMARY KEY,
      name       TEXT NOT NULL,
      created_at INTEGER
    );
    CREATE TABLE IF NOT EXISTS playlist_tracks (
      playlist_id INTEGER REFERENCES playlists(id) ON DELETE CASCADE,
      tid         TEXT,
      pos         INTEGER,
      PRIMARY KEY (playlist_id, tid)
    );

    -- single-row key/value for scan metadata (scannedAt, counts…)
    CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT);
  `);
  // columns added after v1 — ALTER is the only idempotent path (CREATE won't touch
  // an existing table). bio: the artist blurb; bio_src: 'wikipedia'|'manual'|'none';
  // bio_at: epoch we last *tried* (set even on a miss, so batch/resume skips it).
  addCol(db, 'artists', 'bio', 'TEXT');
  addCol(db, 'artists', 'bio_src', 'TEXT');
  addCol(db, 'artists', 'bio_at', 'INTEGER');

  // owner-edited track titles: 1 = manually renamed, so a rescan must not
  // overwrite it from the file's tag/filename (the indexer honours this flag).
  addCol(db, 'tracks', 'title_locked', 'INTEGER DEFAULT 0');

  // ----- per-profile personal state (so separate logins don't share a library) -----
  // playlists gain an owner profile; favorites + play history move to composite-key
  // tables (a track can be favourited / played independently by each profile).
  addCol(db, 'playlists', 'profile', "TEXT NOT NULL DEFAULT 'owner'");
  db.exec(`
    CREATE TABLE IF NOT EXISTS favs (
      profile  TEXT NOT NULL,
      tid      TEXT NOT NULL,
      added_at INTEGER,
      PRIMARY KEY (profile, tid)
    );
    CREATE TABLE IF NOT EXISTS plays (
      profile     TEXT NOT NULL,
      tid         TEXT NOT NULL,
      last_played INTEGER,
      play_count  INTEGER DEFAULT 0,
      PRIMARY KEY (profile, tid)
    );
    CREATE INDEX IF NOT EXISTS idx_plays_lp ON plays(profile, last_played);

    -- per-profile usage telemetry: cumulative listen time + session in/out log
    CREATE TABLE IF NOT EXISTS profile_stats (
      profile      TEXT PRIMARY KEY,
      listened_sec INTEGER DEFAULT 0,   -- wall-clock seconds of actual playback
      logins       INTEGER DEFAULT 0,
      last_login   INTEGER,
      last_logout  INTEGER
    );
  `);
  // one-time: fold the old global favorites + play history into the 'owner' profile
  const done = db.prepare("SELECT v FROM meta WHERE k='profilesMigrated'").get();
  if (!done) {
    try { db.exec("INSERT OR IGNORE INTO favs(profile,tid,added_at) SELECT 'owner',tid,added_at FROM favorites"); } catch { }
    try { db.exec("INSERT OR IGNORE INTO plays(profile,tid,last_played,play_count) SELECT 'owner',id,last_played,play_count FROM tracks WHERE last_played IS NOT NULL OR play_count>0"); } catch { }
    db.prepare("INSERT OR REPLACE INTO meta(k,v) VALUES('profilesMigrated','1')").run();
  }
}

function addCol(db, table, col, decl) {
  const has = db.prepare(`PRAGMA table_info(${table})`).all().some(c => c.name === col);
  if (!has) db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${decl}`);
}

// natural-ish sort key for artist names: drop leading "the ", lowercase
function sortName(name) {
  return String(name || '').toLowerCase().replace(/^the\s+/, '').trim();
}

const decadeOf = y => (y && y > 0 ? Math.floor(y / 10) * 10 : null);

module.exports = { open, migrate, sortName, decadeOf, DB_PATH, ART_DIR, APP };
