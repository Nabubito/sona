// Kin data layer — built on Node's built-in node:sqlite (no native deps).
'use strict';
const { DatabaseSync } = require('node:sqlite');
const path = require('path');
const fs = require('fs');

const DATA_DIR = path.join(__dirname, 'data');
const DB_PATH = path.join(DATA_DIR, 'kin.db');
fs.mkdirSync(DATA_DIR, { recursive: true });   // fresh clone has no data/ yet
const db = new DatabaseSync(DB_PATH);

db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA foreign_keys = ON;

  CREATE TABLE IF NOT EXISTS messages (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    sender     TEXT    NOT NULL,        -- user id
    kind       TEXT    NOT NULL,        -- text | image | video | file | audio | system
    text       TEXT,                    -- message body / caption
    att_id     TEXT,                    -- attachment id (nullable)
    reply_to   INTEGER,                 -- message id being replied to (nullable)
    ts         INTEGER NOT NULL,
    edited_ts  INTEGER,
    deleted    INTEGER NOT NULL DEFAULT 0,
    read_by    TEXT    NOT NULL DEFAULT ''  -- csv of user ids that have read it
  );
  CREATE INDEX IF NOT EXISTS idx_messages_ts ON messages(ts);

  CREATE TABLE IF NOT EXISTS attachments (
    id         TEXT    PRIMARY KEY,      -- random hex
    orig_name  TEXT    NOT NULL,
    mime       TEXT    NOT NULL,
    size       INTEGER NOT NULL,
    disk_name  TEXT    NOT NULL,         -- name on disk (random, no ext trust)
    owner      TEXT    NOT NULL,
    ts         INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS reactions (
    msg_id  INTEGER NOT NULL,
    user_id TEXT    NOT NULL,
    emoji   TEXT    NOT NULL,
    PRIMARY KEY (msg_id, user_id, emoji)
  );

  CREATE TABLE IF NOT EXISTS push_subs (
    endpoint TEXT PRIMARY KEY,
    user_id  TEXT NOT NULL,
    sub_json TEXT NOT NULL,
    ts       INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS scheduled (
    id       INTEGER PRIMARY KEY AUTOINCREMENT,
    sender   TEXT    NOT NULL,
    kind     TEXT    NOT NULL,
    text     TEXT,
    att_id   TEXT,
    reply_to INTEGER,
    send_at  INTEGER NOT NULL,
    created  INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_sched_due ON scheduled(send_at);
`);

const q = {
  insertMessage: db.prepare(
    `INSERT INTO messages (sender, kind, text, att_id, reply_to, ts, read_by)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ),
  getMessage: db.prepare(`SELECT * FROM messages WHERE id = ?`),
  recentMessages: db.prepare(
    `SELECT * FROM messages ORDER BY id DESC LIMIT ?`
  ),
  messagesBefore: db.prepare(
    `SELECT * FROM messages WHERE id < ? ORDER BY id DESC LIMIT ?`
  ),
  markRead: db.prepare(`UPDATE messages SET read_by = ? WHERE id = ?`),
  editMessage: db.prepare(`UPDATE messages SET text = ?, edited_ts = ? WHERE id = ? AND sender = ?`),
  deleteMessage: db.prepare(`UPDATE messages SET deleted = 1, text = NULL, att_id = NULL WHERE id = ? AND sender = ?`),
  insertAttachment: db.prepare(
    `INSERT INTO attachments (id, orig_name, mime, size, disk_name, owner, ts)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ),
  getAttachment: db.prepare(`SELECT * FROM attachments WHERE id = ?`),
  addReaction: db.prepare(`INSERT OR IGNORE INTO reactions (msg_id, user_id, emoji) VALUES (?, ?, ?)`),
  removeReaction: db.prepare(`DELETE FROM reactions WHERE msg_id = ? AND user_id = ? AND emoji = ?`),
  reactionsFor: db.prepare(`SELECT user_id, emoji FROM reactions WHERE msg_id = ?`),
  addPushSub: db.prepare(`INSERT OR REPLACE INTO push_subs (endpoint, user_id, sub_json, ts) VALUES (?, ?, ?, ?)`),
  removePushSub: db.prepare(`DELETE FROM push_subs WHERE endpoint = ?`),
  pushSubsFor: db.prepare(`SELECT endpoint, sub_json FROM push_subs WHERE user_id = ?`),
  setText: db.prepare(`UPDATE messages SET text = ? WHERE id = ? AND sender = ?`),
  insertScheduled: db.prepare(`INSERT INTO scheduled (sender, kind, text, att_id, reply_to, send_at, created) VALUES (?, ?, ?, ?, ?, ?, ?)`),
  getScheduled: db.prepare(`SELECT * FROM scheduled WHERE id = ?`),
  listScheduled: db.prepare(`SELECT * FROM scheduled WHERE sender = ? AND send_at > ? ORDER BY send_at`),
  dueScheduled: db.prepare(`SELECT * FROM scheduled WHERE send_at <= ? ORDER BY send_at`),
  delScheduled: db.prepare(`DELETE FROM scheduled WHERE id = ?`),
  delScheduledOwned: db.prepare(`DELETE FROM scheduled WHERE id = ? AND sender = ?`)
};

function rowToMessage(r) {
  if (!r) return null;
  const reactions = q.reactionsFor.all(r.id).map(x => ({ user: x.user_id, emoji: x.emoji }));
  let att = null;
  if (!r.deleted && r.att_id) {
    const a = q.getAttachment.get(r.att_id);
    if (a) att = { name: a.orig_name, mime: a.mime, size: a.size };
  }
  return {
    id: r.id,
    sender: r.sender,
    kind: r.kind,
    text: r.deleted ? null : r.text,
    att_id: r.deleted ? null : r.att_id,
    att,
    reply_to: r.reply_to,
    ts: r.ts,
    edited_ts: r.edited_ts,
    deleted: !!r.deleted,
    read_by: r.read_by ? r.read_by.split(',').filter(Boolean) : [],
    reactions
  };
}

module.exports = {
  db,
  addMessage(sender, kind, text, att_id, reply_to) {
    const ts = Date.now();
    const info = q.insertMessage.run(sender, kind, text ?? null, att_id ?? null, reply_to ?? null, ts, sender);
    return rowToMessage(q.getMessage.get(info.lastInsertRowid));
  },
  getMessage(id) { return rowToMessage(q.getMessage.get(id)); },
  recent(limit = 50) {
    return q.recentMessages.all(limit).reverse().map(rowToMessage);
  },
  before(id, limit = 50) {
    return q.messagesBefore.all(id, limit).reverse().map(rowToMessage);
  },
  markRead(id, userId) {
    const r = q.getMessage.get(id);
    if (!r) return null;
    const set = new Set((r.read_by || '').split(',').filter(Boolean));
    set.add(userId);
    q.markRead.run([...set].join(','), id);
    return rowToMessage(q.getMessage.get(id));
  },
  edit(id, sender, text) {
    q.editMessage.run(text, Date.now(), id, sender);
    return rowToMessage(q.getMessage.get(id));
  },
  remove(id, sender) {
    q.deleteMessage.run(id, sender);
    return rowToMessage(q.getMessage.get(id));
  },
  addAttachment(rec) {
    q.insertAttachment.run(rec.id, rec.orig_name, rec.mime, rec.size, rec.disk_name, rec.owner, Date.now());
  },
  getAttachment(id) { return q.getAttachment.get(id); },
  react(msgId, userId, emoji, on) {
    if (on) q.addReaction.run(msgId, userId, emoji);
    else q.removeReaction.run(msgId, userId, emoji);
    return rowToMessage(q.getMessage.get(msgId));
  },
  q_addPushSub(userId, endpoint, json) { q.addPushSub.run(endpoint, userId, json, Date.now()); },
  q_removePushSub(endpoint) { q.removePushSub.run(endpoint); },
  pushSubsFor(userId) { return q.pushSubsFor.all(userId); },
  // location live-update: patch the JSON payload stored in a location message's text
  setText(id, sender, text) { q.setText.run(text, id, sender); return rowToMessage(q.getMessage.get(id)); },
  // scheduled send
  addScheduled(s) {
    const info = q.insertScheduled.run(s.sender, s.kind, s.text ?? null, s.att_id ?? null, s.reply_to ?? null, s.send_at, Date.now());
    return q.getScheduled.get(info.lastInsertRowid);
  },
  listScheduled(sender) { return q.listScheduled.all(sender, Date.now()); },
  dueScheduled() { return q.dueScheduled.all(Date.now()); },
  cancelScheduled(id, sender) { return q.delScheduledOwned.run(id, sender).changes > 0; },
  removeScheduled(id) { q.delScheduled.run(id); },
  // wipe the whole conversation; returns disk filenames of attachments to delete
  clearConversation() {
    const files = db.prepare('SELECT disk_name FROM attachments').all().map(r => r.disk_name);
    db.exec('DELETE FROM messages; DELETE FROM reactions; DELETE FROM scheduled; DELETE FROM attachments;');
    return files;
  }
};
