# Sona UI

The shared design system for Kin, Reel, Attic, Forge and Flicker. One set of tokens,
one set of components, one lock screen, so the five apps read as one product.

Warm charcoal and ember gold. Cormorant Garamond for the voice, Jost for the work.
The flame at the center of a home.

## See it

The showcase renders every token and component live from the real files:

```bash
node design/sync.mjs --serve
# open http://127.0.0.1:4173/
```

(Opening `index.html` straight from disk mostly works, but browsers block the icon
sprite on `file://`, so use the tiny server above.)

## Files

| File | What it is |
|---|---|
| `tokens.css` | Fonts, color (dark default + warm light), fluid type scale, spacing, radius, elevation, motion, layout sizes. |
| `components.css` | Everything visual, all classes prefixed `s-`: buttons, inputs, cards, sheets, drawers, tabs, segmented controls, toasts, lists, media tiles, chips, badges, avatars, menus, empty states, skeletons, app bar, sidebar, tab bar, and the lock screen. |
| `icons.svg` | One SVG sprite. 24px grid, 1.75 stroke, `currentColor`. |
| `theme.js` | Auto, light or dark. Load it in `<head>` (not deferred) so there is no flash. |
| `gate.js` | Lock screen behavior shared by every app. |
| `ui.js` | Small helpers: `Sona.icon()`, `Sona.toast()`, `Sona.open()` and `Sona.close()` for sheets, `Sona.skeleton()`. |
| `flame.svg` | The mark, also used as the favicon. |
| `fonts/` | Self-hosted Jost and Cormorant Garamond (variable weight woff2). |

## Privacy rule

Nothing in here requests anything from another origin. No CDN, no Google Fonts, no
analytics. Fonts and icons are files next to the CSS. Keep it that way: privacy is
the product.

## Using it in an app

Each app carries its own copy in `public/assets/sona-ui/`, so every app stays
deployable on its own. Never edit the copies. Edit `design/sona-ui/`, then run:

```bash
node design/sync.mjs          # copy into apps/kin, reel, attic, forge, flicker
node design/sync.mjs --check  # exit 1 if any copy has drifted (good for CI)
```

In a page:

```html
<meta name="theme-color" content="#161311">
<link rel="icon" href="/assets/sona-ui/flame.svg" type="image/svg+xml">
<link rel="stylesheet" href="/assets/sona-ui/tokens.css">
<link rel="stylesheet" href="/assets/sona-ui/components.css">
<script src="/assets/sona-ui/theme.js"></script>
...
<script src="/assets/sona-ui/ui.js"></script>
```

For every app, `/assets` is served before the auth wall, which is what lets
the lock screen load its own CSS, fonts and icons while logged out. Anything the
gate needs must live under `/assets`.

## Tokens

Use semantic tokens, never raw hex, so light mode and future themes just work.

| Group | Tokens |
|---|---|
| Surfaces | `--bg`, `--bg-tint`, `--surface-1` (cards), `--surface-2` (raised, hover), `--surface-3` (pressed, tracks), `--surface-glass` (app bar, tab bar) |
| Text | `--text`, `--text-2` (secondary), `--text-3` (meta, placeholders), `--accent-text` (links, active labels) |
| Accent | `--wordmark-grad` (display text gradient, deeper in light mode), `--accent` (fills), `--accent-hover`, `--accent-press`, `--accent-ink` (text on accent), `--accent-soft`, `--accent-softer` |
| Lines | `--border`, `--border-strong`, `--border-accent` |
| Status | `--success`, `--danger`, `--warning` and their `-soft` backgrounds |
| Type | `--font-display`, `--font-ui`, `--font-mono`, `--fs-2xs` to `--fs-4xl` (fluid), `--lh-*`, `--tracking-*` |
| Space | `--sp-1` (4px) to `--sp-20` (80px), `--gutter` (fluid page padding) |
| Shape | `--r-xs` 6, `--r-sm` 10, `--r-md` 14, `--r-lg` 20, `--r-xl` 28, `--r-full` |
| Depth | `--shadow-1` to `--shadow-4`, `--glow-accent`, `--lit-edge` |
| Motion | `--ease-out`, `--ease-spring`, `--ease-in-out`, `--dur-fast` 140ms, `--dur-base` 220ms, `--dur-slow` 360ms, `--dur-slower` 560ms |
| Layout | `--tap` (44px), `--appbar-h`, `--tabbar-h`, `--sidebar-w`, `--safe-t/b/l/r` |

Every text pair on every surface clears WCAG AA (4.5:1) in both themes. Brand
constants (`--brand-ember`, `--brand-grad`) never change with the theme.

### Light and dark

Dark is the default. The warm light theme applies when the OS prefers light and the
person has not chosen, or when they pick it. `theme.js` stores the choice per app
and sets `<html data-scheme="light|dark">`. Any element becomes a switch:

```html
<div class="s-seg" role="group" aria-label="Theme">
  <button class="s-seg__btn" data-scheme-set="auto">Auto</button>
  <button class="s-seg__btn" data-scheme-set="light">Light</button>
  <button class="s-seg__btn" data-scheme-set="dark">Dark</button>
</div>
<!-- or one button that cycles and updates its own icon -->
<button class="s-iconbtn" data-scheme-cycle><svg class="s-i"><use href="/assets/sona-ui/icons.svg#auto"/></svg></button>
```

