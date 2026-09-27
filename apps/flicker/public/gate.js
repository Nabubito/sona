/* Flicker lock screen, on the shared Sona passphrase gate. Letters and numbers both work, and the
   eye shows what you typed. Served above the auth wall; an external file, so the page needs no
   inline script at all. */
(function () {
  'use strict';
  var $ = function (id) { return document.getElementById(id); };
  var gate = $('gate'), form = $('form'), pass = $('pass'), eye = $('eye'), go = $('go'), e = $('e');
  var SPRITE = '/assets/sona-ui/icons.svg#';

  eye.addEventListener('click', function () {
    var show = pass.type === 'password';
    pass.type = show ? 'text' : 'password';
    eye.querySelector('use').setAttribute('href', SPRITE + (show ? 'eye-off' : 'eye'));
    eye.setAttribute('aria-pressed', show ? 'true' : 'false');
    eye.setAttribute('aria-label', show ? 'Hide passcode' : 'Show passcode');
    eye.setAttribute('title', show ? 'Hide passcode' : 'Show passcode');
    pass.focus();
  });

  function say(m, kind) {
    e.textContent = m || '';
    if (kind) e.setAttribute('data-kind', kind); else e.removeAttribute('data-kind');
  }
  function fail(m) {
    say(m, 'error');
    gate.classList.remove('is-shake'); void gate.offsetWidth; gate.classList.add('is-shake');
    try { if (navigator.vibrate) navigator.vibrate(60); } catch (err) { /* no buzz */ }
  }
  function done() { gate.classList.remove('is-busy'); go.disabled = false; pass.select(); }

  form.addEventListener('submit', function (ev) {
    ev.preventDefault();
    var v = pass.value;
    if (!v) { fail('Enter your passcode.'); pass.focus(); return; }
    go.disabled = true;
    say('');
    gate.classList.add('is-busy');
    fetch('/api/auth', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ passcode: v }), credentials: 'same-origin' })
      .then(function (r) {
        if (r.ok) {
          say('Welcome home.', 'ok');
          gate.classList.add('is-open');
          setTimeout(function () { location.href = '/'; }, 280);
          return;
        }
        return r.json().catch(function () { return {}; }).then(function (j) {
          fail((j.error === 'locked' || r.status === 429) ? 'Locked for a while: too many tries.' : 'That is not the key.');
          done();
        });
      })
      .catch(function () { fail('Could not reach Flicker.'); done(); });
  });

  pass.focus();
})();
