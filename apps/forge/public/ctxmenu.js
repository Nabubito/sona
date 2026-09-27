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
    menu.className = 'ctxmenu s-menu';
    menu.setAttribute('role', 'menu');
    items.forEach(it => {
      if (it.sep) { const h = document.createElement('div'); h.className = 'ctx-sep s-menu__sep'; h.setAttribute('role', 'separator'); menu.appendChild(h); return; }
      const b = document.createElement('button');
      b.type = 'button';
      b.setAttribute('role', 'menuitem');
      b.className = 'ctx-item s-menu__item' + (it.danger ? ' danger s-menu__item--danger' : '') + (it.disabled ? ' disabled' : '');
      // icon from the shared sprite (never a Unicode glyph, which can render as an empty box)
      b.innerHTML = it.icon && window.Sona ? window.Sona.icon(it.icon) : '';
      const lbl = document.createElement('span'); lbl.textContent = it.label; b.appendChild(lbl);
      if (it.disabled) { b.disabled = true; menu.appendChild(b); return; }
      let armed = false, t = 0;
      b.onclick = (e) => {
        e.stopPropagation();
        if (it.danger && !armed) { armed = true; const old = lbl.textContent; lbl.textContent = 'Click again to confirm'; b.classList.add('armed'); t = setTimeout(() => { armed = false; lbl.textContent = old; b.classList.remove('armed'); }, 2500); return; }
        clearTimeout(t); close(); try { it.run(); } catch (err) { if (window.toast) window.toast(String(err.message || err)); }
      };
      menu.appendChild(b);
    });
    menu.style.left = x + 'px'; menu.style.top = y + 'px';
    document.body.appendChild(menu);
    const first = menu.querySelector('button:not([disabled])'); if (first) first.focus({ preventScroll: true });
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
  // clicks inside the menu belong to its items (a danger item needs a second click to confirm)
  window.addEventListener('click', e => { if (menu && menu.contains(e.target)) return; close(); }, true);
  window.addEventListener('blur', e => { if (e.target === window) close(); });
  window.addEventListener('scroll', close, true);
  window.addEventListener('resize', close);
  document.addEventListener('keydown', e => {
    if (!menu) return;
    if (e.key === 'Escape') { close(); return; }
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      const items = [...menu.querySelectorAll('button:not([disabled])')]; if (!items.length) return;
      e.preventDefault();
      const i = items.indexOf(document.activeElement);
      items[(i + (e.key === 'ArrowDown' ? 1 : items.length - 1)) % items.length].focus();
    }
  });
})();
