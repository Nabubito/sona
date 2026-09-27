// 7-Zip adapter. Powers BOTH the disc pillar and the archive pillar,
// because 7z lists/extracts ISO, UDF, IMG *and* zip/7z/rar/tar/gz.
const path = require('path');
const { SEVENZIP, run, ensureDir } = require('./engines');

function need7z() { if (!SEVENZIP) throw new Error('7-Zip was not found. See Engines in the top bar for how to install it.'); }

// Parse `7z l -slt` into a flat entry list. Drops the archive's own header block.
async function list(imagePath) {
  need7z();
  const r = await run(SEVENZIP, ['l', '-slt', '--', imagePath]);
  if (r.code !== 0) throw new Error(r.stderr.trim() || '7z list failed');
  const blocks = r.stdout.split(/\r?\n\r?\n/);
  const entries = [];
  let archiveType = '';
  for (const b of blocks) {
    const typeM = b.match(/^Type = (.+)$/m);
    if (typeM && !/^Path = /m.test(b.replace(/^Path = .+$/m, ''))) { /* header */ }
    if (typeM && !archiveType) archiveType = typeM[1];
    const pathM = b.match(/^Path = (.+)$/m);
    if (!pathM) continue;
    const p = pathM[1];
    // The first block whose Path equals the archive file is the header - skip.
    if (path.resolve(p) === path.resolve(imagePath)) continue;
    const sizeM = b.match(/^Size = (\d+)/m);
    const packM = b.match(/^Packed Size = (\d+)/m);
    const modM = b.match(/^Modified = (.+)$/m);
    const attrM = b.match(/^Attributes = (.+)$/m);
    const folderM = b.match(/^Folder = (.+)$/m);
    const isDir = (folderM && folderM[1].trim() === '+') || (attrM && /D/.test(attrM[1]));
    // only accept blocks that actually describe a file/dir (have Size or Attributes)
    if (!sizeM && !attrM && !folderM) continue;
    entries.push({
      path: p.replace(/\\/g, '/'),
      name: p.split(/[\\/]/).pop(),
      size: sizeM ? Number(sizeM[1]) : 0,
      packed: packM ? Number(packM[1]) : null,
      modified: modM ? modM[1] : '',
      dir: !!isDir
    });
  }
  return { type: archiveType, entries };
}

async function info(imagePath) {
  need7z();
  const r = await run(SEVENZIP, ['l', '-slt', '--', imagePath]);
  const type = (r.stdout.match(/^Type = (.+)$/m) || [])[1] || '';
  const phys = (r.stdout.match(/^Physical Size = (\d+)/m) || [])[1];
  return { type, physicalSize: phys ? Number(phys) : null };
}

// Extract all (or a selection of relative paths) to a destination folder.
async function extract(imagePath, dest, selection) {
  need7z();
  ensureDir(dest);
  // switches first, then '--' so a file name starting with '-' is never read as a switch
  const args = ['x', '-o' + dest, '-y', '--', imagePath];
  if (selection && selection.length) args.push(...selection);
  const r = await run(SEVENZIP, args);
  if (r.code !== 0) throw new Error(r.stderr.trim() || '7z extract failed');
  return { dest };
}

// Create a zip/7z archive from a list of input paths.
async function create({ inputs, out, format = '7z', level = 5, password, split }) {
  need7z();
  const args = ['a', '-t' + format, '-mx=' + level];
  if (password) { args.push('-p' + password); if (format === '7z') args.push('-mhe=on'); }
  if (split) args.push('-v' + split);
  args.push('--', out, ...inputs);
  const r = await run(SEVENZIP, args);
  if (r.code !== 0) throw new Error(r.stderr.trim() || '7z create failed');
  return { out };
}

async function test(imagePath, password) {
  need7z();
  const args = ['t'];
  if (password) args.push('-p' + password);
  args.push('--', imagePath);
  const r = await run(SEVENZIP, args);
  return { ok: r.code === 0, message: (r.stdout.match(/Everything is Ok/)) ? 'Everything is Ok' : r.stderr.trim() };
}

module.exports = { list, info, extract, create, test };
