"""Long-running speech-to-text worker for Reel voice search.

Reads one audio file path per line on stdin, prints one JSON object per line
on stdout. Loads the faster-whisper tiny.en model once at startup so each
request adds only the transcription cost (~0.5s for a 3-5s clip).

Protocol:
  stdin:  <absolute-path-to-wav>\n
  stdout: {"ok": true, "text": "..."} | {"ok": false, "error": "..."}\n
"""
import json
import os
import sys

MODEL_NAME = os.environ.get("Reel_WHISPER_MODEL", "tiny.en")
COMPUTE_TYPE = os.environ.get("Reel_WHISPER_COMPUTE", "int8")


def main():
    try:
        from faster_whisper import WhisperModel
    except Exception as e:
        print(json.dumps({"ok": False, "error": f"faster_whisper import failed: {e}", "ready": False}), flush=True)
        return

    try:
        model = WhisperModel(MODEL_NAME, device="cpu", compute_type=COMPUTE_TYPE)
    except Exception as e:
        print(json.dumps({"ok": False, "error": f"model load failed: {e}", "ready": False}), flush=True)
        return

    print(json.dumps({"ok": True, "ready": True, "model": MODEL_NAME}), flush=True)

    for line in sys.stdin:
        wav = line.strip()
        if not wav:
            continue
        try:
            segments, _info = model.transcribe(
                wav,
                language="en",
                beam_size=1,
                vad_filter=True,
                vad_parameters={"min_silence_duration_ms": 250},
            )
            text = "".join(s.text for s in segments).strip()
            print(json.dumps({"ok": True, "text": text}), flush=True)
        except Exception as e:
            print(json.dumps({"ok": False, "error": str(e)}), flush=True)


if __name__ == "__main__":
    main()
