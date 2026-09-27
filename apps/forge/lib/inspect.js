// Drop router: given a file path, decide its pillar and applicable verbs.
// This is the UX spine - "you bring a file, not a tool name."
const path = require('path');
const media = require('./media');
const { DISC_AVAILABLE } = require('./engines');

const DISC = ['iso', 'img', 'bin', 'nrg', 'mdf', 'vhd', 'vhdx', 'dmg', 'wim'];
const ARCHIVE = ['zip', '7z', 'rar', 'tar', 'gz', 'tgz', 'bz2', 'xz', 'cab'];

function inspect(filePath) {
  const ext = path.extname(filePath).slice(1).toLowerCase();
  const name = path.basename(filePath);
  const verbs = [];
  let pillar = null;

  if (DISC.includes(ext)) {
    pillar = 'disc';
    verbs.push({ id: 'browse', label: 'Browse contents', kind: 'container' });
    if (DISC_AVAILABLE && (ext === 'iso' || ext === 'img')) verbs.push({ id: 'mount', label: 'Mount', kind: 'disc' });
    verbs.push({ id: 'extract', label: 'Extract', kind: 'container' });
  } else if (ARCHIVE.includes(ext)) {
    pillar = 'archive';
    verbs.push({ id: 'browse', label: 'Browse contents', kind: 'container' });
    verbs.push({ id: 'extract', label: 'Extract', kind: 'container' });
    verbs.push({ id: 'test', label: 'Test integrity', kind: 'container' });
  } else {
    const tools = media.toolsFor(ext);
    if (tools.length) {
      pillar = 'media';
      for (const t of tools) verbs.push({ id: t.id, label: t.label, kind: 'media' });
    }
  }

  return { name, ext, pillar, verbs, supported: !!pillar };
}

module.exports = { inspect, DISC, ARCHIVE };
