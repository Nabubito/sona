# Listen to a clip and write timed lines, for burned in words.
#
#   python transcribe.py <in.wav> <out.json> <model> <threads> [lyrics.txt]
#   python transcribe.py --check <model>     (can this Python run it, and is the model on disk?)
#
# Needs faster-whisper (pip install faster-whisper) and the model downloaded once (see README).
# CPU only and offline on purpose: the model is read from the local cache, and this process has no
# business on the network. The input is a short mono wav that the app's own ffmpeg just wrote.
#
# The raw model output is not usable as subtitles: on a song it can return one 19 second block.
# So words are timed individually and regrouped here into short lines a person can read.
import difflib
import json
import os
import re
import sys
import time

os.environ.setdefault("HF_HUB_OFFLINE", "1")
os.environ.setdefault("HF_HUB_DISABLE_SYMLINKS_WARNING", "1")

MAX_CHARS = 38        # one comfortable subtitle line on a phone
MAX_SECONDS = 3.6     # never hold a line longer than this
GAP_SECONDS = 0.7     # a pause this long starts a new line
MAX_CUES = 400


def norm(word):
    return re.sub(r"[^a-z0-9]+", "", word.lower().replace("&", "and"))


# Songs. A speech model guesses at sung words ("hold the world" for "rule the world"), but it
# hears WHEN each word lands quite well. Published lyrics have the right words and no timing for
# this particular performance. So: find the stretch of the lyrics this clip covers, line the
# heard words up against the written ones, and show the WRITTEN line at the time the model HEARD
# it. If the lyrics do not resemble what was heard (wrong song, or somebody talking), they are
# ignored and the plain transcription stands. Returns cues or None.
MIN_MATCH = 0.5
ALIGN_BUDGET_SEC = 8.0


def align_to_lyrics(words, lyric_lines):
    heard = [(norm(w), s, e) for (w, s, e) in words]
    heard = [h for h in heard if h[0]]
    lines = [[t for t in (norm(x) for x in ln.split()) if t] for ln in lyric_lines]
    keep = [i for i, toks in enumerate(lines) if toks]
    if len(heard) < 3 or not keep:
        return None
    hw = [h[0] for h in heard]
    # Cold review, 2026-09-19: SequenceMatcher is quadratic on repetitive input. 900 words of
    # "a i a i" against "a a i i" lyrics cost 4 s PER window, 26 minutes over 400 windows, inside
    # the one at a time listener. A real clip is a few hundred varied words and costs 0.01 s.
    # So: refuse input no real song looks like, rank windows with a cheap set overlap and only
    # run the expensive match on the best few, and stop at a hard deadline whatever happens.
    if len(hw) > 700 or len(set(hw)) / len(hw) < 0.15:
        return None
    deadline = time.monotonic() + ALIGN_BUDGET_SEC
    heard_set = set(hw)

    # 1. which run of lyric lines is this clip? Take enough lines to cover what was heard.
    windows = []
    for a in range(len(keep)):
        toks, b = [], a
        while b < len(keep) and len(toks) < len(hw) * 1.35 + 4:
            toks.extend(lines[keep[b]])
            b += 1
        if toks:
            overlap = len(heard_set & set(toks)) / max(1, len(heard_set | set(toks)))
            windows.append((overlap, a, b, toks))
    # a chorus repeats, so among equals the EARLIEST window wins: stable sort on overlap only
    windows.sort(key=lambda w: -w[0])
    best = (0.0, None, None)
    for overlap, a, b, toks in sorted(windows[:6], key=lambda w: w[1]):
        if time.monotonic() > deadline:
            return None
        score = difflib.SequenceMatcher(None, hw, toks, autojunk=False).ratio()
        if score > best[0] + 1e-9:
            best = (score, a, b)
    score, a, b = best
    if a is None or score < MIN_MATCH or time.monotonic() > deadline:
        return None

    # 2. align heard words to the written words of that window
    flat = []  # (token, index into keep)
    for k in range(a, b):
        flat.extend((t, k) for t in lines[keep[k]])
    sm = difflib.SequenceMatcher(None, hw, [t for t, _ in flat], autojunk=False)
    span = {}  # lyric line -> [first heard index, last heard index]
    for blk in sm.get_matching_blocks():
        for n in range(blk.size):
            k = flat[blk.b + n][1]
            i = blk.a + n
            lo, hi = span.get(k, (i, i))
            span[k] = (min(lo, i), max(hi, i))

    # 3. a line needs a real foothold in what was heard, or it was not sung in this clip
    cues, prev_end = [], 0.0
    for k in range(a, b):
        if k not in span:
            continue
        lo, hi = span[k]
        matched = sum(1 for blk in sm.get_matching_blocks() for n in range(blk.size) if flat[blk.b + n][1] == k)
        if matched < max(1, int(len(lines[keep[k]]) * 0.34)):
            continue
        start, end = max(heard[lo][1], prev_end), heard[hi][2]
        if end - start < 0.6:
            end = start + 0.6
        text = " ".join(lyric_lines[keep[k]].split())
        cues.append({"start": start, "end": end, "text": text})
        prev_end = end
    return cues or None


