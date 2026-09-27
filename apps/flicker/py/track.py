# Text follow worker for Flicker: SAM 2.1 (Meta, Apache 2.0) on the local NVIDIA GPU.
#
#   python track.py                                        (worker: JSON lines on stdin/stdout)
#   python track.py --check                                (can this Python run it? one JSON line)
#   python track.py --bench <frames_dir> <x> <y> [frame]   (timings on a folder of f00001.jpg frames)
#
# Settings come from the environment, set by the app (lib/follow.js):
#   FLICKER_TRACK_CKPT   folder holding sam2.1_hiera_base_plus.pt or sam2.1_hiera_small.pt
#   FLICKER_TRACK_MODEL  base_plus (default) or small
#   FLICKER_TRACK_WARM   a scratch folder for the warm-up frame
#
# The app is the only thing that talks to this. It spawns it on demand, keeps it warm while you
# work, and stops it when idle so the GPU is handed back. Everything that arrives here was already
# reduced to numbers by the app: a frames directory the app created itself, frame indexes, and
# click points as fractions of the frame. There is no typed text or URL in this protocol, and this
# process never touches the network.
#
# Requests (one JSON object per line):
#   {"id":1,"op":"ping"}
#   {"id":2,"op":"seg","dir":D,"frame":f,"points":[[x,y,1],[x,y,0]]}
#        -> the outline of what those clicks select on that frame (1 = this, 0 = not this)
#   {"id":3,"op":"track","dir":D,"objects":[{"id":0,"prompts":[{"frame":f,"points":[[x,y,1]]}]}]}
#        -> progress lines {"id":3,"progress":p}, then the per frame tracks, and a masks folder
#
# Why the frames are loaded lazily: SAM2's own loader decodes EVERY frame to a 1024x1024 float
# tensor up front (12 MB each; a 60 s clip at 15 fps is 11 GB of RAM). Tracking only ever looks at
# the current frame, so frames are decoded when asked for and only a handful are kept. The same
# goes for its memory of past frames, which grows with every tracked frame: only the recent ones
# are ever read back, so older ones are dropped as tracking moves on.

import json
import os
import sys
import tempfile
import time
from collections import OrderedDict


def check():
    """Detection for the app: can this Python run the tracker? Prints one JSON line and exits."""
    res = {'ok': False, 'missing': [], 'cuda': False, 'checkpoint': False}
    for mod in ('numpy', 'cv2', 'torch', 'sam2'):
        try:
            __import__(mod)
        except Exception:
            res['missing'].append(mod)
    if 'torch' not in res['missing']:
        import torch as _t
        res['cuda'] = bool(_t.cuda.is_available())
    names = {'small': 'sam2.1_hiera_small.pt', 'base_plus': 'sam2.1_hiera_base_plus.pt'}
    ck = names.get(os.environ.get('FLICKER_TRACK_MODEL', 'base_plus'), names['base_plus'])
    folder = os.environ.get('FLICKER_TRACK_CKPT', '')
    res['checkpoint'] = bool(folder) and os.path.isfile(os.path.join(folder, ck))
    res['ok'] = not res['missing'] and res['cuda'] and res['checkpoint']
    sys.stdout.write(json.dumps(res) + '\n')
    sys.stdout.flush()


if __name__ == '__main__' and len(sys.argv) > 1 and sys.argv[1] == '--check':
    check()
    sys.exit(0)

os.environ.setdefault('PYTORCH_CUDA_ALLOC_CONF', 'expandable_segments:True')
os.environ['HF_HUB_OFFLINE'] = '1'
os.environ['TQDM_DISABLE'] = '1'

import numpy as np
import cv2
import torch

CKPT = os.environ.get('FLICKER_TRACK_CKPT', '')
MODEL = os.environ.get('FLICKER_TRACK_MODEL', 'base_plus')
MODELS = {
    'small': ('configs/sam2.1/sam2.1_hiera_s.yaml', 'sam2.1_hiera_small.pt'),
    'base_plus': ('configs/sam2.1/sam2.1_hiera_b+.yaml', 'sam2.1_hiera_base_plus.pt'),
}
MAX_OBJECTS = 4
MAX_POINTS = 12
MAX_FRAMES = 60 * 30
KEEP_BEHIND = 24        # SAM2 reads back 7 memory frames and 16 object pointers; keep a little more
DEBUG = bool(os.environ.get('FLICKER_TRACK_DEBUG'))
TOP_BAND = 0.12         # the head anchor is the middle of the top 12% of the outline


