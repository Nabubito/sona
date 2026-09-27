'use strict';
// Kin "get the app" page. Kin's CSP allows only same-origin scripts, so this
// lives in its own file (the old inline copy was blocked and never ran).
// If a download is not published yet, say so instead of leaving a dead link.
(async () => {
  for (const [id, url] of [['winBtn', '/downloads/Kin-Setup.exe'], ['apkBtn', '/downloads/kin.apk']]) {
    try { const r = await fetch(url, { method: 'HEAD' }); if (!r.ok) throw 0; }
    catch {
      const b = document.getElementById(id);
      b.textContent = 'Coming soon';
      b.removeAttribute('href'); b.removeAttribute('download');
      b.setAttribute('aria-disabled', 'true');
    }
  }
})();
