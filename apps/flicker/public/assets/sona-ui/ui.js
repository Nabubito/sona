/* Sona UI: tiny runtime helpers shared by the apps. No dependencies.
     Sona.icon('play')                   -> '<svg class="s-i">…</svg>' string
     Sona.toast('Saved', {error:true})   -> shows the shared toast
     Sona.open(scrimEl) / Sona.close()   -> sheet or dialog with focus handling
     Sona.skeleton('rows'|'tiles', n)    -> placeholder markup while loading */
(function () {
  'use strict';
  var BASE = (document.currentScript && document.currentScript.src || '').replace(/ui\.js(\?.*)?$/, '') || '/assets/sona-ui/';
  var SPRITE = BASE + 'icons.svg';

  function icon(name, cls) {
    return '<svg class="s-i' + (cls ? ' ' + cls : '') + '" aria-hidden="true" focusable="false"><use href="' + SPRITE + '#' + name + '"/></svg>';
  }

  var toastEl, toastTimer;
  function toast(text, opts) {
    opts = opts || {};
    if (!toastEl) {
      toastEl = document.createElement('div');
      toastEl.className = 's-toast'; toastEl.setAttribute('role', 'status'); toastEl.setAttribute('aria-live', 'polite');
      document.body.appendChild(toastEl);
    }
    toastEl.classList.toggle('s-toast--error', !!opts.error);
    toastEl.innerHTML = (opts.icon ? icon(opts.icon) : '') + '<span></span>';
    toastEl.lastChild.textContent = text;
    requestAnimationFrame(function () { toastEl.classList.add('is-shown'); });
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { toastEl.classList.remove('is-shown'); }, opts.ms || 2600);
  }

  // sheets: remember what had focus, move focus in, trap Tab, close on Escape or scrim tap
  var stack = [];
  var FOCUSABLE = 'a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])';
  function open(scrim) {
    if (!scrim || scrim.hasAttribute('data-open')) return;
    stack.push({ el: scrim, back: document.activeElement });
    scrim.hidden = false; void scrim.offsetWidth;
    scrim.setAttribute('data-open', '');
    var first = scrim.querySelector('[autofocus]') || scrim.querySelector(FOCUSABLE);
    setTimeout(function () { try { (first || scrim).focus({ preventScroll: true }); } catch (e) {} }, 30);
  }
  function close(scrim) {
    var entry = scrim ? stack.filter(function (s) { return s.el === scrim; })[0] : stack[stack.length - 1];
    if (!entry) return;
    stack.splice(stack.indexOf(entry), 1);
    entry.el.removeAttribute('data-open');
    try { entry.back && entry.back.focus({ preventScroll: true }); } catch (e) {}
  }
  document.addEventListener('keydown', function (e) {
    var top = stack[stack.length - 1]; if (!top) return;
    if (e.key === 'Escape') { e.preventDefault(); close(top.el); return; }
    if (e.key !== 'Tab') return;
    var f = [].slice.call(top.el.querySelectorAll(FOCUSABLE)).filter(function (n) { return n.offsetParent !== null; });
    if (!f.length) return;
    var a = f[0], z = f[f.length - 1];
    if (e.shiftKey && document.activeElement === a) { e.preventDefault(); z.focus(); }
    else if (!e.shiftKey && document.activeElement === z) { e.preventDefault(); a.focus(); }
  });
  document.addEventListener('click', function (e) {
    var closer = e.target.closest('[data-sheet-close]');
    if (closer) { close(closer.closest('.s-scrim')); return; }
    if (e.target.classList && e.target.classList.contains('s-scrim') && e.target.hasAttribute('data-open')) close(e.target);
    var opener = e.target.closest('[data-sheet-open]');
    if (opener) { var t = document.getElementById(opener.getAttribute('data-sheet-open')); if (t) { e.preventDefault(); open(t); } }
  });

  function skeleton(kind, n) {
    n = n || 6; var out = '';
    if (kind === 'tiles') {
      out = '<div class="s-grid" aria-hidden="true">';
      for (var i = 0; i < n; i++) out += '<div><div class="s-skel s-skel--tile"></div><div class="s-skel s-skel--text" style="width:70%;margin-top:10px"></div><div class="s-skel s-skel--text" style="width:45%;margin-top:6px"></div></div>';
      return out + '</div>';
    }
    out = '<div aria-hidden="true">';
    for (var j = 0; j < n; j++) out += '<div class="s-skel-row"><div class="s-skel s-skel--media"></div><div class="s-skel-row__lines"><div class="s-skel s-skel--text" style="width:' + (50 + (j * 37) % 40) + '%"></div><div class="s-skel s-skel--text" style="width:' + (25 + (j * 23) % 30) + '%"></div></div></div>';
    return out + '</div>';
  }

  window.Sona = { icon: icon, toast: toast, open: open, close: close, skeleton: skeleton, sprite: SPRITE };
})();
