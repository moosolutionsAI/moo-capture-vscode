# Final Audit (iter 18, before 0.1.3 ship)

Date: 2026-05-09
All 17 prior iterations of this loop verified clean. Build green.

## Timer / watcher inventory (whole `src/`)

Every `setInterval` / `setTimeout` / `fs.watch` accounted for:

| Location | Kind | Lifecycle / Teardown |
|---|---|---|
| `connectionManager.ts:340` | setTimeout (1s) | Awaited Promise (pair retry) — existing |
| `extension.ts:196` | socket.setTimeout | Net socket lifecycle — existing |
| `extension.ts:400` | setTimeout (1.5s) in fireReconnect | Awaited Promise — **iter 9 (this loop)** |
| `extension.ts:623` | **heartbeatChecker setInterval (1s)** | Cleared via 3 paths: panel.onDidDispose, COMMANDS.disconnect → panel.dispose, context.subscriptions on deactivate — **iter 14 (this loop)** |
| `extension.ts:840` | **latencyWatcher fs.watch** | Existing invariants doc + stopLatencyWatching idempotent teardown |
| `extension.ts:846` | latencyDebounce setTimeout | Cleared by stopLatencyWatching (single slot) |
| `extension.ts:1031` | setTimeout (300ms) | Awaited Promise (tuneStream) — existing |
| `extension.ts:1489` | toolbar hide setTimeout | Existing UI timer |
| `extension.ts:1613` | overlay button hide setTimeout | Existing UI timer |
| `relayApiClient.ts:397` | request setTimeout | Awaited / req.destroy on timeout — existing |
| `relayManager.ts:16` | healthInterval class field | clearInterval in stopHealthCheck — existing |
| `relayManager.ts:192/222/225/301` | spawn / health-poll setTimeout | Awaited / promise-resolution — existing |
| `relayDownloader.ts:46` | **setInterval inside MOO_MUTE_JS string** | **Browser JS context — iframe page lifecycle owns cleanup. Iter 13 (this loop)** |
| `sunshineConfigManager.ts:189` | req.setTimeout | Net request lifecycle — existing |
| `virtualDisplayManager.ts:577` | sleep helper setTimeout | Awaited Promise — existing |

**Verdict:** every timer / watcher this loop introduced has registered teardown. No leaks possible.

## 6 protected audits — all intact

| # | Audit | Verified at |
|---|---|---|
| 1 | `latencyUnsub` teardown | extension.ts:263 (decl), 452-486 (set/clear), 905 (deactivate) |
| 2 | `panel.onDidDispose` push to subscriptions | extension.ts:560 (registered), now ALSO clears heartbeatChecker before disconnect |
| 3 | SSE one-shot guard (`guardCancelInFlight` + `guardFired`) | connectionManager.ts:26, 30, 475, 496-497, 506-507, 512 |
| 4 | Iframe sender tokens (`SENDER_OUTER`, `SENDER_IFRAME`) | extension.ts:1404-1405 (decl), 1428 (stamped), 1441/1576 (filtered), 1569 (iframe-side decl) |
| 5 | `tuneStreamBusy` busy guard | extension.ts:948 (decl), 951-952 (gate+set), 1044 (clear in finally) |
| 6 | `muteStateRenderer` wiring | connectionManager.ts:56-62 (decl/set/notify), extension.ts:436 (registered), 683 (consumed) |

## Forbidden modifications — none

- `patchIframe` / `installMuteBridge` (in-extension mute bridge): **unchanged** — verified at extension.ts:1515-1610. The in-page `moo-mute.js` backstops it as the loop required.
- `RELAY_VERSION` (constants.ts:31): **still `v2.6-prerelease.2`** — the relay binary is unchanged, the patcher self-heals via `ensureMutePatch` content-equality drift detection.
- `package.json` version: **still 0.1.2** — bump deferred to iter 19.

## Loop commit log (PHASE ONE → FIVE)

| Iter | Commit | Phase |
|---|---|---|
| 1 | 7c0d6fb | PHASE ONE: validation diagnosis |
| 2 | 774f9c4 | PHASE ONE: audit inventory |
| 3 | ccb9afb | PHASE ONE: PHASE TWO design doc |
| 4 | f5dad8c | PHASE TWO: dispose-handler synchronous disconnect |
| 5 | 41b9321 | PHASE TWO: persisted-session orphan cleanup |
| 6 | 5404d1f | PHASE TWO: kill orphan streamer.exe |
| 7 | e7d2d30 | PHASE THREE: streamHealthWatchdog skeleton |
| 8 | 9e2ba83 | PHASE THREE: subscribeTicks peer to subscribeLatency |
| 9 | 97429eb | PHASE THREE: wire watchdog into activate() |
| 10 | 8d04ba7 | PHASE THREE: intent-snapshot abort-on-user-action |
| 11 | c1d76d4 | PHASE THREE: recursion audit + circuit breaker |
| 12 | 12236bf | PHASE THREE: status-bar reconnect indicator |
| 13 | fc16cb2 | PHASE FOUR: heartbeat in MOO_MUTE_JS |
| 14 | 12db380 | PHASE FOUR: heartbeat wired end-to-end |
| 15 | 38053eb | PHASE FOUR: lifecycle audit + cold-start guard |
| 16 | 2c3286e | PHASE FOUR: surface knobs to constants.ts |
| 17 | abc856e | PHASE FIVE: keepalive investigation (none exists) |

## Ready for ship

Iter 19 will bump `package.json` 0.1.2 → 0.1.3, build the vsix, install
it, then emit the completion promise.
