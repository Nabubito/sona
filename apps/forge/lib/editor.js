// Editor pillar: a real timeline video editor. Unlike the manifest tools
// (one file in, one ffmpeg call out), a project is a stateful multi-track
// document that compiles to a single ffmpeg filter_complex render.
//
// The value it gives back vs paid trial editors: clean export at any
// resolution/fps with NO watermark, plus transitions / titles / filters /
// stickers / pan-zoom / audio mix. We never add a watermark. That is the point.
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { FFMPEG, FFPROBE, run, spawn, OUTDIR, ensureDir, FFMPEG_THREAD_ARGS } = require('./engines');
const cfg = require('./config');

const PROJECTS_DIR = cfg.PROJECTS_DIR;
const THUMBS_DIR = path.join(OUTDIR, '.thumbs');
ensureDir(PROJECTS_DIR);
ensureDir(THUMBS_DIR);

// Title font: configured file, else a common bold sans per OS, else let
// ffmpeg's fontconfig pick a default "Sans".
const WINFONTS = path.join(process.env.WINDIR || process.env.SystemRoot || 'C:/Windows', 'Fonts');
const FONT = [cfg.TITLE_FONT,
  path.join(WINFONTS, 'arialbd.ttf'), path.join(WINFONTS, 'arial.ttf'),
  '/System/Library/Fonts/Supplemental/Arial Bold.ttf', '/Library/Fonts/Arial Bold.ttf',
  '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf', '/usr/share/fonts/TTF/DejaVuSans-Bold.ttf',
  '/usr/share/fonts/dejavu/DejaVuSans-Bold.ttf', '/usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf'
].find(f => f && fs.existsSync(f)) || null;

// ffmpeg wants forward slashes AND an escaped drive colon inside filtergraphs.
const fontPath = () => FONT.replace(/\\/g, '/').replace(/:/g, '\\:');
const fontSpec = () => FONT ? `fontfile='${fontPath()}'` : `font='Sans'`;

// ---------- project store ----------
// Project ids are exactly what blankProject() makes: 10 lowercase hex chars.
const ID_RE = /^[a-f0-9]{10}$/;
function projPath(id) {
  if (!ID_RE.test(String(id))) { const e = new Error('Bad project id.'); e.status = 400; throw e; }
  return path.join(PROJECTS_DIR, id + '.json');
}

function listProjects() {
  return fs.readdirSync(PROJECTS_DIR).filter(f => f.endsWith('.json')).map(f => {
    try {
      const p = JSON.parse(fs.readFileSync(path.join(PROJECTS_DIR, f), 'utf8'));
      return { id: p.id, name: p.name, updatedAt: p.updatedAt, canvas: p.canvas,
        clips: (p.tracks || []).reduce((n, t) => n + (t.clips || []).length, 0) };
    } catch { return null; }
  }).filter(Boolean).sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
}

function getProject(id) {
  try { return JSON.parse(fs.readFileSync(projPath(id), 'utf8')); }
  catch { return null; }
}

function blankProject(name) {
  const id = crypto.randomBytes(5).toString('hex');
  return {
    id, name: name || 'Untitled', createdAt: Date.now(), updatedAt: Date.now(),
    canvas: { width: 1920, height: 1080, fps: 30, bg: 'black' },
    tracks: [
      { id: 'v', kind: 'video', clips: [] },     // base visual sequence
      { id: 'o', kind: 'overlay', clips: [] },   // titles + stickers, absolute-timed
      { id: 'a', kind: 'audio', clips: [] }      // extra audio, absolute-timed
    ]
  };
}

function saveProject(p) {
  if (!p || typeof p !== 'object') { const e = new Error('Bad project.'); e.status = 400; throw e; }
  if (!p.id) p.id = crypto.randomBytes(5).toString('hex');
  projPath(p.id); // validates before anything is written
  p.updatedAt = Date.now();
  fs.writeFileSync(projPath(p.id), JSON.stringify(p, null, 2));
  return p;
}

function deleteProject(id) {
  try { fs.unlinkSync(projPath(id)); return true; } catch { return false; }
}

