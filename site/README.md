# site

The static source of [sona.casa](https://sona.casa). Plain HTML, CSS and a little
vanilla JS. No build step, no framework, and no requests to any other origin: fonts,
images and icons are all files in this folder.

## Preview

```bash
cd site
python -m http.server
# open http://localhost:8000/
```

## What is here

| Path | What it is |
|---|---|
| `index.html` | The whole page. Icons are an inline SVG sprite at the top. |
| `css/site.css` | Styles. Tokens mirror `design/sona-ui/tokens.css` (dark theme) so the site and the apps look like one product. |
| `js/site.js` | Progressive enhancement only: the waitlist form posts in place, and sections fade in on scroll. The page works without it. |
| `fonts/` | Latin subsets of Jost and Cormorant Garamond, copied from `design/sona-ui/fonts`, with `OFL.txt`. |
| `img/` | App screenshots (WebP, from `docs/img/2027`), the generated black marble texture, the Open Graph image and the touch icon. |
| `favicon.svg` | The flame mark. |
| `_shots/` | Review screenshots for the pull request. Not part of the site; delete before deploying. |

## Waitlist endpoint

The form sends `POST /notify` with one form-encoded field, `email`. The backend is
not part of this folder. To support both paths:

- **With JS** the page sends `Accept: application/json`. Any 2xx means success;
  anything else shows the failure message.
- **Without JS** the browser does a normal form post. Answer with a `303` redirect
  to `/#joined` on success or `/#join-failed` on failure. The page shows the right
  message with CSS `:target`, no script needed.

## Rules

- Nothing may load from another origin. No CDN, no web fonts from anyone else, no
  analytics, no external images.
- No em or en dashes in copy.
- No inline event handlers.
- Keep the page under 1.5 MB (it is about 0.3 MB today).