def out(obj):
    sys.stdout.write(json.dumps(obj, separators=(',', ':')) + '\n')
    sys.stdout.flush()


class LazyFrames:
    """Stands in for SAM2's frame list: decodes a JPEG when indexed, keeps a few."""

    def __init__(self, paths, size, mean, std):
        self.paths, self.size, self.mean, self.std = paths, size, mean, std
        self.cache = OrderedDict()
        first = cv2.imread(paths[0])
        self.video_height, self.video_width = first.shape[:2]

    def __len__(self):
        return len(self.paths)

    def __getitem__(self, i):
        if i in self.cache:
            self.cache.move_to_end(i)
            return self.cache[i]
        img = cv2.imread(self.paths[i])
        img = cv2.cvtColor(cv2.resize(img, (self.size, self.size), interpolation=cv2.INTER_LINEAR), cv2.COLOR_BGR2RGB)
        t = torch.from_numpy(img).permute(2, 0, 1).float().div_(255.0)
        t = (t - self.mean) / self.std
        self.cache[i] = t
        while len(self.cache) > 6:
            self.cache.popitem(last=False)
        return t


PREDICTOR = None


def predictor():
    global PREDICTOR
    if PREDICTOR is None:
        import sam2.sam2_video_predictor as svp
        from sam2.build_sam import build_sam2_video_predictor
        cfg, ck = MODELS.get(MODEL, MODELS['small'])
        torch.backends.cuda.matmul.allow_tf32 = True
        torch.backends.cudnn.allow_tf32 = True
        PREDICTOR = build_sam2_video_predictor(cfg, os.path.join(CKPT, ck), device='cuda')

        # Swap SAM2's eager loader for the lazy one. `video_path` here is always a list of JPEG
        # paths this process listed itself from a directory the server created.
        def lazy_loader(video_path, image_size, offload_video_to_cpu, img_mean=(0.485, 0.456, 0.406),
                        img_std=(0.229, 0.224, 0.225), async_loading_frames=False, compute_device=None):
            mean = torch.tensor(img_mean, dtype=torch.float32)[:, None, None]
            std = torch.tensor(img_std, dtype=torch.float32)[:, None, None]
            lf = LazyFrames(video_path, image_size, mean, std)
            return lf, lf.video_height, lf.video_width
        svp.load_video_frames = lazy_loader
    return PREDICTOR


def frame_paths(d):
    names = sorted(n for n in os.listdir(d) if n.startswith('f') and n.endswith('.jpg'))
    if not names or len(names) > MAX_FRAMES:
        raise ValueError('frames')
    return [os.path.join(d, n) for n in names]


def new_state(paths):
    p = predictor()
    # State stays on the GPU. With offload_state_to_cpu SAM2 copies each result to the CPU with
    # non_blocking=True and nothing waits for the copy, so a read right after got the PREVIOUS
    # request's mask (seen: every tap answered with the tap before it). Pruning keeps it small.
    return p.init_state(video_path=paths, offload_video_to_cpu=True, offload_state_to_cpu=False)


def clean_points(points, w, h):
    pts, labels = [], []
    for p in (points or [])[:MAX_POINTS]:
        x, y, lab = float(p[0]), float(p[1]), int(p[2])
        if not (0 <= x <= 1 and 0 <= y <= 1) or lab not in (0, 1):
            continue
        pts.append([x * w, y * h])
        labels.append(lab)
    if not any(labels):
        raise ValueError('points')
    return np.array(pts, dtype=np.float32), np.array(labels, dtype=np.int32)


def describe(mask):
    """Box, head anchor, centre and area of one boolean mask (torch, HxW on the GPU)."""
    h, w = mask.shape
    area = int(mask.sum().item())
    if area < 12:
        return None
    rows = torch.nonzero(mask.any(dim=1)).flatten()
    cols = torch.nonzero(mask.any(dim=0)).flatten()
    y0, y1 = int(rows[0]), int(rows[-1])
    x0, x1 = int(cols[0]), int(cols[-1])
    band = mask[y0:y0 + max(1, int((y1 - y0 + 1) * TOP_BAND))]
    bx = torch.nonzero(band)[:, 1].float()
    tx = float(bx.mean()) if bx.numel() else (x0 + x1) / 2
    ys, xs = torch.nonzero(mask, as_tuple=True)
    cx, cy = float(xs.float().mean()), float(ys.float().mean())
    r = lambda v: round(v, 4)
    return [r(x0 / w), r(y0 / h), r((x1 + 1) / w), r((y1 + 1) / h), r(tx / w), r(y0 / h), r(cx / w), r(cy / h), r(area / (w * h))]