def check(size):
    res = {"ok": False, "missing": [], "model": False}
    try:
        from faster_whisper.utils import download_model
    except Exception:
        res["missing"].append("faster_whisper")
        print(json.dumps(res))
        return
    try:
        download_model(size, local_files_only=True)
        res["model"] = True
    except Exception:
        res["model"] = False
    res["ok"] = res["model"]
    print(json.dumps(res))


def main():
    wav, out, size, threads = sys.argv[1], sys.argv[2], sys.argv[3], max(1, min(8, int(sys.argv[4])))
    lyrics_path = sys.argv[5] if len(sys.argv) > 5 else ""
    from faster_whisper import WhisperModel

    model = WhisperModel(size, device="cpu", compute_type="int8", cpu_threads=threads, local_files_only=True)
    segments, info = model.transcribe(
        wav, beam_size=5, word_timestamps=True, vad_filter=False, condition_on_previous_text=False,
    )
    segments = list(segments)

    if lyrics_path and os.path.isfile(lyrics_path) and os.path.getsize(lyrics_path) < 200_000:
        with open(lyrics_path, "r", encoding="utf-8", errors="replace") as f:
            lyric_lines = [ln.strip() for ln in f.read().splitlines()][:600]
        words = [((w.word or "").strip(), float(w.start), float(w.end)) for seg in segments for w in (seg.words or [])]
        aligned = align_to_lyrics(words, lyric_lines)
        if aligned:
            with open(out, "w", encoding="utf-8") as f:
                json.dump({"language": info.language, "probability": round(float(info.language_probability), 3),
                           "source": "lyrics", "cues": aligned[:MAX_CUES]}, f)
            return

    cues, cur = [], None
    for seg in segments:
        for w in (seg.words or []):
            text = (w.word or "").strip()
            if not text:
                continue
            start, end = float(w.start), float(w.end)
            fresh = (
                cur is None
                or start - cur["end"] > GAP_SECONDS
                or end - cur["start"] > MAX_SECONDS
                or len(cur["text"]) + 1 + len(text) > MAX_CHARS
            )
            if fresh:
                if cur:
                    cues.append(cur)
                cur = {"start": start, "end": end, "text": text}
            else:
                cur["end"] = end
                cur["text"] += " " + text
            if cur["text"][-1:] in ".!?" and len(cur["text"]) > 12:
                cues.append(cur)
                cur = None
        if len(cues) >= MAX_CUES:
            break
    if cur:
        cues.append(cur)
    with open(out, "w", encoding="utf-8") as f:
        json.dump({"language": info.language, "probability": round(float(info.language_probability), 3),
                   "source": "heard", "cues": cues[:MAX_CUES]}, f)


if __name__ == "__main__":
    if len(sys.argv) > 1 and sys.argv[1] == "--check":
        check(sys.argv[2] if len(sys.argv) > 2 else "small")
        sys.exit(0)
    try:
        main()
    except Exception as e:  # the caller only needs to know it failed; details stay in this process
        sys.stderr.write("transcribe failed: " + type(e).__name__ + "\n")
        sys.exit(1)