### Motion

Short and springy, never decorative for its own sake. With reduced motion switched
on, every token duration drops to 1ms, looping ambient animations stop, and
skeleton shimmer holds still.

## Components (cheat sheet)

```html
<!-- buttons: all at least 44px tall -->
<button class="s-btn s-btn--primary">Play all</button>
<button class="s-btn">Secondary</button>  <button class="s-btn s-btn--ghost">Ghost</button>
<button class="s-iconbtn" aria-label="Search"><svg class="s-i" aria-hidden="true"><use href="/assets/sona-ui/icons.svg#search"/></svg></button>

<!-- inputs (16px minimum so phones do not zoom) -->
<label class="s-field"><span class="s-label">Name</span><input class="s-input"></label>
<div class="s-search"><svg class="s-i"><use href="/assets/sona-ui/icons.svg#search"/></svg><input class="s-input" type="search"></div>

<!-- sheet: bottom sheet on phones, centered dialog from 720px -->
<div class="s-scrim" id="mySheet">
  <section class="s-sheet" role="dialog" aria-modal="true" aria-labelledby="t">
    <header class="s-sheet__head"><h2 class="s-sheet__title" id="t">Title</h2>
      <button class="s-iconbtn" data-sheet-close aria-label="Close">…</button></header>
    <div class="s-sheet__body">…</div>
  </section>
</div>
<button data-sheet-open="mySheet">Open</button>   <!-- or Sona.open(el) -->

<!-- media tile, list row, empty state, skeleton -->
<a class="s-tile"><div class="s-tile__art" style="background-image:url(…)"></div><div class="s-tile__title">Album</div><div class="s-tile__sub">Artist</div></a>
<button class="s-list__item"><span class="s-list__media"></span><span class="s-list__main"><span class="s-list__title">Song</span><span class="s-list__sub">Artist</span></span></button>
<div class="s-empty"><div class="s-empty__icon">…</div><h2 class="s-empty__title">Nothing yet</h2><p class="s-empty__text">What to do next.</p></div>
<div class="s-skel s-skel--tile"></div>   <!-- or Sona.skeleton('rows', 6) -->

<!-- navigation -->
<header class="s-appbar">…</header>
<nav class="s-tabbar s-tabbar--mobile"><a class="s-tabbar__item" aria-current="page">…</a></nav>
<aside class="s-sidebar"><a class="s-navlink" aria-current="page">…</a></aside>
```

## The lock screen

Identical in every app. Only the name, the tagline and the config differ.

```html
<main class="s-gate" data-sona-gate data-len="4"
      data-endpoint="/api/auth" data-field="passcode" data-next="/">
  <div class="s-gate__glow" aria-hidden="true"></div><div class="s-gate__grain" aria-hidden="true"></div>
  <div class="s-gate__panel">
    <div class="s-gate__mark" aria-hidden="true"><!-- inline flame svg --></div>
    <h1 class="s-gate__name">Attic</h1>
    <p class="s-gate__tag">Your photos</p>
    <div class="s-gate__dots" role="status" aria-live="polite"></div>
    <p class="s-gate__msg" role="alert"></p>
    <div class="s-gate__pad" role="group" aria-label="Passcode keypad">
      <button type="button" class="s-key" data-k="1">1</button> … <button type="button" class="s-key" data-k="0">0</button>
      <button type="button" class="s-key s-key--fn" data-k="clr">Clear</button>
      <button type="button" class="s-key s-key--fn" data-k="del" aria-label="Delete">…</button>
    </div>
  </div>
  <p class="s-gate__foot"><b>Sona</b><span aria-hidden="true">·</span><span>under your roof</span></p>
</main>
<script src="/assets/sona-ui/gate.js"></script>
```

Forge and Flicker take a longer text passcode (8 characters or more) instead of
digits, so they swap the keypad for the passphrase variant. Same glow, mark, name,
tagline and footer; each app's own small script handles the form (Forge also runs
its first run setup through it):

```html
<form class="s-gate__form" autocomplete="off">
  <label class="s-visually-hidden" for="pass">Passcode</label>
  <div class="s-pass">
    <input class="s-input" id="pass" type="password" autocomplete="current-password" placeholder="Passcode">
    <button type="button" class="s-iconbtn s-pass__eye" aria-label="Show passcode" aria-pressed="false"><svg class="s-i" aria-hidden="true"><use href="/assets/sona-ui/icons.svg#eye"/></svg></button>
  </div>
  <button class="s-btn s-btn--primary s-btn--lg s-btn--block" type="submit">Unlock</button>
</form>
<p class="s-gate__msg" role="alert"></p>
```

Leave out `data-endpoint` to handle the code yourself (Kin does this, because its
login returns a token instead of setting a cookie):

```js
gate.addEventListener('sona:pin', e => {
  checkCode(e.detail.code).then(ok => ok ? e.detail.ok(enterApp) : e.detail.fail('Wrong passcode'));
});
```

Digits, Backspace and Escape work from a keyboard. A wrong code shakes the dots and
buzzes on phones that support it.

## House style

- Copy is plain and warm. No em dashes or en dashes anywhere in UI text; use
  commas, periods or colons.
- Every control is at least 44 by 44 pixels.
- Every interactive element shows the focus ring when reached by keyboard.
- Empty states say what to do next. Loading states show skeletons, not spinners.
