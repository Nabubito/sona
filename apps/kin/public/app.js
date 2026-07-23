'use strict';
// ═══════════════ Kin client ═══════════════
const $ = s => document.querySelector(s);
const el = (t, c) => { const e = document.createElement(t); if (c) e.className = c; return e; };
const esc = s => (s == null ? '' : String(s).replace(/[&<>"']/g, m => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[m])));

const S = {
  token: sessionStorage.getItem('kin_token') || '',   // sessionStorage ⇒ cold start after app exit
  me: null, roster: [], ice: [{ urls: 'stun:stun.l.google.com:19302' }],
  ws: null, online: [], replyTo: null, editing: null,
  oldestId: null, typingTimer: null, peerTyping: false,
};
const peer = () => S.roster.find(u => u.id !== S.me?.id) || { id: '?', name: 'Contact', avatar: '·' };

function toast(msg, ms = 2400) {
  const t = $('#toast'); t.textContent = msg; t.classList.remove('hidden');
  clearTimeout(t._t); t._t = setTimeout(() => t.classList.add('hidden'), ms);
}
const nameOf = id => (S.roster.find(u => u.id === id) || {}).name || id;

// ════════════ THEME ════════════
const THEMES = ['amour', 'chambers', 'obsidian', 'turquoise', 'violet'];
function applyTheme(t) {
  if (!THEMES.includes(t)) t = 'amour';
  document.documentElement.setAttribute('data-theme', t);
  localStorage.setItem('kin_theme', t);
  document.querySelector('meta[name=theme-color]')?.setAttribute('content',
    getComputedStyle(document.documentElement).getPropertyValue('--head1').trim() || '#14233f');
  document.querySelectorAll('.sw').forEach(s => s.classList.toggle('active', s.dataset.t === t));
}
// One-time migration to the Amour rebrand: adopt it once for everyone,
// then respect any theme the user picks afterward.
if (localStorage.getItem('kin_theme_v') !== '2') {
  localStorage.setItem('kin_theme', 'amour');
  localStorage.setItem('kin_theme_v', '2');
}
applyTheme(localStorage.getItem('kin_theme') || 'amour');
document.addEventListener('DOMContentLoaded', () => {
  $('#btnTheme') && ($('#btnTheme').onclick = e => { e.stopPropagation(); $('#themePop').classList.toggle('hidden'); });
  document.querySelectorAll('.sw').forEach(s => s.onclick = () => { applyTheme(s.dataset.t); $('#themePop').classList.add('hidden'); });
  document.addEventListener('click', () => $('#themePop')?.classList.add('hidden'));
});

// ════════════ PASSCODE GATE ════════════
let pin = '';
function renderPin() {
  document.querySelectorAll('#pinDots i').forEach((d, i) => d.classList.toggle('on', i < pin.length));
}
$('#keypad').addEventListener('click', e => {
  const b = e.target.closest('button'); if (!b) return;
  const k = b.dataset.k;
  if (k === 'back') pin = pin.slice(0, -1);
  else if (k === 'clear') pin = '';
  else if (pin.length < 4) pin += k;
  renderPin();
  $('#pinError').textContent = '';
  if (pin.length === 4) submitPin();
});
document.addEventListener('keydown', e => {
  if (!$('#gate').classList.contains('hidden')) {
    if (/^[0-9]$/.test(e.key) && pin.length < 4) { pin += e.key; renderPin(); if (pin.length === 4) submitPin(); }
    else if (e.key === 'Backspace') { pin = pin.slice(0, -1); renderPin(); }
  }
});
async function submitPin() {
  const code = pin; pin = '';
  try {
    const r = await fetch('/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ passcode: code }) });
    const j = await r.json();
    if (!r.ok) throw new Error(j.error || 'Login failed');
    S.token = j.token; S.me = j.user; S.roster = j.roster; S.ice = j.ice || S.ice;
    sessionStorage.setItem('kin_token', S.token);
    enterApp();
  } catch (err) {
    $('#pinError').textContent = err.message;
    $('#pinDots').classList.add('shake');
    setTimeout(() => { $('#pinDots').classList.remove('shake'); renderPin(); }, 420);
  }
}

// ════════════ SESSION BOOTSTRAP ════════════
async function boot() {
  if (!S.token) return;
  try {
    const r = await fetch('/api/session', { headers: { 'X-Kin-Token': S.token } });
    if (!r.ok) throw 0;
    const j = await r.json();
    S.me = j.user; S.roster = j.roster; S.ice = j.ice || S.ice;
    enterApp();
  } catch { sessionStorage.removeItem('kin_token'); S.token = ''; }
}

function enterApp() {
  $('#gate').classList.add('hidden');
  $('#app').classList.remove('hidden');
  const p = peer();
  $('#peerName').textContent = p.name;
  $('#peerAvatar').textContent = p.avatar;
  buildEmoji();
  toggleSendMic();
  buildSettings();
  loadHistory().then(connectWS);
  setupPush();
}

function buildSettings() {
  $('#tpWhoami').innerHTML = 'Signed in as <b>' + esc(S.me.name) + '</b>';
  const box = $('#tpActions'); box.innerHTML = '';
  if (S.me.owner) {
    const b = el('button', 'tp-btn danger');
    b.innerHTML = '🗑️ Clear chat history';
    b.onclick = async () => {
      $('#themePop').classList.add('hidden');
      if (!confirm('Clear the ENTIRE chat history for both of you? This cannot be undone.')) return;
      try {
        const r = await fetch('/api/clear', { method: 'POST', headers: { 'X-Kin-Token': S.token } });
        if (!r.ok) throw 0; toast('Chat cleared');
      } catch { toast('Clear failed'); }
    };
    box.appendChild(b);
  }
}

function lock() {
  fetch('/api/logout', { method: 'POST', headers: { 'X-Kin-Token': S.token } }).catch(() => {});
  sessionStorage.removeItem('kin_token');
  location.reload();
}
$('#btnLock').onclick = lock;

// ════════════ WEBSOCKET ════════════
function connectWS() {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  S.ws = new WebSocket(`${proto}://${location.host}/ws?token=${encodeURIComponent(S.token)}`);
  S.ws.onmessage = ev => handleWS(JSON.parse(ev.data));
  S.ws.onclose = e => { if (e.code === 4001) return lock(); setTimeout(() => { if (S.token) connectWS(); }, 1500); };
  S.ws.onerror = () => {};
}
function wsSend(o) { if (S.ws && S.ws.readyState === 1) S.ws.send(JSON.stringify(o)); }

function handleWS(m) {
  switch (m.t) {
    case 'welcome': S.online = m.online; updatePresence(); break;
    case 'presence': S.online = m.online; updatePresence(); break;
    case 'msg':
      addMessage(m.message, true);
      if (m.message.sender !== S.me.id) {
        markDelivered(m.message.id);              // their device has it now
        if (isViewing()) markRead(m.message.id);  // …and only "read" if we're actually looking
      } else if (m.message.kind === 'location' && S.pendingLive) {
        try { const p = JSON.parse(m.message.text); if (p.live && p.until > Date.now()) startLiveWatch(m.message.id, p.until); } catch {}
        S.pendingLive = null;
      }
      break;
    case 'delivered': applyDelivered(m.id); break;
    case 'read': applyRead(m.id, m.read_by); break;
    case 'react': replaceMessage(m.message); break;
    case 'edit': replaceMessage(m.message); break;
    case 'delete': replaceMessage(m.message); break;
    case 'geo': applyGeo(m); break;
    case 'cleared': renderedIds.clear(); loadHistory(); toast('Chat history cleared'); break;
    case 'typing': showTyping(m.on); break;
    case 'call': onCallSignal(m); break;
  }
}
function updatePresence() {
  const on = S.online.includes(peer().id);
  const s = $('#peerStatus');
  s.textContent = on ? 'online' : 'offline';
  s.classList.toggle('online', on);
}

// ════════════ HISTORY / RENDER ════════════
let renderedIds = new Set();
async function loadHistory(before) {
  const r = await fetch('/api/history' + (before ? `?before=${before}` : ''), { headers: { 'X-Kin-Token': S.token } });
  const j = await r.json();
  const msgs = j.messages || [];
  if (!before) { $('#messages').querySelectorAll('.row,.day-sep').forEach(n => n.remove()); renderedIds.clear(); }
  if (msgs.length) S.oldestId = msgs[0].id;
  $('#loadMore').classList.toggle('hidden', msgs.length < 50);
  const box = $('#messages');
  const anchor = before ? box.scrollHeight : 0;
  const frag = document.createDocumentFragment();
  let lastDay = '', lastSender = null;
  for (const msg of msgs) {
    const day = new Date(msg.ts).toDateString();
    if (day !== lastDay) { frag.appendChild(daySep(msg.ts)); lastDay = day; lastSender = null; }
    frag.appendChild(rowFor(msg, lastSender));
    lastSender = msg.sender; renderedIds.add(msg.id);
  }
  if (before) { box.insertBefore(frag, box.querySelector('.day-sep,.row')); box.scrollTop = box.scrollHeight - anchor; }
  else { box.appendChild(frag); box._lastDay = lastDay; scrollBottom(); markVisibleRead(msgs); refreshSeen(); }
}
$('#loadMore').onclick = () => S.oldestId && loadHistory(S.oldestId);

function daySep(ts) {
  const d = new Date(ts), now = new Date();
  const label = d.toDateString() === now.toDateString() ? 'Today'
    : d.toDateString() === new Date(now - 864e5).toDateString() ? 'Yesterday'
    : d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
  const s = el('div', 'day-sep'); s.textContent = label; return s;
}
const timeStr = ts => new Date(ts).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
const isEmojiOnly = t => t && /^(\p{Extended_Pictographic}|️|‍|\s){1,6}$/u.test(t) && [...t].length <= 4;

function rowFor(msg, prevSender) {
  const mine = msg.sender === S.me.id;
  const row = el('div', `row ${mine ? 'me' : 'them'}`);
  const first = msg.sender !== prevSender;
  if (first) row.classList.add('first');
  row.dataset.id = msg.id;
  if (mine && (msg.read_by || []).some(u => u !== S.me.id)) row.dataset.read = '1';
  if (first) { const nm = el('div', 'sender-name'); nm.textContent = nameOf(msg.sender); row.appendChild(nm); }
  const bubble = el('div', 'bubble');
  if (msg.deleted) { bubble.innerHTML = `<div class="msg-deleted">🚫 message deleted</div>`; row.appendChild(bubble); return row; }
  let html = '';
  if (msg.reply_to) { const rt = document.querySelector(`.row[data-id="${msg.reply_to}"] .body`); html += `<div class="reply-quote">${rt ? esc(rt.textContent.slice(0, 80)) : 'message'}</div>`; }
  if (msg.kind === 'sticker') {
    bubble.classList.add('sticker-only');
    const src = msg.att_id ? `/api/file/${msg.att_id}?token=${encodeURIComponent(S.token)}` : '/' + esc(String(msg.text || ''));
    html += `<img class="att-sticker" src="${src}" loading="lazy">`;
  } else if (msg.kind === 'location') {
    html += locationHTML(msg);
  } else {
    html += attachmentHTML(msg);
    if (msg.text) html += `<div class="body">${linkify(esc(msg.text))}</div>`;
    if (isEmojiOnly(msg.text) && msg.kind === 'text') bubble.classList.add('emoji-only');
  }
  html += `<div class="meta"><span>${timeStr(msg.ts)}${msg.edited_ts ? ' · edited' : ''}</span>${mine ? tickHTML(msg) : ''}</div>`;
  bubble.innerHTML = html;
  if (msg.reactions && msg.reactions.length) bubble.appendChild(reactionsEl(msg));
  bubble.oncontextmenu = e => { e.preventDefault(); openBubbleMenu(row, msg); };
  let pressT; bubble.addEventListener('touchstart', () => { pressT = setTimeout(() => openBubbleMenu(row, msg), 480); }, { passive: true });
  bubble.addEventListener('touchend', () => clearTimeout(pressT));
  row.appendChild(bubble);
  return row;
}
// message status for my own bubbles: sent → delivered → read
const deliveredIds = new Set();   // transient (peer device received)
function msgStatus(msg) {
  if ((msg.read_by || []).some(u => u !== S.me.id)) return 'read';
  if (deliveredIds.has(msg.id)) return 'delivered';
  return 'sent';
}
function tickHTML(msg) {
  const st = msgStatus(msg);
  const marks = st === 'sent' ? '✓' : '✓✓';
  const label = st === 'read' ? 'Read' : st === 'delivered' ? 'Delivered' : 'Sent';
  return `<span class="tick tick-${st}" title="${label}">${marks}</span>`;
}
function attachmentHTML(msg) {
  if (!msg.att_id) return '';
  const url = `/api/file/${msg.att_id}?token=${encodeURIComponent(S.token)}`;
  if (msg.kind === 'image') return `<img class="att-img" src="${url}" loading="lazy" onclick="window.open('${url}')">`;
  if (msg.kind === 'video') return `<video class="att-video" src="${url}" controls preload="metadata"></video>`;
  if (msg.kind === 'audio') return `<audio class="att-audio" src="${url}" controls preload="none"></audio>`;
  const nm = msg.att ? msg.att.name : 'File';
  const kb = msg.att ? (msg.att.size > 1048576 ? (msg.att.size / 1048576).toFixed(1) + ' MB' : Math.max(1, Math.round(msg.att.size / 1024)) + ' KB') : 'Download';
  return `<a class="att-file" href="${url}" target="_blank" download="${esc(nm)}"><span class="fi">📄</span><span><span class="fname">${esc(nm)}</span><span class="fsize">${kb}</span></span></a>`;
}
function reactionsEl(msg) {
  const wrap = el('div', 'reactions');
  const counts = {};
  msg.reactions.forEach(r => counts[r.emoji] = (counts[r.emoji] || 0) + 1);
  for (const [em, n] of Object.entries(counts)) { const c = el('span', 'chip'); c.textContent = n > 1 ? `${em} ${n}` : em; wrap.appendChild(c); }
  return wrap;
}
function linkify(s) { return s.replace(/(https?:\/\/[^\s<]+)/g, u => `<a href="${u}" target="_blank" rel="noopener" style="color:inherit;text-decoration:underline">${u}</a>`); }
function locationHTML(msg) {
  let p = {}; try { p = JSON.parse(msg.text || '{}'); } catch {}
  const lat = +p.lat, lng = +p.lng;
  const live = p.live && p.until && p.until > Date.now();
  const map = `/api/staticmap?lat=${lat}&lng=${lng}&token=${encodeURIComponent(S.token)}`;
  const gmaps = `https://www.google.com/maps?q=${lat},${lng}`;
  return `<a class="loc-card" href="${gmaps}" target="_blank" rel="noopener">
    <img class="loc-map" src="${map}" loading="lazy">
    <div class="loc-meta"><span class="loc-pin">📍</span><span class="loc-text">
      <span class="loc-title">${live ? '<span class="loc-live">Live location</span>' : 'Location'}</span>
      <span class="loc-sub" data-coord>${isFinite(lat) ? lat.toFixed(5) : '?'}, ${isFinite(lng) ? lng.toFixed(5) : '?'}${p.acc ? ' · ±' + p.acc + 'm' : ''}</span>
    </span></div></a>`;
}
function applyGeo(m) {
  const card = document.querySelector(`.row[data-id="${m.id}"] .loc-card`);
  if (!card) return;
  const img = card.querySelector('.loc-map');
  if (img) img.src = `/api/staticmap?lat=${m.lat}&lng=${m.lng}&token=${encodeURIComponent(S.token)}&_=${Date.now()}`;
  const c = card.querySelector('[data-coord]');
  if (c) c.textContent = `${(+m.lat).toFixed(5)}, ${(+m.lng).toFixed(5)}${m.acc ? ' · ±' + m.acc + 'm' : ''}`;
  card.href = `https://www.google.com/maps?q=${m.lat},${m.lng}`;
}

function addMessage(msg, live) {
  if (renderedIds.has(msg.id)) { replaceMessage(msg); return; }
  const box = $('#messages');
  const rows = box.querySelectorAll('.row');
  const prev = rows.length ? rows[rows.length - 1].dataset.sender : null;
  const lastDay = box._lastDay;
  const day = new Date(msg.ts).toDateString();
  const nearBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 120;
  if (day !== lastDay) { box.appendChild(daySep(msg.ts)); box._lastDay = day; }
  const row = rowFor(msg, live ? null : prev);
  row.dataset.sender = msg.sender;
  box.appendChild(row); renderedIds.add(msg.id);
  if (nearBottom || msg.sender === S.me.id) scrollBottom();
}
function replaceMessage(msg) {
  const old = document.querySelector(`.row[data-id="${msg.id}"]`);
  if (!old) return;
  const fresh = rowFor(msg, old.classList.contains('first') ? null : 'x');
  fresh.dataset.sender = msg.sender;
  old.replaceWith(fresh);
}
function scrollBottom() { const b = $('#messages'); b.scrollTop = b.scrollHeight; }

// ── delivery + read receipts ──
const readSent = new Set();  // ids we've already told the server we read (avoid spam)
function isViewing() { return document.visibilityState === 'visible' && !$('#app').classList.contains('hidden'); }
function markDelivered(id) { wsSend({ t: 'delivered', id }); }
function markRead(id) { if (readSent.has(id)) return; readSent.add(id); wsSend({ t: 'read', id }); }
function markVisibleRead(msgs) { msgs.filter(m => m.sender !== S.me.id && !(m.read_by || []).includes(S.me.id)).forEach(m => markRead(m.id)); }
// when the window regains focus, "read" every one of their messages on screen
function flushRead() {
  if (!isViewing() || !S.me) return;
  document.querySelectorAll('.row.them[data-id]').forEach(r => markRead(+r.dataset.id));
}
document.addEventListener('visibilitychange', flushRead);
window.addEventListener('focus', flushRead);

function setTickState(id, state) {
  const tick = document.querySelector(`.row[data-id="${id}"] .tick`);
  if (!tick) return;
  tick.className = `tick tick-${state}`;
  tick.textContent = state === 'sent' ? '✓' : '✓✓';
  tick.title = state === 'read' ? 'Read' : state === 'delivered' ? 'Delivered' : 'Sent';
}
function applyDelivered(id) {
  deliveredIds.add(id);
  const tick = document.querySelector(`.row[data-id="${id}"] .tick`);
  if (tick && !tick.classList.contains('tick-read')) setTickState(id, 'delivered');
}
function applyRead(id, readBy) {
  if (!readBy.some(u => u !== S.me.id)) return;
  const row = document.querySelector(`.row[data-id="${id}"]`);
  if (row) row.dataset.read = '1';
  setTickState(id, 'read');
  refreshSeen();
}
// iMessage-style "Seen" under the most recent of MY messages they've read
function refreshSeen() {
  document.querySelectorAll('.seen-tag').forEach(n => n.remove());
  const mine = [...document.querySelectorAll('.row.me[data-id]')];
  for (let i = mine.length - 1; i >= 0; i--) {
    if (mine[i].dataset.read === '1') {
      const t = el('div', 'seen-tag'); t.textContent = '✓ Seen';
      mine[i].appendChild(t); break;
    }
  }
}

// typing
function showTyping(on) {
  const r = $('#typingRow');
  if (on) {
    r.innerHTML = `<div class="typing-bubble"><span></span><span></span><span></span></div>`;
    r.classList.add('on'); scrollBottom();
  } else { r.innerHTML = ''; r.classList.remove('on'); }
  const st = $('#peerStatus');
  if (st) { st.textContent = on ? 'typing…' : (S.online.includes(peer().id) ? 'online' : 'offline'); st.classList.toggle('is-typing', on); }
}

// ════════════ COMPOSE ════════════
const composer = $('#composer');
function toggleSendMic() {
  const has = composer.value.trim().length > 0;
  $('#btnSend').classList.toggle('hidden', !has);
  $('#btnMic').classList.toggle('hidden', has);
}
composer.addEventListener('input', () => {
  composer.style.height = 'auto';
  composer.style.height = Math.min(composer.scrollHeight, 120) + 'px';
  toggleSendMic();
  wsSend({ t: 'typing', on: true });
  clearTimeout(S.typingTimer);
  S.typingTimer = setTimeout(() => wsSend({ t: 'typing', on: false }), 1500);
});
composer.addEventListener('keydown', e => {
  if (e.key === 'Enter' && !e.shiftKey && window.matchMedia('(min-width:760px)').matches) { e.preventDefault(); sendText(); }
});
$('#btnSend').onclick = sendText;
function sendText() {
  const text = composer.value.trim();
  if (!text) return;
  if (S.editing) { wsSend({ t: 'edit', id: S.editing, text }); S.editing = null; }
  else wsSend({ t: 'msg', kind: 'text', text, reply_to: S.replyTo });
  composer.value = ''; composer.style.height = 'auto';
  clearReply();
  wsSend({ t: 'typing', on: false });
}

// reply
function setReply(msg) {
  S.replyTo = msg.id;
  $('#replyBar').classList.remove('hidden');
  const body = document.querySelector(`.row[data-id="${msg.id}"] .body`);
  $('#replyTo').textContent = 'Replying: ' + (body ? body.textContent.slice(0, 60) : 'message');
  composer.focus();
}
function clearReply() { S.replyTo = null; $('#replyBar').classList.add('hidden'); }
$('#replyCancel').onclick = clearReply;

// bubble menu (reply / react / edit / delete)
function openBubbleMenu(row, msg) {
  document.querySelectorAll('.bubble-menu').forEach(n => n.remove());
  const mine = msg.sender === S.me.id;
  const menu = el('div', 'bubble-menu');
  const btns = [['↩️', () => setReply(msg)], ['❤️', () => wsSend({ t: 'react', id: msg.id, emoji: '❤️', on: true })], ['👍', () => wsSend({ t: 'react', id: msg.id, emoji: '👍', on: true })], ['😂', () => wsSend({ t: 'react', id: msg.id, emoji: '😂', on: true })]];
  if (mine && msg.kind === 'text') btns.push(['✏️', () => { S.editing = msg.id; composer.value = msg.text; composer.focus(); }]);
  if (mine) btns.push(['🗑️', () => { if (confirm('Delete this message?')) wsSend({ t: 'delete', id: msg.id }); }]);
  btns.forEach(([ic, fn]) => { const b = el('button'); b.textContent = ic; b.onclick = e => { e.stopPropagation(); fn(); menu.remove(); }; menu.appendChild(b); });
  row.querySelector('.bubble').appendChild(menu);
  setTimeout(() => document.addEventListener('click', () => menu.remove(), { once: true }), 0);
}

// ════════════ EXPRESSION PANEL (emoji / stickers / gif) ════════════
function buildEmoji() { /* lazy — built on first open */ }
let exprTab = 'emoji', stickerCache = null, gifDebounce = null;
function closePanels() { $('#exprPanel').classList.add('hidden'); $('#attachMenu').classList.add('hidden'); }
$('#btnEmoji').onclick = () => {
  $('#attachMenu').classList.add('hidden');
  const p = $('#exprPanel'); const show = p.classList.contains('hidden');
  p.classList.toggle('hidden'); if (show) selectExprTab(exprTab);
};
document.querySelectorAll('.expr-tab').forEach(t => t.onclick = () => selectExprTab(t.dataset.tab));
function selectExprTab(tab) {
  exprTab = tab;
  document.querySelectorAll('.expr-tab').forEach(t => t.classList.toggle('active', t.dataset.tab === tab));
  $('#gifSearch').classList.toggle('hidden', tab !== 'gif');
  const body = $('#exprBody'); body.innerHTML = '';
  if (tab === 'emoji') renderEmojiTab(body);
  else if (tab === 'stickers') renderStickerTab(body);
  else renderGifTab(body, $('#gifQuery').value.trim());
}
function insertEmoji(em) {
  const s = composer.selectionStart ?? composer.value.length;
  composer.value = composer.value.slice(0, s) + em + composer.value.slice(composer.selectionEnd ?? s);
  composer.focus(); composer.selectionStart = composer.selectionEnd = s + em.length;
  toggleSendMic();
}
function renderEmojiTab(body) {
  for (const [cat, list] of Object.entries(window.KIN_EMOJI || {})) {
    const h = el('div', 'emoji-cat'); h.textContent = cat; body.appendChild(h);
    const grid = el('div', 'emoji-grid');
    list.forEach(em => { const b = el('button'); b.textContent = em; b.onclick = () => insertEmoji(em); grid.appendChild(b); });
    body.appendChild(grid);
  }
}
async function renderStickerTab(body) {
  body.innerHTML = '<div class="expr-loading">Loading stickers…</div>';
  try {
    if (!stickerCache) stickerCache = await fetch('/assets/stickers/stickers.json').then(r => r.json());
    body.innerHTML = '';
    for (const group of stickerCache) {
      const h = el('div', 'emoji-cat'); h.textContent = group.cat; body.appendChild(h);
      const grid = el('div', 'sticker-grid');
      group.items.forEach(s => { const img = el('img'); img.src = '/' + s.file; img.loading = 'lazy'; img.onclick = () => sendSticker(s.file); grid.appendChild(img); });
      body.appendChild(grid);
    }
  } catch { body.innerHTML = '<div class="expr-hint">Stickers unavailable.</div>'; }
}
function sendSticker(file) {
  wsSend({ t: 'msg', kind: 'sticker', text: file, reply_to: S.replyTo });
  clearReply(); closePanels();
}
function renderGifTab(body, query) {
  body.innerHTML = '<div class="expr-loading">Searching…</div>';
  fetch('/api/gif/search?kind=gifs&q=' + encodeURIComponent(query), { headers: { 'X-Kin-Token': S.token } })
    .then(r => r.ok ? r.json() : Promise.reject())
    .then(j => {
      if (!j.items || !j.items.length) throw 0;
      body.innerHTML = '';
      const grid = el('div', 'gif-grid');
      j.items.forEach(g => { const img = el('img'); img.src = g.thumb; img.loading = 'lazy'; img.onclick = () => sendGif(g.id); grid.appendChild(img); });
      body.appendChild(grid);
    })
    .catch(() => { body.innerHTML = '<div class="expr-hint">GIF search needs a free Giphy key.<br>Add it to <b>config.json</b> → then search here.<br><br>Meanwhile, try the <b>✨ Stickers</b> tab — they’re animated too.</div>'; });
}
$('#gifQuery').addEventListener('input', e => { clearTimeout(gifDebounce); const q = e.target.value.trim(); gifDebounce = setTimeout(() => renderGifTab($('#exprBody'), q), 350); });
async function sendGif(id) {
  toast('Sending…', 8000);
  try {
    const j = await fetch('/api/gif/send', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Kin-Token': S.token }, body: JSON.stringify({ id, kind: 'gifs' }) }).then(r => r.json());
    if (!j.id) throw 0;
    wsSend({ t: 'msg', kind: j.kind || 'image', att_id: j.id, reply_to: S.replyTo });
    clearReply(); closePanels(); $('#toast').classList.add('hidden');
  } catch { toast('GIF failed'); }
}

// ════════════ ATTACHMENTS + ACTIONS MENU ════════════
$('#btnAttach').onclick = () => { $('#exprPanel').classList.add('hidden'); $('#attachMenu').classList.toggle('hidden'); };
$('#attachMenu').addEventListener('click', e => {
  const b = e.target.closest('button'); if (!b) return;
  $('#attachMenu').classList.add('hidden');
  const act = b.dataset.act;
  if (act === 'photo') pickFile('image/*');
  else if (act === 'video') pickFile('video/*');
  else if (act === 'file') pickFile('*/*');
  else if (act === 'location') shareLocation(false);
  else if (act === 'live') shareLocation(true);
  else if (act === 'schedule') openSchedule();
});
function pickFile(accept) { $('#fileInput').accept = accept; $('#fileInput').click(); }
async function uploadFile(file, filename) {
  const fd = new FormData(); fd.append('file', file, filename || file.name);
  const r = await fetch('/api/upload', { method: 'POST', headers: { 'X-Kin-Token': S.token }, body: fd });
  const j = await r.json();
  if (!r.ok) throw new Error(j.error || 'Upload failed');
  return j;
}
$('#fileInput').addEventListener('change', async e => {
  const file = e.target.files[0]; e.target.value = '';
  if (!file) return;
  toast('Uploading ' + file.name + '…', 60000);
  try {
    const j = await uploadFile(file);
    wsSend({ t: 'msg', kind: j.kind, att_id: j.id, text: composer.value.trim() || null, reply_to: S.replyTo });
    composer.value = ''; toggleSendMic(); clearReply();
    $('#toast').classList.add('hidden');
  } catch (err) { toast(err.message); }
});

// ════════════ VOICE NOTES ════════════
const Rec = { mr: null, chunks: [], t0: 0, timer: null, waveTimer: null, stream: null };
function fmtSec(s) { return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; }
async function startRec() {
  try {
    Rec.stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  } catch { return toast('Microphone blocked'); }
  const mime = MediaRecorder.isTypeSupported('audio/webm;codecs=opus') ? 'audio/webm;codecs=opus'
    : MediaRecorder.isTypeSupported('audio/webm') ? 'audio/webm' : '';
  Rec.mr = new MediaRecorder(Rec.stream, mime ? { mimeType: mime } : undefined);
  Rec.chunks = [];
  Rec.mr.ondataavailable = e => { if (e.data.size) Rec.chunks.push(e.data); };
  Rec.mr.start();
  Rec.t0 = Date.now();
  $('#composeBar').classList.add('hidden');
  $('#recBar').classList.remove('hidden');
  const wave = $('#recWave'); wave.innerHTML = ''; for (let i = 0; i < 40; i++) wave.appendChild(el('span'));
  const bars = wave.querySelectorAll('span');
  Rec.waveTimer = setInterval(() => bars.forEach(b => b.style.height = (15 + Math.random() * 75) + '%'), 120);
  Rec.timer = setInterval(() => { $('#recTime').textContent = fmtSec(Math.floor((Date.now() - Rec.t0) / 1000)); }, 250);
}
function stopRecCleanup() {
  clearInterval(Rec.timer); clearInterval(Rec.waveTimer);
  if (Rec.stream) Rec.stream.getTracks().forEach(t => t.stop());
  $('#recBar').classList.add('hidden'); $('#composeBar').classList.remove('hidden');
  $('#recTime').textContent = '0:00';
}
function finishRec(send) {
  if (!Rec.mr) return stopRecCleanup();
  const secs = Math.round((Date.now() - Rec.t0) / 1000);
  Rec.mr.onstop = async () => {
    stopRecCleanup();
    if (!send || secs < 1) return;
    const blob = new Blob(Rec.chunks, { type: Rec.chunks[0]?.type || 'audio/webm' });
    toast('Sending voice note…', 30000);
    try {
      const j = await uploadFile(new File([blob], `voice-${Date.now()}.webm`, { type: blob.type }));
      wsSend({ t: 'msg', kind: 'audio', att_id: j.id, reply_to: S.replyTo });
      clearReply(); $('#toast').classList.add('hidden');
    } catch (e) { toast('Voice note failed'); }
  };
  try { Rec.mr.stop(); } catch { stopRecCleanup(); }
}
$('#btnMic').onclick = startRec;
$('#recSend').onclick = () => finishRec(true);
$('#recCancel').onclick = () => finishRec(false);

// ════════════ LOCATION (one-shot + 15-min live) ════════════
function shareLocation(live) {
  if (!navigator.geolocation) return toast('Location not supported');
  toast('Getting location…', 10000);
  navigator.geolocation.getCurrentPosition(pos => {
    $('#toast').classList.add('hidden');
    const p = { lat: +pos.coords.latitude.toFixed(6), lng: +pos.coords.longitude.toFixed(6), acc: Math.round(pos.coords.accuracy), live, until: live ? Date.now() + 15 * 60000 : 0, upd: Date.now() };
    if (live) S.pendingLive = p;
    wsSend({ t: 'msg', kind: 'location', text: JSON.stringify(p), reply_to: S.replyTo });
    clearReply();
  }, err => { $('#toast').classList.add('hidden'); toast('Location: ' + err.message); }, { enableHighAccuracy: true, timeout: 9000 });
}
function startLiveWatch(msgId, until) {
  if (S.liveWatch) { navigator.geolocation.clearWatch(S.liveWatch.id); }
  const wid = navigator.geolocation.watchPosition(pos => {
    if (Date.now() > until) { navigator.geolocation.clearWatch(wid); S.liveWatch = null; return; }
    wsSend({ t: 'geo', id: msgId, lat: +pos.coords.latitude.toFixed(6), lng: +pos.coords.longitude.toFixed(6), acc: Math.round(pos.coords.accuracy) });
  }, () => {}, { enableHighAccuracy: true, maximumAge: 5000 });
  S.liveWatch = { id: wid, msgId };
  setTimeout(() => { navigator.geolocation.clearWatch(wid); if (S.liveWatch && S.liveWatch.id === wid) S.liveWatch = null; }, Math.max(0, until - Date.now()));
}

// ════════════ SCHEDULE SEND ════════════
function openSchedule() {
  const text = composer.value.trim();
  $('#schedPreview').textContent = text ? '“' + text.slice(0, 80) + '”' : 'Type a message first, then schedule it.';
  const d = new Date(Date.now() + 3600000); d.setSeconds(0, 0);
  const tz = d.getTimezoneOffset() * 60000;
  $('#schedWhen').value = new Date(d - tz).toISOString().slice(0, 16);
  refreshSchedList();
  $('#schedModal').classList.remove('hidden');
}
$('#schedCancel').onclick = () => $('#schedModal').classList.add('hidden');
$('#schedConfirm').onclick = async () => {
  const text = composer.value.trim();
  if (!text) return toast('Type a message first');
  const when = new Date($('#schedWhen').value).getTime();
  if (!when || when < Date.now() + 3000) return toast('Pick a future time');
  try {
    const r = await fetch('/api/schedule', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Kin-Token': S.token }, body: JSON.stringify({ kind: 'text', text, send_at: when }) });
    const j = await r.json(); if (!r.ok) throw new Error(j.error);
    composer.value = ''; toggleSendMic();
    toast('Scheduled for ' + new Date(when).toLocaleString());
    refreshSchedList();
  } catch (e) { toast(e.message || 'Schedule failed'); }
};
async function refreshSchedList() {
  try {
    const j = await fetch('/api/scheduled', { headers: { 'X-Kin-Token': S.token } }).then(r => r.json());
    const box = $('#schedList'); box.innerHTML = '';
    (j.items || []).forEach(s => {
      const row = el('div', 'sched-item');
      row.innerHTML = `<span>🕒 ${new Date(s.send_at).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })} · ${esc((s.text || '').slice(0, 24))}</span>`;
      const del = el('button'); del.textContent = '✕'; del.onclick = async () => { await fetch('/api/scheduled/' + s.id, { method: 'DELETE', headers: { 'X-Kin-Token': S.token } }); refreshSchedList(); };
      row.appendChild(del); box.appendChild(row);
    });
  } catch {}
}

// ════════════ WEBRTC CALL ════════════
const Call = {
  pc: null, local: null, state: 'idle', video: false, incoming: null, timer: null, t0: 0,
};
function startCall(video) {
  if (Call.state !== 'idle') return;
  if (!S.online.includes(peer().id)) return toast(peer().name + ' is offline');
  Call.video = video; Call.state = 'calling';
  openCallUI('Calling…');
  wsSend({ t: 'call', kind: 'request', video });
  Call._ringTimeout = setTimeout(() => { if (Call.state === 'calling') { toast('No answer'); endCall(true); } }, 35000);
}
$('#btnCall').onclick = () => startCall(false);
$('#btnVideo').onclick = () => startCall(true);

function openCallUI(state) {
  const p = peer();
  $('#callAvatar').textContent = p.avatar;
  $('#callName').textContent = p.name;
  $('#callState').textContent = state;
  $('#callTimer').textContent = '';
  $('#callAvatar').classList.remove('connected');
  $('#btnAccept').classList.toggle('hidden', Call.state !== 'ringing');
  $('#callOverlay').classList.remove('hidden');
  $('#btnMute').classList.remove('muted'); $('#btnCam').classList.remove('off');
}

async function setupPC() {
  const pc = new RTCPeerConnection({ iceServers: S.ice });
  Call.pc = pc;
  Call.local = await navigator.mediaDevices.getUserMedia({ audio: true, video: Call.video });
  Call.local.getTracks().forEach(t => pc.addTrack(t, Call.local));
  if (Call.video) { const lv = $('#localVideo'); lv.srcObject = Call.local; lv.classList.add('on'); }
  pc.onicecandidate = e => { if (e.candidate) wsSend({ t: 'call', kind: 'ice', data: e.candidate }); };
  pc.ontrack = e => {
    const rv = $('#remoteVideo');
    rv.srcObject = e.streams[0];
    if (e.track.kind === 'video') rv.classList.add('on');
  };
  pc.onconnectionstatechange = () => {
    if (pc.connectionState === 'connected') markConnected();
    if (['failed', 'disconnected', 'closed'].includes(pc.connectionState) && Call.state === 'active') endCall(true);
  };
  return pc;
}
function markConnected() {
  if (Call.state === 'active') return;
  Call.state = 'active';
  clearTimeout(Call._ringTimeout);
  $('#callState').textContent = Call.video ? '' : 'Connected';
  $('#callAvatar').classList.add('connected');
  $('#btnAccept').classList.add('hidden');
  Call.t0 = Date.now();
  Call.timer = setInterval(() => {
    const s = Math.floor((Date.now() - Call.t0) / 1000);
    $('#callTimer').textContent = `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
  }, 1000);
}

async function onCallSignal(m) {
  const p = peer();
  switch (m.kind) {
    case 'request':
      if (Call.state !== 'idle') { wsSend({ t: 'call', kind: 'busy' }); return; }
      Call.state = 'ringing'; Call.video = m.video; Call.incoming = true;
      openCallUI(m.video ? 'Incoming video…' : 'Incoming call…');
      ringtone(true);
      break;
    case 'accept': {           // we are the caller → make the offer
      const pc = await setupPC();
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      wsSend({ t: 'call', kind: 'offer', data: offer, video: Call.video });
      $('#callState').textContent = 'Connecting…';
      break;
    }
    case 'offer': {            // we are the callee (already accepted)
      const pc = Call.pc || await setupPC();
      await pc.setRemoteDescription(m.data);
      const ans = await pc.createAnswer();
      await pc.setLocalDescription(ans);
      wsSend({ t: 'call', kind: 'answer', data: ans });
      break;
    }
    case 'answer':
      if (Call.pc) await Call.pc.setRemoteDescription(m.data);
      break;
    case 'ice':
      if (Call.pc && m.data) { try { await Call.pc.addIceCandidate(m.data); } catch {} }
      break;
    case 'reject': toast(p.name + ' declined'); endCall(false); break;
    case 'busy': toast(p.name + ' is busy'); endCall(false); break;
    case 'hangup': endCall(false); break;
  }
}
async function acceptCall() {
  ringtone(false);
  await setupPC();                       // prepare media before offer arrives
  wsSend({ t: 'call', kind: 'accept' });
  $('#btnAccept').classList.add('hidden');
  $('#callState').textContent = 'Connecting…';
}
$('#btnAccept').onclick = acceptCall;
$('#btnHangup').onclick = () => endCall(true);
$('#btnMute').onclick = () => {
  if (!Call.local) return;
  const t = Call.local.getAudioTracks()[0]; if (!t) return;
  t.enabled = !t.enabled; $('#btnMute').classList.toggle('muted', !t.enabled);
};
$('#btnCam').onclick = () => {
  if (!Call.local) return;
  const t = Call.local.getVideoTracks()[0]; if (!t) return toast('Audio call');
  t.enabled = !t.enabled; $('#btnCam').classList.toggle('off', !t.enabled);
  $('#localVideo').classList.toggle('on', t.enabled);
};

function endCall(notify) {
  if (notify && (Call.state !== 'idle')) wsSend({ t: 'call', kind: Call.state === 'ringing' ? 'reject' : 'hangup' });
  ringtone(false);
  clearTimeout(Call._ringTimeout); clearInterval(Call.timer);
  if (Call.pc) { try { Call.pc.close(); } catch {} }
  if (Call.local) Call.local.getTracks().forEach(t => t.stop());
  Call.pc = null; Call.local = null; Call.state = 'idle'; Call.incoming = null;
  $('#remoteVideo').classList.remove('on'); $('#remoteVideo').srcObject = null;
  $('#localVideo').classList.remove('on'); $('#localVideo').srcObject = null;
  $('#callOverlay').classList.add('hidden');
}

// simple ringtone via WebAudio (no asset needed)
let ringOsc;
function ringtone(on) {
  try {
    if (on) {
      const ctx = ringtone._ctx || (ringtone._ctx = new (window.AudioContext || window.webkitAudioContext)());
      const beep = () => {
        if (Call.state !== 'ringing') return;
        const o = ctx.createOscillator(), g = ctx.createGain();
        o.frequency.value = 520; o.connect(g); g.connect(ctx.destination);
        g.gain.setValueAtTime(0.001, ctx.currentTime);
        g.gain.exponentialRampToValueAtTime(0.15, ctx.currentTime + 0.05);
        g.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.5);
        o.start(); o.stop(ctx.currentTime + 0.55);
      };
      beep(); ringtone._iv = setInterval(beep, 1800);
    } else { clearInterval(ringtone._iv); }
  } catch {}
}

// ════════════ REAL PUSH NOTIFICATIONS ════════════
function urlB64ToUint8(base64) {
  const pad = '='.repeat((4 - base64.length % 4) % 4);
  const b64 = (base64 + pad).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(b64); return Uint8Array.from([...raw].map(c => c.charCodeAt(0)));
}
async function setupPush() {
  try {
    if (!('serviceWorker' in navigator) || !('PushManager' in window)) return;
    const reg = await navigator.serviceWorker.ready;
    if (Notification.permission === 'denied') return;
    if (Notification.permission !== 'granted') {
      const p = await Notification.requestPermission();
      if (p !== 'granted') return;
    }
    const { key } = await fetch('/api/push/pubkey', { headers: { 'X-Kin-Token': S.token } }).then(r => r.json());
    let sub = await reg.pushManager.getSubscription();
    if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlB64ToUint8(key) });
    await fetch('/api/push/subscribe', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Kin-Token': S.token }, body: JSON.stringify({ sub }) });
  } catch (e) { /* push is best-effort */ }
}

// service worker (PWA installable) — register, then wire push once ready
if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js?v=' + (window.__SWV || '0')).catch(() => {});

boot();
