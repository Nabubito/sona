# Attic

**A photo & video vault that never leaves your house.**

Open the Attic in any device's browser, grant the camera, and shoot. Every photo and video is sent to your own PC, saved into a plain `Camera Roll` folder, and tucked into a private, date-organized vault — deduplicated and catalogued. Nothing goes to anyone's cloud unless *you* wire up an off-site backup yourself.

Part of [Sona](../..). One dependency (`express`). No native image libraries — thumbnails are rendered in the browser.

## Run it

```bash
npm install
CAM_PASS=your-passcode npm start
```

Open **http://localhost:3060**, enter your passcode, and start shooting. Photos land in `Camera Roll/` on the host, archived into `Camera Roll/.vault/`.

## Configure

All via environment variables:

| Var | What it does |
|---|---|
| `PORT` | Port (default `3060`). |
| `CAM_PASS` | Your unlock passcode. **Set this** — the default `0000` is a placeholder. |
| `CAM_ROLL` | Where photos are saved (default: a `Camera Roll` folder). |
| `CAM_VAULT` | The private archive folder. |
| `CAM_RCLONE_REMOTE` | Optional: an [rclone](https://rclone.org) remote for off-site backup. **Off by default — nothing leaves your machine unless you set this.** |
| `FFMPEG_PATH` | Optional — only used for video. |

## How private is it, really?

The "vault" is a normal folder on your disk. Verify it yourself: shoot a photo, then look in the folder. There is no telemetry, no analytics, no phone-home. The only way anything leaves the box is if you explicitly configure rclone.

## Reaching it from your phone

Bind is `0.0.0.0` by default so a private mesh VPN ([Tailscale](https://tailscale.com) / WireGuard) can reach it end-to-end encrypted. Don't expose it on a bare untrusted LAN without TLS — put it behind the VPN or your own reverse proxy.

## License

[AGPL-3.0](../../LICENSE).
