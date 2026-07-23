// Real push notifications via VAPID Web Push. These surface as OS-level
// notifications (Android notification shade, Windows toast) even when the app
// is fully closed — not tab-only popups. The TWA delegates them to native.
'use strict';
const webpush = require('web-push');
const fs = require('fs');
const path = require('path');
const db = require('./db');

const VAPID_PATH = path.join(__dirname, 'data', 'vapid.json');
function loadKeys() {
  try { return JSON.parse(fs.readFileSync(VAPID_PATH, 'utf8')); }
  catch {
    const k = webpush.generateVAPIDKeys();
    fs.writeFileSync(VAPID_PATH, JSON.stringify(k, null, 2));
    return k;
  }
}
const vapid = loadKeys();
webpush.setVapidDetails(process.env.SONA_PUSH_CONTACT || 'mailto:push@sona.local', vapid.publicKey, vapid.privateKey);

module.exports = {
  publicKey: vapid.publicKey,
  subscribe(userId, sub) {
    if (!sub || !sub.endpoint) return;
    db.q_addPushSub(userId, sub.endpoint, JSON.stringify(sub));
  },
  unsubscribe(endpoint) { if (endpoint) db.q_removePushSub(endpoint); },
  async sendToUser(userId, payload) {
    const subs = db.pushSubsFor(userId);
    await Promise.all(subs.map(async s => {
      try { await webpush.sendNotification(JSON.parse(s.sub_json), JSON.stringify(payload)); }
      catch (e) { if (e && (e.statusCode === 410 || e.statusCode === 404)) db.q_removePushSub(s.endpoint); }
    }));
  }
};
