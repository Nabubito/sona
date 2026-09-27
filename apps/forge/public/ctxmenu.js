// Reusable right-click context menu. One delegated listener survives every
// innerHTML rerender. Elements opt in with data-ctx="<provider>"; a provider
// reads the element's data-* and returns items computed from live state.
(function () {
  const providers = {};
  window.CTX = {
    register(name, fn) { providers[name] = fn; },
    copyText(t) { try { navigator.clipboard.writeText(String(t)); } catch {} if (window.toast) window.toast('Copied'); }
  };

  let menu = null;
  function close() { if (menu) { menu.remove(); menu = null; } }

  function show(items, x, y) {
    close();
    menu = document.createElement('div');
    menu.className = 'ctxmenu';
    items.forEach(it => {
      if (it.sep) { const h = document.createElement('div'); h.className = 'ctx-sep'; menu.appendChild(h); return; }
      const b = document.createElement('button');
      b.className = 'ctx-item' + (it.danger ? ' danger' : '') + (it.disabled ? ' disabled' : '');
      b.textContent = it.label;
      if (it.disabled) { b.disabled = true; menu.appendChild(b); return; }
      let armed = false, t = 0;
      b.onclick = (e) => {
        e.stopPropagation();
        if (it.danger && !armed) { armed = true; const old = b.textContent; b.textContent = 'Click again to confirm'; b.classList.add('armed'); t = setTimeout(() => { armed = false; b.textContent = old; b.classList.remove('armed'); }, 2500); return; }
        clearTimeout(t); close(); try { it.run(); } catch (err) { if (window.toast) window.toast(String(err.message || err)); }
      };
      menu.appendChild(b);
    });
    menu.style.left = x + 'px'; menu.style.top = y + 'px';
    document.body.appendChild(menu);
    // clamp inside viewport (flip so the cursor stays on the first item edge)
    const r = menu.getBoundingClientRect();
    if (r.right > innerWidth) menu.style.left = Math.max(4, x - r.width) + 'px';
    if (r.bottom > innerHeight) menu.style.top = Math.max(4, y - r.height) + 'px';
  }

  document.addEventListener('contextmenu', e => {
    if (e.target.closest('input,textarea,[contenteditable]')) return;   // keep native edit menu
    const el = e.target.closest('[data-ctx]');
    if (!el) return;
    const prov = providers[el.dataset.ctx];
    if (!prov) return;
    let items; try { items = prov(el, e); } catch { items = null; }
    if (!items || !items.length) return;
    e.preventDefault();
    show(items, e.clientX, e.clientY);
  });
  ['click', 'blur'].forEach(ev => window.addEventListener(ev, close, true));
  window.addEventListener('scroll', close, true);
  window.addEventListener('resize', close);
  document.addEventListener('keydown', e => { if (e.key === 'Escape') close(); });
})();
