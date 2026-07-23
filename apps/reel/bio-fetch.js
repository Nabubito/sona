'use strict';
// Free, keyless artist bios from Wikipedia's REST summary API.
// No key, no SDK, no paid call — just the public page summary endpoint.
// Shared by server.js (on-demand ✨ generate) and seed-bios.js (the bulk batch).

// A bare-name page must *look* musical before we trust it ("Boston" the city vs
// the band, "Kansas" the state vs the group). Qualified pages — "X (band)" — we trust.
const MUSIC_HINT = /\b(band|singer|musician|rapper|songwriter|composer|guitarist|drummer|bassist|pianist|vocalist|saxophonist|violinist|duo|trio|quartet|group|orchestra|ensemble|dj|disc jockey|record producer|recording artist|hip hop|hip-hop|rock|pop|jazz|metal|punk|blues|reggae|soul|funk|electronic|folk|country|r&b|frontman|frontwoman|discography|album|single)\b/i;

const SKIP = /^(unknown artist|various artists|various|va|soundtrack|n\/?a|none)$/i;

async function fetchSummary(title) {
  const url = 'https://en.wikipedia.org/api/rest_v1/page/summary/'
    + encodeURIComponent(title.replace(/ /g, '_')) + '?redirect=true';
  let r;
  try {
    r = await fetch(url, {
      headers: {
        'User-Agent': 'Reel/1.0 (private personal music app; bios)',
        'Accept': 'application/json'
      }
    });
  } catch { return null; }
  if (!r.ok) return null;
  let j; try { j = await r.json(); } catch { return null; }
  if (!j || j.type === 'disambiguation' || j.title === 'Not found.' || !j.extract) return null;
  return j;
}

// returns { bio, src } or null
async function fetchArtistBio(name) {
  const clean = String(name || '').trim();
  if (!clean || SKIP.test(clean)) return null;
  const candidates = [
    { q: clean, qualified: false },
    { q: `${clean} (band)`, qualified: true },
    { q: `${clean} (musician)`, qualified: true },
    { q: `${clean} (singer)`, qualified: true },
    { q: `${clean} (rapper)`, qualified: true },
  ];
  for (const c of candidates) {
    const j = await fetchSummary(c.q);
    if (!j) continue;
    const blob = `${j.description || ''} ${j.extract || ''}`;
    if (c.qualified || MUSIC_HINT.test(blob)) {
      const page = j.content_urls && j.content_urls.desktop && j.content_urls.desktop.page;
      return { bio: j.extract.trim(), src: page || 'https://en.wikipedia.org/' };
    }
  }
  return null;
}

module.exports = { fetchArtistBio };
