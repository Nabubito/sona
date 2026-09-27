// Media pillar: manifest-driven ffmpeg tools. Each tool is a declaration;
// the UI tool-page and the drop-router index are generated from these.
const path = require('path');
const { FFMPEG, FFPROBE, run, spawn, OUTDIR, ensureDir, FFMPEG_THREAD_ARGS } = require('./engines');

const VIDEO = ['mp4', 'mov', 'mkv', 'webm', 'avi', 'm4v', 'wmv', 'flv'];
const AUDIO = ['mp3', 'wav', 'flac', 'm4a', 'ogg', 'aac', 'opus'];
const IMAGE = ['png', 'jpg', 'jpeg', 'webp', 'bmp', 'gif', 'tiff'];

const base = (p) => path.basename(p, path.extname(p));

// build(input, opts) -> { args, outExt }  where args is the full ffmpeg arg list
// starting after the exe and ending WITHOUT the output path (server appends it).
const MANIFESTS = [
  {
    id: 'video-to-gif', label: 'Video to GIF', group: 'GIF & Animation',
    accepts: VIDEO, outExt: 'gif',
    options: [
      { key: 'width', type: 'number', default: 480, min: 16, max: 3840, label: 'Width (px)' },
      { key: 'fps', type: 'number', default: 15, min: 1, max: 60, label: 'FPS' }
    ],
    build: (i, o) => ['-i', i,
      '-vf', `fps=${o.fps || 15},scale=${o.width || 480}:-1:flags=lanczos,split[s0][s1];[s0]palettegen[p];[s1][p]paletteuse`,
      '-loop', '0']
  },
  {
    id: 'gif-to-mp4', label: 'GIF to MP4', group: 'GIF & Animation',
    accepts: ['gif'], outExt: 'mp4', options: [],
    build: (i, o) => ['-i', i, '-movflags', 'faststart', '-pix_fmt', 'yuv420p',
      '-vf', 'scale=trunc(iw/2)*2:trunc(ih/2)*2']
  },
  {
    id: 'compress-video', label: 'Compress Video', group: 'Video',
    accepts: VIDEO, outExt: 'mp4',
    options: [{ key: 'crf', type: 'number', default: 28, min: 0, max: 51, label: 'Quality (CRF 18 best - 32 small)' }],
    build: (i, o) => ['-i', i, '-c:v', 'libx264', '-crf', String(o.crf || 28),
      '-preset', 'medium', '-c:a', 'aac', '-b:a', '128k']
  },
  {
    id: 'resize-video', label: 'Resize Video', group: 'Video',
    accepts: VIDEO, outExt: 'mp4',
    options: [{ key: 'width', type: 'number', default: 1280, min: 16, max: 7680, label: 'Width (px, keeps aspect)' }],
    build: (i, o) => ['-i', i, '-vf', `scale=${o.width || 1280}:-2`, '-c:a', 'copy']
  },
  {
    id: 'cut-video', label: 'Cut / Trim Video', group: 'Video',
    accepts: VIDEO, outExt: 'mp4',
    options: [
      { key: 'start', type: 'time', default: '0', label: 'Start (s or hh:mm:ss)' },
      { key: 'duration', type: 'time', default: '5', label: 'Duration (s)' }
    ],
    build: (i, o) => ['-ss', String(o.start || '0'), '-i', i, '-t', String(o.duration || '5'),
      '-c', 'copy']
  },
  {
    id: 'extract-audio', label: 'Extract Audio', group: 'Audio',
    accepts: VIDEO, outExt: 'mp3', options: [],
    build: (i, o) => ['-i', i, '-vn', '-c:a', 'libmp3lame', '-q:a', '2']
  },
  {
    id: 'convert-audio', label: 'Convert Audio', group: 'Audio',
    accepts: AUDIO, outExt: 'mp3',
    options: [{ key: 'format', type: 'select', options: ['mp3', 'wav', 'flac', 'm4a', 'ogg'], default: 'mp3', label: 'To format' }],
    outExtFrom: (o) => o.format || 'mp3',
    build: (i, o) => ['-i', i]
  },
  {
    id: 'resize-image', label: 'Resize Image', group: 'Image',
    accepts: IMAGE, outExt: null,
    options: [{ key: 'width', type: 'number', default: 800, min: 16, max: 16384, label: 'Width (px, keeps aspect)' }],
    outExtFrom: (o, input) => { const e = path.extname(input).slice(1).toLowerCase(); return IMAGE.includes(e) ? e : 'png'; },
    build: (i, o) => ['-i', i, '-vf', `scale=${o.width || 800}:-1`]
  },
  {
    id: 'convert-image', label: 'Convert Image', group: 'Image',
    accepts: IMAGE, outExt: null,
    options: [{ key: 'format', type: 'select', options: ['png', 'jpg', 'webp', 'bmp'], default: 'png', label: 'To format' }],
    outExtFrom: (o) => o.format || 'png',
    build: (i, o) => ['-i', i]
  }
];