// ---------- media probe + thumbnail ----------
async function probe(src) {
  if (!FFPROBE) throw new Error('ffprobe not found');
  const r = await run(FFPROBE, ['-v', 'quiet', '-print_format', 'json',
    '-show_format', '-show_streams', src]);
  let j = {}; try { j = JSON.parse(r.stdout); } catch {}
  const streams = j.streams || [];
  const v = streams.find(s => s.codec_type === 'video');
  const a = streams.find(s => s.codec_type === 'audio');
  const dur = parseFloat((j.format && j.format.duration) || (v && v.duration) || 0) || 0;
  let fps = 0;
  if (v && v.r_frame_rate && v.r_frame_rate.includes('/')) {
    const [n, d] = v.r_frame_rate.split('/').map(Number);
    if (d) fps = n / d;
  }
  const ext = path.extname(src).slice(1).toLowerCase();
  const isImage = !dur && v && !a || ['png', 'jpg', 'jpeg', 'webp', 'bmp', 'gif'].includes(ext);
  return {
    src, type: v ? (isImage ? 'image' : 'video') : (a ? 'audio' : 'unknown'),
    duration: dur, width: v ? v.width : 0, height: v ? v.height : 0,
    fps: Math.round(fps * 100) / 100, hasAudio: !!a,
    name: path.basename(src)
  };
}

async function thumbnail(src, at) {
  const key = crypto.createHash('md5').update(src + ':' + (at || 0)).digest('hex');
  const out = path.join(THUMBS_DIR, key + '.jpg');
  if (fs.existsSync(out)) return out;
  const args = ['-y', '-ss', String(at || 0), '-i', src, '-vframes', '1',
    '-vf', 'scale=240:-1', out];
  const r = await run(FFMPEG, args);
  return fs.existsSync(out) ? out : null;
}

