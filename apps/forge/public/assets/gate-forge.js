// Forge lock screen. Lives under /assets so it loads before the auth wall,
// and it is an external file so the page needs no inline script at all.
(function () {
  'use strict';
  var $ = function (id) { return document.getElementById(id); };
  var gate = $('gate');
  var SPRITE = '/assets/sona-ui/icons.svg#';

  // show / hide the passcode
  Array.prototype.forEach.call(document.querySelectorAll('.s-pass__eye'), function (b) {
    b.addEventListener('click', function () {
      var i = $(b.getAttribute('data-for')), show = i.type === 'password';
      i.type = show ? 'text' : 'password';
      b.querySelector('use').setAttribute('href', SPRITE + (show ? 'eye-off' : 'eye'));
      b.setAttribute('aria-label', show ? 'Hide passcode' : 'Show passcode');
      b.setAttribute('title', show ? 'Hide passcode' : 'Show passcode');
      b.setAttribute('aria-pressed', String(show));
      i.focus();
    });
  });

  var setup = false, minLen = 4;
  function say(m, kind) {
    var e = $('e');
    e.textContent = m || '';
    if (kind) e.setAttribute('data-kind', kind); else e.removeAttribute('data-kind');
  }
  function shake() {
    gate.classList.remove('is-shake'); void gate.offsetWidth; gate.classList.add('is-shake');
    try { if (navigator.vibrate) navigator.vibrate(60); } catch (err) {}
  }
  function fail(m) { say(m, 'error'); shake(); }

  fetch('/api/auth/status').then(function (r) { return r.json(); }).then(function (s) {
    if (s.authed) { location.href = '/'; return; }
    minLen = s.minLength || 4;
    if (s.mode === 'setup') {
      if (s.canSetup) {
        setup = true;
        $('setupNote').hidden = false; $('row2').hidden = false;
        $('setupNote').textContent = 'First run. Choose the passcode that will unlock Forge from now on, at least ' + minLen + ' characters. Letters and numbers both work.';
        $('p1').placeholder = 'New passcode'; $('p1').autocomplete = 'new-password';
        $('p1Label').textContent = 'New passcode';
        $('go').textContent = 'Set passcode';
      } else {
        $('remoteNote').hidden = false; $('f').hidden = true;
      }
    }
  }).catch(function () { fail('Cannot reach Forge.'); });

  $('f').addEventListener('submit', function (ev) {
    ev.preventDefault();
    var v = $('p1').value;
    if (!v) return fail('Enter your passcode.');
    if (setup) {
      if (v.length < minLen) return fail('Use at least ' + minLen + ' characters.');
      if (v !== $('p2').value) return fail('The two entries do not match.');
    }
    $('go').disabled = true; say('');
    gate.classList.add('is-busy');
    fetch(setup ? '/api/auth/setup' : '/api/auth', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ passcode: v })
    }).then(function (r) {
      if (r.ok) { say('Welcome home.', 'ok'); gate.classList.add('is-open'); setTimeout(function () { location.href = '/'; }, 280); return; }
      return r.json().catch(function () { return {}; }).then(function (j) {
        if (r.status === 429) fail('Locked. Too many tries, wait a few minutes.');
        else if (setup) fail(j.error || 'Could not save the passcode.');
        else fail('That is not the key.');
        done();
      });
    }).catch(function () { fail('Network error.'); done(); });
  });
  function done() { gate.classList.remove('is-busy'); $('go').disabled = false; $('p1').select(); }
})();
