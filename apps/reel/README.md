# Reel

**Your own Netflix & Spotify — streamed from your own files.**

Point Reel at a folder of music (and optionally video). It reads the tags, builds a searchable library, and streams to any screen you own — with themes, playlists, favorites, per-person play history, and voice search. No ads, no subscription, no one logging what you play.

Part of [Sona](../..). Pure JavaScript — no database engine, no native build.

## Run it

```bash
npm install
cp config.example.json config.json   # then edit: point "roots" at your music folder
npm start
```

Open **http://localhost:3010**, enter the PIN, and browse your library. First run scans your folders; large libraries index in the background.

## Configure

Edit `config.json` (copied from `config.example.json`):

| Key | What it does |
|---|---|
| `roots` | Array of folders to scan for music. |
| `videoShows` | Optional: `[{ "id", "name", "path" }]` folders of video files. |
| `adminPin` | Second factor for library/admin actions. **Change it.** |
| `members` | Extra profiles (each with their own `code` and play history). |

Environment overrides: `PORT` (default `3010`), `REEL_PIN` (front-door PIN), `REEL_ADMIN_PIN`, `FFMPEG_PATH` (optional — only for on-the-fly transcoding).

## Notes

- **ffmpeg is optional.** Reel plays your files directly; ffmpeg is only used to transcode formats a browser can't play natively. Without it, most common formats still stream fine.
- **Voice search** uses a local Whisper worker (`whisper-worker.py`) if Python + the model are available — entirely on-device, nothing leaves the machine.
- **Remote-desktop bridge:** Reel includes an optional noVNC bridge that can screen-share the *host* machine to an authenticated admin (loopback-only on the server side). If you don't want it, ignore it — it's gated behind the admin factor.
- **Set a real PIN before exposing Reel to anything.** The shipped default (`0000`) is a placeholder and the server will warn you loudly until you change it.

## License

[AGPL-3.0](../../LICENSE).
