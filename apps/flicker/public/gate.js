/* Flicker lock screen. Letters and numbers both work, and the eye shows what you typed. */
(function () {
  'use strict';
  var form = document.getElementById('form');
  var pass = document.getElementById('pass');
  var eye = document.getElementById('eye');
  var go = document.getElementById('go');
  var e = document.getElementById('e');

  eye.addEventListener('click', function () {
    var show = pass.type === 'password';
    pass.type = show ? 'text' : 'password';
    eye.setAttribute('aria-pressed', show ? 'true' : 'false');
    eye.setAttribute('aria-label', show ? 'Hide passcode' : 'Show passcode');
    pass.focus();
  });

  form.addEventListener('submit', function (ev) {
    ev.preventDefault();
    var v = pass.value;
    if (!v) return;
    go.disabled = true;
    e.className = 'gate-err';
    e.textContent = '';
    fetch('/api/auth', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ passcode: v }), credentials: 'same-origin' })
      .then(function (r) {
        if (r.ok) { e.className = 'gate-err ok'; e.textContent = 'Welcome home.'; location.href = '/'; return; }
        return r.json().catch(function () { return {}; }).then(function (j) {
          e.textContent = (j.error === 'locked' || r.status === 429) ? 'Locked for a while: too many tries.' : 'That is not the key.';
          pass.select();
        });
      })
      .catch(function () { e.textContent = 'Could not reach Flicker.'; })
      .then(function () { go.disabled = false; });
  });

  pass.focus();
})();
