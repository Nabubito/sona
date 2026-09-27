// Disc pillar: mount/unmount/mounted via Windows Mount-DiskImage,
// make-ISO via IMAPI2 (lib/make-iso.ps1). Windows only: on other systems
// every call rejects with a clear message and the UI hides these actions.
// Browsing and extracting images works everywhere through 7-Zip.
const { runPS, run, ISO_SCRIPT, POWERSHELL, DISC_AVAILABLE } = require('./engines');

const UNAVAILABLE = 'Mounting and building disc images need Windows. You can still browse and extract images with 7-Zip.';
function needDisc() { if (!DISC_AVAILABLE) { const e = new Error(UNAVAILABLE); e.status = 501; throw e; } }

function psQuote(s) { return "'" + String(s).replace(/'/g, "''") + "'"; }

// drive letter -> image path, so we can eject from the mounted list (no path needed there).
const mounts = new Map();

async function mount(imagePath) {
  needDisc();
  const img = psQuote(imagePath);
  const script =
    `Mount-DiskImage -ImagePath ${img} -StorageType ISO | Out-Null;` +
    `Start-Sleep -Milliseconds 400;` +
    `$v = Get-DiskImage -ImagePath ${img} | Get-Volume;` +
    `@{drive=$v.DriveLetter; label=$v.FileSystemLabel; size=$v.Size} | ConvertTo-Json -Compress`;
  const out = await runPS(script);
  const j = JSON.parse(out || '{}');
  if (j.drive) mounts.set(j.drive, imagePath);
  return { drive: j.drive || null, label: j.label || '', size: j.size || 0 };
}

async function unmount(imagePath) {
  needDisc();
  await runPS(`Dismount-DiskImage -ImagePath ${psQuote(imagePath)} | Out-Null`);
  for (const [d, p] of mounts) if (p === imagePath) mounts.delete(d);
  return { ok: true };
}

async function unmountByDrive(drive) {
  needDisc();
  const p = mounts.get(drive);
  if (!p) throw new Error(`Don't know which image is on ${drive}: so eject it from the image file.`);
  return unmount(p);
}

async function mounted() {
  if (!DISC_AVAILABLE) return [];
  const out = await runPS(
    `Get-Volume | Where-Object { $_.DriveType -eq 'CD-ROM' -and $_.DriveLetter } |` +
    `Select-Object DriveLetter,FileSystemLabel,Size | ConvertTo-Json -Compress`);
  if (!out) return [];
  let j = JSON.parse(out);
  if (!Array.isArray(j)) j = [j];
  return j.map(v => ({ drive: v.DriveLetter, label: v.FileSystemLabel, size: v.Size, path: mounts.get(v.DriveLetter) || null }));
}

// Build an ISO (ISO9660 + Joliet + UDF) from a folder with Windows' IMAPI2.
async function makeIso({ folder, out, label }) {
  needDisc();
  const args = ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', ISO_SCRIPT, '-Source', folder, '-Out', out];
  if (label) args.push('-Label', label);
  const r = await run(POWERSHELL, args);
  if (r.code !== 0 || !/CREATED/.test(r.stdout)) {
    throw new Error((r.stderr || r.stdout).trim() || 'make failed');
  }
  return { out };
}

module.exports = { mount, unmount, unmountByDrive, mounted, makeIso, UNAVAILABLE };
