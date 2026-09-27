/* Sona UI: color scheme (auto / light / dark).
   Load in <head> without defer so the page never flashes the wrong theme.
   Sets <html data-scheme="light|dark"> (the resolved scheme) and
   data-scheme-pref="auto|light|dark" (what the person picked).
   Any element with data-scheme-set="auto|light|dark" becomes a switch. */
(function () {
  'use strict';
  var KEY = 'sona-scheme';
  var root = document.documentElement;
  var mq = window.matchMedia ? window.matchMedia('(prefers-color-scheme: light)') : null;

  function pref() {
    try { var v = localStorage.getItem(KEY); return v === 'light' || v === 'dark' ? v : 'auto'; } catch (e) { return 'auto'; }
  }
  function resolve(p) { return p === 'auto' ? (mq && mq.matches ? 'light' : 'dark') : p; }
  function apply() {
    var p = pref(), r = resolve(p);
    root.setAttribute('data-scheme', r);
    root.setAttribute('data-scheme-pref', p);
    var btns = document.querySelectorAll('[data-scheme-set]');
    for (var i = 0; i < btns.length; i++) btns[i].setAttribute('aria-pressed', String(btns[i].getAttribute('data-scheme-set') === p));
    // single cycling buttons show the current choice as their icon
    var cyc = document.querySelectorAll('[data-scheme-cycle]');
    var names = { auto: 'Automatic', light: 'Light', dark: 'Dark' }, icons = { auto: 'auto', light: 'sun', dark: 'moon' };
    for (var j = 0; j < cyc.length; j++) {
      cyc[j].setAttribute('aria-label', 'Theme: ' + names[p] + '. Tap to change.');
      cyc[j].setAttribute('title', 'Theme: ' + names[p]);
      var use = cyc[j].querySelector('use');
      if (use) use.setAttribute('href', use.getAttribute('href').replace(/#.*$/, '#' + icons[p]));
    }
    var meta = document.querySelector('meta[name="theme-color"]:not([data-fixed])');
    if (meta && document.body) {
      var bg = getComputedStyle(document.body).getPropertyValue('--bg').trim() || getComputedStyle(root).getPropertyValue('--bg').trim();
      if (bg) meta.setAttribute('content', bg);
    }
    try { document.dispatchEvent(new CustomEvent('sona:scheme', { detail: { pref: p, scheme: r } })); } catch (e) {}
  }
  function set(p) {
    try { if (p === 'auto') localStorage.removeItem(KEY); else localStorage.setItem(KEY, p); } catch (e) {}
    apply();
  }
  function cycle() { var order = ['auto', 'light', 'dark']; set(order[(order.indexOf(pref()) + 1) % 3]); }

  apply();
  if (mq) { if (mq.addEventListener) mq.addEventListener('change', apply); else if (mq.addListener) mq.addListener(apply); }
  document.addEventListener('DOMContentLoaded', apply);
  document.addEventListener('click', function (e) {
    var b = e.target.closest && e.target.closest('[data-scheme-set],[data-scheme-cycle]');
    if (!b) return;
    if (b.hasAttribute('data-scheme-cycle')) cycle(); else set(b.getAttribute('data-scheme-set'));
  });
  window.SonaScheme = { get: pref, set: set, cycle: cycle, resolved: function () { return root.getAttribute('data-scheme'); } };
})();
