/* Sona UI: the lock screen.
   One behavior for every app. Configure on the .s-gate element:
     data-len="4"                 digits in the passcode
     data-endpoint="/api/auth"    POST target; omit to handle the code yourself
     data-field="passcode"        JSON field name for the code
     data-next="/"                where to go after a correct code
   Without data-endpoint the gate fires a `sona:pin` event instead:
     gate.addEventListener('sona:pin', e => { e.detail.code; e.detail.ok(); e.detail.fail('Wrong passcode'); })
   Wording avoids dashes on purpose (house style). */
(function () {
  'use strict';
  var gate = document.querySelector('.s-gate[data-sona-gate]');
  if (!gate) return;
  var LEN = parseInt(gate.getAttribute('data-len'), 10) || 4;
  var dotsBox = gate.querySelector('.s-gate__dots');
  var msg = gate.querySelector('.s-gate__msg');
  var code = '', busy = false;

  // build the dots once so markup stays short
  if (dotsBox && !dotsBox.children.length) for (var i = 0; i < LEN; i++) dotsBox.appendChild(document.createElement('i'));
  var dots = dotsBox ? dotsBox.querySelectorAll('i') : [];

  function say(text, kind) { if (!msg) return; msg.textContent = text || ''; if (kind) msg.setAttribute('data-kind', kind); else msg.removeAttribute('data-kind'); }
  function render() {
    for (var i = 0; i < dots.length; i++) dots[i].classList.toggle('on', i < code.length);
    if (dotsBox) dotsBox.setAttribute('aria-label', code.length + ' of ' + LEN + ' digits entered');
  }
  function fail(text) {
    gate.classList.remove('is-busy');
    say(text || 'That is not the key.', 'error');
    gate.classList.remove('is-shake'); void gate.offsetWidth; gate.classList.add('is-shake');
    if (navigator.vibrate) try { navigator.vibrate(60); } catch (e) {}
    setTimeout(function () { gate.classList.remove('is-shake'); code = ''; busy = false; render(); }, 440);
  }
  function ok(then) {
    busy = false; gate.classList.remove('is-busy');
    say('Welcome home.', 'ok'); gate.classList.add('is-open');
    var reduce = window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches;
    setTimeout(function () { if (typeof then === 'function') then(); }, reduce ? 0 : 420);
  }
  function submit() {
    busy = true; gate.classList.add('is-busy'); say('');
    var endpoint = gate.getAttribute('data-endpoint');
    var entered = code;
    if (!endpoint) {
      gate.dispatchEvent(new CustomEvent('sona:pin', { detail: { code: entered, ok: ok, fail: fail } }));
      return;
    }
    var body = {}; body[gate.getAttribute('data-field') || 'passcode'] = entered;
    fetch(endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), credentials: 'same-origin' })
      .then(function (r) {
        if (r.ok) return ok(function () { location.href = gate.getAttribute('data-next') || '/'; });
        return r.json().catch(function () { return {}; }).then(function (j) {
          fail(r.status === 429 || j.error === 'locked' ? 'Too many tries. Take a breath and try again a little later.' : 'That is not the key.');
        });
      })
      .catch(function () { fail('Could not reach home. Check your connection.'); });
  }
  function press(k) {
    if (busy) return;
    if (k === 'clr') { code = ''; say(''); return render(); }
    if (k === 'del') { code = code.slice(0, -1); return render(); }
    if (!/^[0-9]$/.test(k) || code.length >= LEN) return;
    if (msg && msg.getAttribute('data-kind') === 'error') say('');
    code += k; render();
    if (code.length === LEN) setTimeout(submit, 90);
  }
  function flash(k) {
    var b = gate.querySelector('[data-k="' + k + '"]'); if (!b) return;
    b.classList.add('is-down'); setTimeout(function () { b.classList.remove('is-down'); }, 130);
  }

  gate.addEventListener('click', function (e) {
    var b = e.target.closest('[data-k]'); if (!b) return;
    press(b.getAttribute('data-k'));
  });
  document.addEventListener('keydown', function (e) {
    if (gate.hidden || gate.classList.contains('hidden') || getComputedStyle(gate).display === 'none') return;
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    var t = e.target; if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA')) return;
    if (/^[0-9]$/.test(e.key)) { press(e.key); flash(e.key); e.preventDefault(); }
    else if (e.key === 'Backspace') { press('del'); flash('del'); e.preventDefault(); }
    else if (e.key === 'Escape') { press('clr'); flash('clr'); }
  });

  render();
  window.SonaGate = {
    reset: function () { code = ''; busy = false; gate.classList.remove('is-busy', 'is-open', 'is-shake'); say(''); render(); },
    fail: fail, ok: ok
  };
})();