const byId = Object.fromEntries(MANIFESTS.map(m => [m.id, m]));

function toolsFor(ext) {
  ext = (ext || '').toLowerCase();
  return MANIFESTS.filter(m => m.accepts.includes(ext)).map(m => ({ id: m.id, label: m.label }));
}

function catalog() {
  return MANIFESTS.map(m => ({
    id: m.id, label: m.label, group: m.group, accepts: m.accepts,
    options: m.options || []
  }));
}

async function probeDuration(input) {
  if (!FFPROBE) return 0;
  const r = await run(FFPROBE, ['-v', 'quiet', '-show_entries', 'format=duration', '-of', 'csv=p=0', input]);
  const d = parseFloat((r.stdout || '').trim());
  return isFinite(d) ? d : 0;
}

// Only values a manifest declares get through: numbers are clamped to their
// range, selects must be one of their listed options, times must look like
// seconds or hh:mm:ss. Anything else falls back to the default.
const TIME_RE = /^(\d{1,2}:){0,2}\d{1,6}(\.\d{1,3})?$/;
function cleanOptions(manifest, raw) {
  const out = {};
  for (const o of manifest.options || []) {
    const v = raw ? raw[o.key] : undefined;
    if (o.type === 'number') {
      const n = Number(v);
      out[o.key] = Number.isFinite(n) ? Math.min(o.max ?? n, Math.max(o.min ?? n, Math.round(n))) : o.default;
    } else if (o.type === 'select') {
      out[o.key] = o.options.includes(v) ? v : o.default;
    } else if (o.type === 'time') {
      out[o.key] = TIME_RE.test(String(v ?? '')) ? String(v) : o.default;
    } else out[o.key] = o.default;
  }
  return out;
}

// Run a media job. onProgress(percent) called as it runs. Returns { out }.
async function runTool(manifest, input, rawOpts, jobId, onProgress) {
  if (!FFMPEG) throw new Error('ffmpeg not found');
  const opts = cleanOptions(manifest, rawOpts);
  const outExt = manifest.outExtFrom ? manifest.outExtFrom(opts, input) : manifest.outExt;
  const outDir = path.join(OUTDIR, jobId);
  ensureDir(outDir);
  const out = path.join(outDir, `${base(input)}.${outExt}`);
  const dur = await probeDuration(input);
  const built = manifest.build(input, opts);
  const args = ['-y', '-nostdin', ...built, ...FFMPEG_THREAD_ARGS, '-progress', 'pipe:1', '-nostats', out];

  return new Promise((resolve, reject) => {
    const p = spawn(FFMPEG, args, { windowsHide: true });
    let err = '';
    p.stderr.on('data', d => err += d);
    p.stdout.on('data', d => {
      const m = String(d).match(/out_time_ms=(\d+)/g);
      if (m && dur > 0) {
        const last = Number(m[m.length - 1].split('=')[1]) / 1e6;
        onProgress && onProgress(Math.min(99, Math.round((last / dur) * 100)));
      }
    });
    p.on('error', e => reject(e));
    p.on('close', code => {
      if (code === 0) resolve({ out });
      else reject(new Error(err.trim().split(/\r?\n/).slice(-3).join(' ') || `ffmpeg exit ${code}`));
    });
  });
}

module.exports = { MANIFESTS, byId, toolsFor, catalog, runTool, cleanOptions, VIDEO, AUDIO, IMAGE };