def outline(mask_np, w, h):
    m = (mask_np.astype(np.uint8)) * 255
    contours, _ = cv2.findContours(m, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    contours = sorted(contours, key=cv2.contourArea, reverse=True)[:4]
    polys, budget = [], 400
    for c in contours:
        if cv2.contourArea(c) < 20 or budget <= 0:
            continue
        eps = 0.004 * cv2.arcLength(c, True)
        a = cv2.approxPolyDP(c, eps, True).reshape(-1, 2)[:budget]
        budget -= len(a)
        polys.append([[round(float(x) / w, 4), round(float(y) / h, 4)] for x, y in a])
    return polys


@torch.inference_mode()
def op_seg(req):
    paths = frame_paths(req['dir'])
    f = int(req['frame'])
    if not 0 <= f < len(paths):
        raise ValueError('frame')
    p = predictor()
    with torch.autocast('cuda', dtype=torch.bfloat16):
        st = new_state(paths)
        pts, labels = clean_points(req.get('points'), st['video_width'], st['video_height'])
        _, _, masks = p.add_new_points_or_box(st, frame_idx=f, obj_id=0, points=pts, labels=labels)
    torch.cuda.synchronize()
    m = (masks[0, 0] > 0)
    d = describe(m)
    return {'box': d, 'outline': outline(m.cpu().numpy(), st['video_width'], st['video_height']) if d else []}


def cond_frames(st, oid):
    idx = st['obj_id_to_idx'].get(oid)
    return st['output_dict_per_obj'][idx]['cond_frame_outputs'] if idx is not None else {}


def appearance(img, mask):
    """Colour fingerprint of what the mask covers: an HSV histogram, compared by Bhattacharyya distance."""
    hsv = cv2.cvtColor(img, cv2.COLOR_BGR2HSV)
    h = cv2.calcHist([hsv], [0, 1, 2], mask.astype(np.uint8), [12, 6, 6], [0, 180, 0, 256, 0, 256])
    cv2.normalize(h, h, 1.0, 0, cv2.NORM_L1)
    return h


def crop(mask, d, W, H):
    x0, y0 = int(d[0] * W), int(d[1] * H)
    x1, y1 = max(x0 + 1, int(round(d[2] * W))), max(y0 + 1, int(round(d[3] * H)))
    return (x0, y0, x1, y1), np.packbits(mask[y0:y1, x0:x1])


# The identity guard. SAM2 is very good at following a thing, but when the thing leaves the frame
# or is hidden for a while it can settle on something that looks a bit like it (seen on a street
# clip: a man walking behind another one, and the mask jumped onto the other man's blue bag).
# A tag on the wrong person is worse than no tag, so every frame must pass two checks against
# what you actually marked:
#   appearance: its colours must stay close to the tagged frames, or to the recent frames that
#               already passed (so a slow change in light or pose is followed, a swap is not);
#   motion:     it cannot jump further than a person could move in the time since it was last seen.
# Frames that fail are dropped (the tag fades out) and reported as lost stretches, so the page can
# offer "lost her at 0:04, tap to fix".
APP_REF_MAX = 0.52      # Bhattacharyya distance to the nearest tagged frame
APP_RUN_MAX = 0.40      # ... or to the running fingerprint of recent good frames
JUMP_MAX = 0.9          # centre jump per frame, in units of the thing's own size


def guard(rows):
    n = len(rows)
    refs = [r[1] for r in rows if r and r[3]]
    keep = [None] * n
    lost, run, last = [], None, None
    anchor = next((i for i in range(n) if rows[i] and rows[i][3]), 0)

    def check(i, prev):
        nonlocal run
        r = rows[i]
        if not r:
            return None, prev
        d, h, _, is_ref = r
        if is_ref:
            run = h.copy() if run is None else run
            return d, i
        dref = min(cv2.compareHist(h, rf, cv2.HISTCMP_BHATTACHARYYA) for rf in refs) if refs else 0
        drun = cv2.compareHist(h, run, cv2.HISTCMP_BHATTACHARYYA) if run is not None else 1
        ok = dref <= APP_REF_MAX or drun <= APP_RUN_MAX
        if DEBUG:
            sys.stderr.write('guard %d ref=%.2f run=%.2f\n' % (i, dref, drun))
        if ok and prev is not None:
            p = rows[prev][0]
            size = max(p[2] - p[0], p[3] - p[1], d[2] - d[0], d[3] - d[1], 0.02)
            jump = ((d[6] - p[6]) ** 2 + (d[7] - p[7]) ** 2) ** 0.5
            ok = jump <= JUMP_MAX * size * max(1, abs(i - prev)) ** 0.5
        if not ok:
            return None, prev
        run = h.copy() if run is None else cv2.addWeighted(run, 0.85, h, 0.15, 0)
        return d, i

    # walk out from the tagged frame in both directions, so "recent" always means nearer the tag
    prev = None
    for i in range(anchor, n):
        keep[i], prev = check(i, prev)
    run, prev = None, None
    for i in range(anchor, -1, -1):
        if rows[i] and rows[i][3]:
            run = rows[i][1].copy()
        k, prev = check(i, prev)
        if i < anchor:
            keep[i] = k
    # lost stretches: the thing was being followed and then the guard (or the tracker) let go
    i = 0
    while i < n:
        if not keep[i] and rows[i]:
            j = i
            while j < n and not keep[j]:
                j += 1
            if j - i >= 3:
                lost.append([i, j - 1])
            i = j
        else:
            i += 1
    return keep, lost


def prune(st, frame_idx):
    for od in st['output_dict_per_obj'].values():
        nc = od['non_cond_frame_outputs']
        for k in [k for k in nc if abs(k - frame_idx) > KEEP_BEHIND]:
            del nc[k]
    for od in st['frames_tracked_per_obj'].values():
        for k in [k for k in od if abs(k - frame_idx) > KEEP_BEHIND]:
            del od[k]


@torch.inference_mode()
def op_track(req, rid):
    paths = frame_paths(req['dir'])
    n = len(paths)
    objs = [o for o in (req.get('objects') or [])[:MAX_OBJECTS]]
    if not objs:
        raise ValueError('objects')
    p = predictor()
    mask_dir = os.path.join(req['dir'], 'masks')
    os.makedirs(mask_dir, exist_ok=True)
    t0 = time.time()
    with torch.autocast('cuda', dtype=torch.bfloat16):
        st = new_state(paths)
        W, H = st['video_width'], st['video_height']
        first = {}
        for o in objs:
            oid = int(o['id'])
            if not 0 <= oid < MAX_OBJECTS:
                raise ValueError('object')
            for pr in (o.get('prompts') or [])[:8]:
                f = int(pr['frame'])
                if not 0 <= f < n:
                    raise ValueError('frame')
                pts, labels = clean_points(pr.get('points'), W, H)
                p.add_new_points_or_box(st, frame_idx=f, obj_id=oid, points=pts, labels=labels)
                first[oid] = min(first.get(oid, f), f)
        ids = list(first)
        fwd_from, rev_from = min(first.values()), max(first.values())
        total = (n - fwd_from) + (rev_from + 1)
        raw = {oid: [None] * n for oid in ids}      # (describe, hist, crop box, packed crop) per frame
        done, last_note = 0, 0.0

        def take(frame_idx, obj_ids, masks, reverse):
            nonlocal done, last_note
            img = None
            torch.cuda.synchronize()
            for i, oid in enumerate(obj_ids):
                # forward results own every frame from the object's first tag on, reverse the ones before
                if reverse != (frame_idx < first[oid]):
                    continue
                m = masks[i, 0] > 0
                d = describe(m)
                if not d:
                    continue
                if img is None:
                    img = cv2.imread(paths[frame_idx])
                mn = m.cpu().numpy()
                raw[oid][frame_idx] = (d, appearance(img, mn), crop(mn, d, W, H), frame_idx in cond_frames(st, oid))
            done += 1
            prune(st, frame_idx)
            now = time.time()
            if now - last_note > 0.4:
                last_note = now
                out({'id': rid, 'progress': round(min(99, done * 100 / total), 1)})

        for fi, oids, masks in p.propagate_in_video(st, start_frame_idx=fwd_from):
            take(fi, oids, masks, False)
        if rev_from > 0:
            for fi, oids, masks in p.propagate_in_video(st, start_frame_idx=rev_from, reverse=True):
                take(fi, oids, masks, True)

    tracks, lost = {}, {}
    for oid in ids:
        tracks[oid], lost[oid] = guard(raw[oid])
    # one label image per frame (pixel value = tag id + 1) for the mask effects; only accepted frames
    for fi in range(n):
        lab = np.zeros((H, W), dtype=np.uint8)
        for oid in ids:
            if tracks[oid][fi] and raw[oid][fi]:
                (x0, y0, x1, y1), bits = raw[oid][fi][2]
                sub = np.unpackbits(bits, count=(y1 - y0) * (x1 - x0)).reshape(y1 - y0, x1 - x0).astype(bool)
                lab[y0:y1, x0:x1][sub] = oid + 1
        cv2.imwrite(os.path.join(mask_dir, 'm%05d.png' % (fi + 1)), lab)
    return {
        'n': n, 'w': W, 'h': H, 'ms': int((time.time() - t0) * 1000),
        'objects': [{'id': oid, 'f': tracks[oid], 'lost': lost[oid]} for oid in ids],
    }


def warm():
    # The first prediction after the model loads comes back empty (seen every time: first tap None,
    # every later tap fine). So the worker spends that first one on a frame of its own at startup.
    d = os.environ.get('FLICKER_TRACK_WARM') or os.path.join(tempfile.gettempdir(), 'flicker-track-warm')
    os.makedirs(d, exist_ok=True)
    f = os.path.join(d, 'f00001.jpg')
    if not os.path.exists(f):
        img = np.full((256, 256, 3), 40, np.uint8)
        cv2.circle(img, (128, 128), 60, (60, 200, 240), -1)
        cv2.imwrite(f, img)
    for _ in range(2):
        op_seg({'dir': d, 'frame': 0, 'points': [[0.5, 0.5, 1]]})


def serve():
    warm()
    out({'ready': True, 'model': MODEL, 'gpu': torch.cuda.get_device_name(0)})
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        rid = None
        try:
            req = json.loads(line)
            rid = req.get('id')
            op = req.get('op')
            if op == 'ping':
                res = {'pong': True}
            elif op == 'seg':
                res = op_seg(req)
            elif op == 'track':
                res = op_track(req, rid)
            else:
                raise ValueError('op')
            out({'id': rid, 'ok': True, 'result': res})
        except torch.cuda.OutOfMemoryError:
            torch.cuda.empty_cache()
            out({'id': rid, 'ok': False, 'code': 'gpumem'})
        except Exception as e:  # never a stack trace to the app: a short code only
            out({'id': rid, 'ok': False, 'code': str(e)[:40] if isinstance(e, ValueError) else 'trackfail'})
            sys.stderr.write('track error: %r\n' % (e,))
        finally:
            torch.cuda.empty_cache()


def bench(argv):
    d, x, y = argv[0], float(argv[1]), float(argv[2])
    f = int(argv[3]) if len(argv) > 3 else 0
    t = time.time(); predictor(); warm(); print('load+warm %.1fs' % (time.time() - t))
    t = time.time(); r = op_seg({'dir': d, 'frame': f, 'points': [[x, y, 1]]}); print('seg %.2fs box=%s' % (time.time() - t, r['box']))
    t = time.time()
    r = op_track({'dir': d, 'objects': [{'id': 0, 'prompts': [{'frame': f, 'points': [[x, y, 1]]}]}]}, 0)
    dt = time.time() - t
    seen = sum(1 for v in r['objects'][0]['f'] if v)
    print('lost', r['objects'][0]['lost'])
    print(''.join('#' if v else '.' for v in r['objects'][0]['f']))
    json.dump(r, open(os.path.join(d, 'tracks.json'), 'w'))
    print('track %d frames in %.1fs = %.1f fps, visible on %d, peak vram %.2f GB' % (r['n'], dt, r['n'] / dt, seen, torch.cuda.max_memory_allocated() / 1e9))


if __name__ == '__main__':
    if len(sys.argv) > 1 and sys.argv[1] == '--bench':
        bench(sys.argv[2:])
    else:
        serve()