// ---------- render engine ----------
// Escape a single line of title text for an inline drawtext text='...' value.
// ASCII quotes are swapped for curly ones (they collide with filtergraph quote
// parsing and look better anyway); then only backslash and colon need escaping
// inside the single-quoted token. `%` is left literal via expansion=none.
// Verified against: apostrophes, %, ", :, \, commas, brackets, multi-quote mixes.
function escTitle(s) {
  let dq = 0;                                   // alternate opening/closing double quotes
  return String(s == null ? '' : s)
    .replace(/"/g, () => (dq++ % 2 === 0 ? '“' : '”'))
    .replace(/'/g, '’')
    .replace(/\\/g, '\\\\').replace(/:/g, '\\:');
}

// Per-clip visual normalize chain: fit into canvas, uniform sar/fps/pix, color.
function normVideo(label, out, W, H, FPS, filter) {
  let chain = `[${label}]scale=${W}:${H}:force_original_aspect_ratio=decrease,` +
    `pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=${FPS},format=yuv420p`;
  const eq = eqFrom(filter);
  if (eq) chain += `,${eq}`;
  chain += ',settb=AVTB';   // uniform timebase so concat & xfade outputs can be folded together
  return `${chain}[${out}]`;
}

function eqFrom(filter) {
  if (!filter) return '';
  const f = { ...presetFilter(filter.preset), ...filter };
  const parts = [];
  if (f.brightness != null && +f.brightness) parts.push(`brightness=${(+f.brightness).toFixed(3)}`);
  if (f.contrast != null && +f.contrast !== 1) parts.push(`contrast=${(+f.contrast).toFixed(3)}`);
  if (f.saturation != null && +f.saturation !== 1) parts.push(`saturation=${(+f.saturation).toFixed(3)}`);
  if (f.gamma != null && +f.gamma !== 1) parts.push(`gamma=${(+f.gamma).toFixed(3)}`);
  const out = [];
  if (parts.length) out.push(`eq=${parts.join(':')}`);
  if (f.preset === 'grayscale' || f.grayscale) out.push('hue=s=0');
  if (f.preset === 'sepia') out.push('colorchannelmixer=.393:.769:.189:0:.349:.686:.168:0:.272:.534:.131');
  if (f.preset === 'blur' || f.blur) out.push(`gblur=sigma=${+f.blur || 6}`);
  return out.join(',');
}

function presetFilter(preset) {
  switch (preset) {
    case 'vivid': return { saturation: 1.5, contrast: 1.12 };
    case 'warm': return { saturation: 1.1, gamma: 1.05, brightness: 0.03 };
    case 'cool': return { saturation: 1.05, gamma: 0.95, brightness: -0.02 };
    case 'bright': return { brightness: 0.12, contrast: 1.05 };
    case 'contrast': return { contrast: 1.3 };
    case 'grayscale': return { saturation: 0 };
    default: return {};
  }
}

// Zoompan (Ken Burns) for an image clip. dur seconds at FPS.
function zoompanChain(label, out, W, H, FPS, dur, pz) {
  const frames = Math.max(1, Math.round(dur * FPS));
  const dir = (pz && pz.to === 'out') ? 'out' : 'in';
  // zoom from 1.0..1.15 (or reverse). d = per-frame output.
  const z = dir === 'in'
    ? `min(zoom+0.0015,1.15)` : `if(lte(zoom,1.0),1.15,max(1.001,zoom-0.0015))`;
  return `[${label}]scale=${W * 2}:${H * 2},zoompan=z='${z}':d=${frames}:` +
    `x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':s=${W}x${H}:fps=${FPS},` +
    `setsar=1,format=yuv420p,settb=AVTB[${out}]`;
}

// Build the whole render. Returns {args, log}: args after the exe, output appended by caller.
function buildRender(project, outPath) {
  const W = project.canvas.width, H = project.canvas.height, FPS = project.canvas.fps || 30;
  const vTrack = (project.tracks.find(t => t.kind === 'video') || { clips: [] }).clips;
  const oTrack = (project.tracks.find(t => t.kind === 'overlay') || { clips: [] }).clips;
  const aTrack = (project.tracks.find(t => t.kind === 'audio') || { clips: [] }).clips;

  if (!vTrack.length) throw new Error('project has no clips on the video track');

  const inputs = [];   // ffmpeg -i args in order
  const fc = [];       // filter_complex statements
  let ii = 0;          // input index counter
  const addInput = (args) => { inputs.push(args); return ii++; };

  // ---- base video track: normalize each clip, fold with concat / xfade ----
  const clipDur = (c) => {
    if (c.type === 'image') return Math.max(0.1, +c.duration || 3);
    const ti = +c.trimIn || 0, to = (c.trimOut != null ? +c.trimOut : (ti + (+c.duration || 3)));
    return Math.max(0.1, to - ti);
  };

  const segV = [], segA = [], durs = [];
  vTrack.forEach((c, k) => {
    const dur = clipDur(c);
    durs.push(dur);
    if (c.type === 'image') {
      const idx = addInput(['-loop', '1', '-t', String(dur), '-i', c.src]);
      if (c.panzoom && c.panzoom.enabled) {
        fc.push(zoompanChain(`${idx}:v`, `nv${k}`, W, H, FPS, dur, c.panzoom));
        if (eqFrom(c.filter)) fc.push(`[nv${k}]${eqFrom(c.filter)},settb=AVTB[nv${k}f]`), segV.push(`nv${k}f`);
        else segV.push(`nv${k}`);
      } else {
        fc.push(normVideo(`${idx}:v`, `nv${k}`, W, H, FPS, c.filter));
        segV.push(`nv${k}`);
      }
      // silent audio bed for this image
      const aidx = addInput(['-f', 'lavfi', '-t', String(dur),
        '-i', 'anullsrc=r=44100:cl=stereo']);
      fc.push(`[${aidx}:a]asetpts=PTS-STARTPTS[na${k}]`);
      segA.push(`na${k}`);
    } else {
      const ti = +c.trimIn || 0;
      const idx = addInput(['-ss', String(ti), '-t', String(dur), '-i', c.src]);
      fc.push(normVideo(`${idx}:v`, `nv${k}`, W, H, FPS, c.filter));
      segV.push(`nv${k}`);
      // audio: use clip audio if present else silence; apply volume + fades
      let ac = '';
      if (c.hasAudio) {
        ac = `[${idx}:a]asetpts=PTS-STARTPTS,aformat=sample_rates=44100:channel_layouts=stereo`;
        const vol = (c.volume != null ? +c.volume : 1);
        if (vol !== 1) ac += `,volume=${vol.toFixed(3)}`;
        if (+c.fadeIn) ac += `,afade=t=in:st=0:d=${+c.fadeIn}`;
        if (+c.fadeOut) ac += `,afade=t=out:st=${Math.max(0, dur - (+c.fadeOut))}:d=${+c.fadeOut}`;
        ac += `[na${k}]`;
        fc.push(ac);
      } else {
        const aidx = addInput(['-f', 'lavfi', '-t', String(dur),
          '-i', 'anullsrc=r=44100:cl=stereo']);
        fc.push(`[${aidx}:a]asetpts=PTS-STARTPTS[na${k}]`);
      }
      segA.push(`na${k}`);
    }
  });

  // fold left-to-right. each step: acc (+) next -> new acc. concat or xfade.
  let accV = segV[0], accA = segA[0], accDur = durs[0];
  for (let k = 1; k < vTrack.length; k++) {
    const c = vTrack[k];
    const tr = c.transitionIn;
    const nvOut = `xv${k}`, naOut = `xa${k}`;
    if (tr && tr.type && tr.type !== 'none' && +tr.duration > 0) {
      const d = Math.min(+tr.duration, accDur - 0.05, durs[k] - 0.05);
      const dd = d > 0.05 ? d : 0.3;
      const off = Math.max(0, accDur - dd);
      fc.push(`[${accV}][${segV[k]}]xfade=transition=${xfadeName(tr.type)}:duration=${dd.toFixed(3)}:offset=${off.toFixed(3)}[${nvOut}]`);
      fc.push(`[${accA}][${segA[k]}]acrossfade=d=${dd.toFixed(3)}[${naOut}]`);
      accDur = accDur + durs[k] - dd;
    } else {
      fc.push(`[${accV}][${accA}][${segV[k]}][${segA[k]}]concat=n=2:v=1:a=1[${nvOut}][${naOut}]`);
      accDur = accDur + durs[k];
    }
    accV = nvOut; accA = naOut;
  }

  // ---- overlays (titles + stickers), absolute-timed onto the base video ----
  let curV = accV;
  oTrack.forEach((o, k) => {
    const start = +o.start || 0;
    const dur = Math.max(0.1, +o.duration || 3);
    const end = start + dur;
    const enable = `between(t\\,${start.toFixed(3)}\\,${end.toFixed(3)})`;
    if (o.kind === 'text') {
      const size = +o.size || 64;
      const col = (o.color || 'white').replace('#', '0x');
      // multiline: one drawtext per line, stacked around the anchor (a raw
      // newline in the value would draw a tofu box, so we split explicitly).
      const lines = String(o.text == null ? '' : o.text).replace(/\r\n?/g, '\n').split('\n');
      const L = lines.length, lineH = Math.round(size * 1.32);
      const anchor = o.y != null ? o.y : 'center';
      const frac = parseFloat(anchor);  // support a 0..1 fractional y as well as top/center/bottom
      const yBase = anchor === 'top' ? `${Math.round(size * 0.5)}`
        : anchor === 'bottom' ? `h-${L * lineH}-${Math.round(size * 0.6)}`
          : (anchor === 'center' || isNaN(frac)) ? `(h-${L * lineH})/2`
            : `(h-${L * lineH})*${frac}`;
      lines.forEach((ln, li) => {
        const x = o.x != null ? posExpr(o.x, 'w', 'text_w') : '(w-text_w)/2';
        const y = `${yBase}+${li * lineH}`;
        let dt = `drawtext=${fontSpec()}:text='${escTitle(ln)}':expansion=none:` +
          `fontsize=${size}:fontcolor=${col}:x=${x}:y=${y}:enable='${enable}'`;
        if (o.box) dt += `:box=1:boxcolor=${(o.boxcolor || 'black@0.5')}:boxborderw=${+o.boxpad || 16}`;
        if (o.shadow !== false) dt += `:shadowcolor=black@0.6:shadowx=2:shadowy=2`;
        const out = `ov${k}_${li}`;
        fc.push(`[${curV}]${dt}[${out}]`);
        curV = out;
      });
    } else if (o.kind === 'sticker' && o.src) {
      const idx = addInput(['-i', o.src]);
      const scl = +o.scale || 0.25;
      fc.push(`[${idx}:v]scale=iw*${scl}:-1[stk${k}]`);
      const x = o.x != null ? posExpr(o.x, 'W', 'w') : '(W-w)/2';
      const y = o.y != null ? posExpr(o.y, 'H', 'h') : '(H-h)/2';
      const out = `ov${k}`;
      fc.push(`[${curV}][stk${k}]overlay=x=${x}:y=${y}:enable='${enable}'[${out}]`);
      curV = out;
    }
  });

  // ---- extra audio tracks mixed with base audio ----
  let curA = accA;
  const amixIns = [curA];
  aTrack.forEach((a, k) => {
    if (!a.src) return;
    const start = +a.start || 0;
    const ti = +a.trimIn || 0;
    const dur = Math.max(0.1, +a.duration || 5);
    const idx = addInput(['-ss', String(ti), '-t', String(dur), '-i', a.src]);
    let ch = `[${idx}:a]aformat=sample_rates=44100:channel_layouts=stereo`;
    const vol = (a.volume != null ? +a.volume : 1);
    if (vol !== 1) ch += `,volume=${vol.toFixed(3)}`;
    if (+a.fadeIn) ch += `,afade=t=in:st=0:d=${+a.fadeIn}`;
    if (+a.fadeOut) ch += `,afade=t=out:st=${Math.max(0, dur - (+a.fadeOut))}:d=${+a.fadeOut}`;
    if (start > 0) ch += `,adelay=${Math.round(start * 1000)}|${Math.round(start * 1000)}`;
    ch += `[xa_extra${k}]`;
    fc.push(ch);
    amixIns.push(`xa_extra${k}`);
  });
  if (amixIns.length > 1) {
    fc.push(`[${amixIns.map(x => x).join('][')}]amix=inputs=${amixIns.length}:duration=first:dropout_transition=0,` +
      `dynaudnorm[aout]`);
    curA = 'aout';
  }

  // assemble args
  const args = ['-y', '-nostdin'];
  for (const inp of inputs) args.push(...inp);
  args.push('-filter_complex', fc.join(';'));
  args.push('-map', `[${curV}]`, '-map', `[${curA}]`);
  args.push('-c:v', 'libx264', '-preset', 'medium', '-crf', String(project.export && project.export.crf || 20),
    '-pix_fmt', 'yuv420p', '-r', String(FPS));
  args.push('-c:a', 'aac', '-b:a', '192k');
  args.push('-shortest', '-movflags', '+faststart', ...FFMPEG_THREAD_ARGS);
  args.push('-progress', 'pipe:1', '-nostats');
  args.push(outPath);
  return { args, totalDur: accDur };
}

// map our transition names to ffmpeg xfade transitions
function xfadeName(t) {
  const map = {
    fade: 'fade', dissolve: 'dissolve', fadeblack: 'fadeblack', fadewhite: 'fadewhite',
    wipeleft: 'wipeleft', wiperight: 'wiperight', wipeup: 'wipeup', wipedown: 'wipedown',
    slideleft: 'slideleft', slideright: 'slideright', slideup: 'slideup', slidedown: 'slidedown',
    circleopen: 'circleopen', circleclose: 'circleclose', radial: 'radial',
    smoothleft: 'smoothleft', smoothright: 'smoothright', pixelize: 'pixelize'
  };
  return map[t] || 'fade';
}

// position expr: accept 'center'|'top'|'bottom'|'left'|'right' or a 0..1 fraction
function posExpr(v, dim, sz) {
  if (v === 'center') return `(${dim}-${sz})/2`;
  if (v === 'left' || v === 'top') return '40';
  if (v === 'right') return `${dim}-${sz}-40`;
  if (v === 'bottom') return `${dim}-${sz}-40`;
  const f = parseFloat(v);
  if (isFinite(f)) return `(${dim}-${sz})*${f}`;
  return `(${dim}-${sz})/2`;
}

// run a render job. onProgress(pct). returns {out}.
function renderProject(project, jobId, onProgress) {
  if (!FFMPEG) throw new Error('ffmpeg not found');
  const fmt = (project.export && project.export.format) || 'mp4';
  const outDir = path.join(OUTDIR, jobId);
  ensureDir(outDir);
  const safe = (project.name || 'movie').replace(/[\\/:*?"<>|]/g, '_');
  const out = path.join(outDir, `${safe}.${fmt}`);
  const { args, totalDur } = buildRender(project, out);

  // stash the exact command for debugging / negative-control inspection
  try { fs.writeFileSync(path.join(outDir, 'render.cmd.txt'), FFMPEG + ' ' + args.map(a => /[\s]/.test(a) ? `"${a}"` : a).join(' ')); } catch {}

  return new Promise((resolve, reject) => {
    const p = spawn(FFMPEG, args, { windowsHide: true });
    let err = '';
    p.stderr.on('data', d => { err += d; if (err.length > 20000) err = err.slice(-20000); });
    p.stdout.on('data', d => {
      const m = String(d).match(/out_time_ms=(\d+)/g);
      if (m && totalDur > 0) {
        const last = Number(m[m.length - 1].split('=')[1]) / 1e6;
        onProgress && onProgress(Math.min(99, Math.round((last / totalDur) * 100)));
      }
    });
    p.on('error', e => reject(e));
    p.on('close', code => {
      if (code === 0 && fs.existsSync(out)) resolve({ out });
      else reject(new Error(err.trim().split(/\r?\n/).slice(-4).join(' ') || `ffmpeg exit ${code}`));
    });
  });
}

module.exports = {
  ID_RE, PROJECTS_DIR, listProjects, getProject, blankProject, saveProject, deleteProject,
  probe, thumbnail, renderProject, buildRender
};
