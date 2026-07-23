# Kin

**Private calls and messages with the people you love — peer-to-peer.**

A tiny, self-hosted messenger and voice/video caller for a small circle. Your calls go device-to-device over WebRTC — your voice never touches a server. Messages, voice notes, attachments, reactions, read receipts, scheduled send, and web push, all from a box in your own house.

Part of [Sona](../..). Pure JavaScript (`express` + `ws`), SQLite via Node's built-in engine.

## Run it

```bash
npm install
cp config.example.json config.json   # set a private passcode for each person
npm start
```

Open **http://localhost:3095**, enter a passcode, and you're in. It runs out of the box on the example config; edit `config.json` to set real passcodes and names.

## Configure

`config.json` (copied from `config.example.json`):

| Key | What it does |
|---|---|
| `users` | Map of `passcode → { id, name, avatar }`. Each person gets their own private passcode — that's the whole guest list. |
| `owner` | The `id` with owner rights (e.g. clearing history). |
| `iceServers` | STUN servers for WebRTC (public Google STUN by default). |
| `turn` | Optional TURN relay — only needed if a call won't connect when you're *not* on the same network or mesh. |

Environment: `PORT` (default `3095`), `SONA_PUSH_CONTACT` (contact string for web-push VAPID), `SONA_HOSTS` (extra allowed origins for the WebSocket upgrade, comma-separated — add your Tailscale hostname here).

## Reaching it from your phone

The clean path is a private mesh VPN ([Tailscale](https://tailscale.com) / WireGuard): it puts every device on one virtual LAN, so peer-to-peer calls connect directly with no TURN server to run, and nothing is exposed to the public internet. Add your mesh hostname to `SONA_HOSTS`.

## License

[AGPL-3.0](../../LICENSE).
