# Forge

**A workshop for your files that never leaves your house.**

Drop in a video, a disc image, or an archive and Forge shows you what it can do with it. Turn a clip into a GIF, shrink a video so it fits in an email, pull the audio out, resize an image, cut a movie on a timeline, open or build a `.zip` / `.7z`, browse and extract an `.iso`, or on Windows mount one as a drive. Everything runs on your own machine with tools you already trust. No upload, no ads, no size caps, no watermark.

Part of [Sona](../..). Zero npm dependencies for the server (Node's built-in `http`). An optional app window uses Electron.

## Run it

```bash
npm start
```

Open **http://localhost:4470**. The first time, Forge asks you to choose a passcode of at least 8 characters (only from the machine it runs on). After that, the passcode unlocks it.

No `npm install` is needed for the server. Install only if you want the app window:

```bash
npm install
npm run app
```

## Engines

Forge ships no binaries. It uses the tools already on your machine, looked up on your `PATH`, or at a path you set. The top bar shows which ones it found; click it for install hints.

| Engine | Powers | Install |
|---|---|---|
| `ffmpeg` + `ffprobe` | Media tools, the video editor | Windows `winget install Gyan.FFmpeg` · macOS `brew install ffmpeg` · Linux `sudo apt install ffmpeg` |
| 7-Zip (`7z`, `7zz` or `7za`) | Archives, browsing and extracting disc images | Windows `winget install 7zip.7zip` · macOS `brew install sevenzip` · Linux `sudo apt install p7zip-full` |
| Windows disc features | Mount, eject, build ISO | Built into Windows (Mount-DiskImage and IMAPI2). Nothing to install. |

Missing an engine only turns off what it powers; the rest keeps working. Restart Forge after installing one.

**Disc tools are Windows-only.** On Linux and macOS Forge runs the media and archive tools as normal, and you can still browse and extract disc images with 7-Zip. Mount and Build ISO are simply hidden.

## Configure

Environment variables, or a `config.json` next to `server.js` (copy `config.example.json`). Environment wins.

| Env | `config.json` | What it does |
|---|---|---|
| `FORGE_HOST` | `host` | Address to bind. Default `127.0.0.1` (this machine only). |
| `FORGE_PORT` | `port` | Port. Default `4470`. |
| `FORGE_DATA` | `dataDir` | Data folder: uploads, editor projects, passcode hash. Default `data/` in this folder. |
| `FORGE_OUT` | `outDir` | Where results are written. Default `data/out/`. |
| `FORGE_ROOTS` | `roots` | Folders Forge may read from and write to (separate with `;` on Windows, `:` elsewhere). Default: your home folder. Forge's output folder and upload inbox are always included. |
| `FORGE_BROWSE_START` | `browseStart` | Where the folder picker opens. Default your home folder. |
| `FORGE_MAX_UPLOAD` | `maxUpload` | Largest drag-and-drop upload, in bytes. Default 8 GiB. Uploads are also refused when the disk is nearly full. |
| `FORGE_FFMPEG` / `FORGE_FFPROBE` / `FORGE_7Z` | `engines.ffmpeg` / `engines.ffprobe` / `engines.sevenzip` | Explicit engine paths, if they are not on `PATH`. |
| `FORGE_FFMPEG_THREADS` | `ffmpegThreads` | Cap ffmpeg threads per job, to keep the machine responsive. Default: ffmpeg decides. |
| `FORGE_FONT` | `titleFont` | Font file for editor titles. Default: a common bold sans for your OS. |
| `FORGE_PASS` | | Use a fixed passcode (8+ characters) instead of the one chosen on first run. |

To reset a forgotten passcode, stop Forge and delete `data/auth.json`. The next visit from this machine asks for a new one.

## How private is it, really?

Your files are read and written on this machine only. Forge calls `ffmpeg` and 7-Zip as local processes; nothing is sent anywhere. The page's content policy only lets it load from and connect to Forge itself, so it cannot fetch outside scripts or phone home. (It does allow inline scripts, which the UI uses.) There is no telemetry and no analytics. Results land in a plain folder you choose.

## Security, plainly

**The passcode is the only wall.** Anyone who has it can do everything Forge can do, acting as the user account that runs Forge: read any file inside the allowed roots (by default your whole home folder), write new files there, and run ffmpeg and 7-Zip on them. Pick a real passcode, and keep the roots as narrow as you need with `FORGE_ROOTS`.

What Forge does on its side:

- Every path the browser sends (source files, output paths, folders to browse, archive inputs, editor clips) is resolved, symlinks included, and refused unless it sits inside an allowed root.
- Requests that change anything must come from Forge's own page (cross-site requests are refused) and the session cookie is `SameSite=Strict`.
- Wrong passcodes lock the client out for 15 minutes after 8 tries, with a global cap on top.
- Tool options are checked against each tool's declared values, and file names are never passed to a tool where they could be read as a switch.

## Reaching it from another device

Forge binds to `127.0.0.1` by default, so only this machine can open it. It is a tool that reads and writes files on the host, so treat remote access with care: if you want it on your phone, set `FORGE_HOST=0.0.0.0` and reach it only through a private mesh VPN (WireGuard or similar) or your own TLS reverse proxy. Never expose it on an untrusted network.

## Right-click menu (Windows, optional)

**Start install** (Discs tab, app window only) runs a mounted disc's installer when you click it: the `open=` entry of its `autorun.inf`, or a `setup.exe` / `install.exe` at the root. It never runs on its own. Only mount images you trust.

With the app window installed, `electron/install-shell.ps1` adds per-user "Open / Mount / Extract with Forge" verbs to Explorer. Run it with `-Remove` to take them away.

## License

[AGPL-3.0](../../LICENSE).
