# Keepalive Investigation (PHASE FIVE iter 17)

Date: 2026-05-09
Goal: determine whether the relay has a configurable keepalive /
heartbeat / timeout knob we can tune to prevent the spontaneous
disconnects observed in the user's Sunshine log (35-53min intervals).

## Inventoried sources

### `relay/server/data.json` (user database)
Pure user/host database. No connection-lifecycle knobs.
```json
{
  "version": "2",
  "users": { "1045179896": { "role": "Admin", ... } },
  "hosts": {}
}
```

### `relay/server/config.json` (written by relayManager.writeConfig)
Currently absent on disk (only written when relay is starting). The
schema relayManager produces (`src/relayManager.ts:98-128`) contains:

- `data_storage.session_expiration_check_interval`: 300s — internal
  HTTP session sweep, NOT stream keepalive
- `web_server.session_cookie_expiration`: 86400s — cookie expiry, NOT
  stream keepalive
- `webrtc.port_range`, `webrtc.network_types`, `webrtc.disabled: true`
- `moonlight.default_http_port`: 47989, `pair_device_name`: 'moo-capture'
- `log.level_filter`: 'INFO'

**No keepalive setting.** Connection lifetime is owned by the moonlight
protocol implementation in the binary, not exposed as config.

### `relay/static/default_settings.js` (iframe-side runtime knobs)
Full list (read at runtime from localStorage `mlSettings`):
- video: `bitrate`, `packetSize`, `fps`, `videoFrameQueueSize`,
  `videoSize`, `videoSizeCustom`, `videoCodec`, `forceVideoElementRenderer`,
  `canvasRenderer`, `canvasVsync`, `hdr`
- audio: `playAudioLocal`, `audioSampleQueueSize`
- transport: `dataTransport` (auto / webrtc / websocket)
- input: `mouseScrollMode`, `controllerConfig` (incl. `sendIntervalOverride`)
- UI: `sidebarEdge`, `toggleFullscreenWithKeybind`, `pageStyle`,
  `useSelectElementPolyfill`

**No keepalive setting.** None of these affect the underlying
moonlight protocol heartbeat / RTSP keepalive cadence.

### Binary inspection
`strings web-server.exe | grep -iE 'keepalive|heartbeat|timeout|interval'`
returned no matches in the searchable strings (Rust binaries use
debug-stripped builds with little plain-text). No documented
config flags surface either via `--help` (the relay accepts only
`--config-path` and `--bind-address`).

### Relay HTTP API
Probed `/api/info`, `/api/server`, `/api/config` — none exist. The
relay exposes only the documented endpoints (`/api/hosts`, `/api/host`,
`/api/host/cancel`, `/api/apps`, login, etc.). No runtime knob to
tune keepalive.

## Conclusion

**The relay (moonlight-web-stream v2.6-prerelease.2) does NOT expose
any user-tunable keepalive / heartbeat / timeout knob.** The
underlying RTSP / WebRTC / WebSocket connection lifetime is controlled
by the moonlight protocol implementation inside the compiled binary,
with no escape hatch.

The Chromium-WebRTC-throttling-induced disconnect happens BELOW the
relay's API surface — the iframe's `RTCPeerConnection` (or WebSocket
in our config since `webrtc.disabled: true`) gets throttled by the
browser's hidden-tab policy, the streamer.exe loses its keepalive
acknowledgements, and the UDP listener tears down. We cannot prevent
this from happening at the relay-config layer.

## Mitigation in place

The watchdog approach (PHASE THREE log-based + PHASE FOUR
heartbeat-based, sharing a single `fireReconnect` entry point) is the
ONLY mitigation available. It does not prevent the disconnect — it
masks it by detecting and reconnecting in 1.5-3s, faster than the user
typically notices, and gated by a 3-per-60s circuit breaker against
runaway loops.

If a future relay version exposes a keepalive knob, the appropriate
place to set it is in `RelayManager.writeConfig` at
`src/relayManager.ts:98-128`, alongside the other relay config keys.

PHASE FIVE iter 17 closes out as documented. No code changes.
