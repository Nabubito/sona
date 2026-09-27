/* sona.casa: small progressive enhancements. The page works without this file.
   1. Waitlist form posts in place and shows success or failure.
   2. Sections below the fold fade in as they arrive. */
(function () {
  'use strict';

  /* ---------- waitlist ---------- */
  var form = document.querySelector('.wl');
  if (form && window.fetch && window.URLSearchParams) {
    var input = form.querySelector('input[name="email"]');
    var button = form.querySelector('button[type="submit"]');
    var msg = form.querySelector('.wl__msg');
    var ok = document.getElementById('joined');
    var fail = document.getElementById('join-failed');
    var label = button.textContent;
    form.noValidate = true; // we show our own message instead of the browser bubble

    function show(panel) {
      ok.classList.remove('is-shown');
      fail.classList.remove('is-shown');
      if (panel) { panel.classList.add('is-shown'); panel.focus({ preventScroll: true }); }
    }

    input.addEventListener('input', function () {
      if (input.getAttribute('aria-invalid')) { input.removeAttribute('aria-invalid'); msg.textContent = ''; }
    });

    form.addEventListener('submit', function (e) {
      e.preventDefault();
      var email = input.value.trim();
      if (!email || !input.checkValidity()) {
        input.setAttribute('aria-invalid', 'true');
        msg.textContent = 'Please enter a valid email address.';
        input.focus();
        return;
      }
      button.setAttribute('aria-busy', 'true');
      button.disabled = true;
      button.textContent = 'Joining';
      show(null);

      fetch(form.getAttribute('action'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Accept': 'application/json' },
        body: new URLSearchParams({ email: email }).toString(),
        credentials: 'same-origin'
      }).then(function (res) {
        if (!res.ok || /join-failed/.test(res.url)) throw new Error('status ' + res.status);
        form.classList.add('is-done');
        show(ok);
      }).catch(function () {
        show(fail);
      }).then(function () {
        button.removeAttribute('aria-busy');
        button.disabled = false;
        button.textContent = label;
      });
    });
  }

  /* ---------- reveal ---------- */
  var reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (!reduce && 'IntersectionObserver' in window) {
    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (en) {
        if (en.isIntersecting) { en.target.classList.remove('is-pending'); io.unobserve(en.target); }
      });
    }, { rootMargin: '0px 0px -8% 0px' });
    var fold = window.innerHeight;
    document.querySelectorAll('.reveal').forEach(function (el) {
      if (el.getBoundingClientRect().top > fold) { el.classList.add('is-pending'); io.observe(el); }
    });
    window.addEventListener('beforeprint', function () {
      document.querySelectorAll('.is-pending').forEach(function (el) { el.classList.remove('is-pending'); });
    });
  }
})();
