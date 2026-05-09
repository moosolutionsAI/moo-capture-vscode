# Auto-Reconnect Diagnosis (PHASE ONE Validation)

Date: 2026-05-09
Iteration: 1
Baseline: `npm run build` clean on 0.1.2
Sunshine log analysed: `C:/Program Files/Sunshine/config/logs/sunshine-20260509-014332-221.log`

## Status: STOPPED — one premise fails as written

Per the loop's strict rule "If any premise fails STOP and report instead
of proceeding", validation halts here. The underlying bug + proposed fix
remain correct, but the *mechanism* I cited is wrong. Continuing without
acknowledging that would risk implementing for the wrong reason.

## Premise-by-premise audit

### Premise 1 — UDP socket refused precedes every disconnect
**TRUE.** Confirmed in earlier inspection. All four `CLIENT DISCONNECTED`
events today (09:23:40, 11:02:18, 14:42:20, 16:27:12) are preceded
within milliseconds by:
```
Error: Couldn't receive data from udp socket:
       No connection could be made because the target machine actively refused it
```
The disconnect originates client-side (relay's `streamer.exe` UDP
listener gone), not Sunshine-side.

### Premise 2 — Dispose handler returns undefined and skips disconnect
**FALSE as worded.** Re-read `extension.ts:377-412`. The handler IS
async, IS awaiting a modal, AND undefined is returned when dismissed —
BUT the dismiss path falls into the `else` branch at line 405-410:

```js
} else {
  // Keep Relay Running (or dismissed) — just cancel the active stream
  connManager.disconnect();   // ← disconnect IS called
  ...
}
```

So the wording "NO disconnect runs in that branch" is wrong. **The
actual mechanism is different**: during a Cursor *reload* or window
shutdown, the extension host process is torn down before the
`await vscode.window.showInformationMessage(...)` resolves. The async
function suspends at the await and never reaches the `if/else if/else`
chain. `disconnect()` is reached in normal interactive close, but NOT
during host teardown.

### Premise 3 — `retainContextWhenHidden: true` on the panel
**TRUE.** `extension.ts:368`. Confirmed.

### Premise 4 — 15:16 session never disconnected before 16:27 reconnect
**TRUE.** Sunshine event timeline today:
```
03:12 connect → 09:23 disconnect (clean)
10:08 connect → 11:02 disconnect (clean)
14:06 connect → 14:42 disconnect (clean)
15:16 connect → [no disconnect logged]    ← zombie
16:27 connect → 16:27 disconnect (5s, collision)
```

## Additional finding not in the original premises

`connectionManager.ts:85-89` already has a *Defensive teardown* at the
start of `connect()`:
```js
if (this.apiClient && this.lastHostId !== null && this.relay.isRunning) {
  this.apiClient.cancelStream(staleHostId).catch(() => {});
}
```
This guard **cannot fire after a Cursor reload** because `apiClient` and
`lastHostId` are fresh-initialised in the new ConnectionManager
instance. The new instance has no memory of the prior session's host id,
so the defensive teardown is skipped, and the new connect collides with
the still-registered Sunshine session.

## Proposed corrections to the plan

The fix described in PHASE TWO is still the right shape, but the
justification needs amending:

1. **Move `connManager.disconnect()` to run synchronously at the top of
   the dispose handler, BEFORE the `await`.** This guarantees the
   `cancelStream` HTTP request is dispatched even when the extension
   host is being torn down and the modal never resolves.

2. **Add an activation-time orphan check** (was Phase 5 / "optional 3rd"
   in chat). On extension activate, before any user-initiated connect,
   query `/api/hosts` if the relay is running. If any host reports an
   active session, fire `cancelStream` on it. Self-heals after Cursor
   crashes / OS shutdown / any path that bypassed the dispose handler.

The PHASE THREE watchdog and PHASE FOUR heartbeat designs are unchanged
— they handle the runtime spontaneous-disconnect class of bug
(WebRTC-throttling-induced UDP refused), which is independent of the
dispose-race class.

## Recommended next action

Modify the loop prompt's PHASE ONE wording to match the actual
mechanism, then re-run. Suggested replacement:

> Confirm panel.onDidDispose around extension.ts line 377 is async and
> awaits a modal. Confirm that during Cursor window reload the await
> may not resolve before the extension host is torn down, leaving
> disconnect unreached. Confirm createWebviewPanel...

OR explicitly accept the corrected mechanism and update PHASE TWO to
add the activation-time orphan check alongside the dispose-race fix.

---

## Iteration 2 addendum — audit inventory and codebase context

### Audits I must not weaken (per CRITICAL RULES)

| Audit | Location | What it guards |
|---|---|---|
| `latencyUnsub` teardown | `extension.ts:653-657` | fs.watch lifecycle; closed at extension deactivate |
| Panel disposables | `extension.ts:376-413` | `panel.onDidDispose` pushed to context.subscriptions |
| SSE one-shot guard | `connectionManager.ts:25-30, 419-447` | `guardCancelInFlight` (in-flight) + `guardFired` (one-shot per session) |
| Iframe sender tokens | `extension.ts:1132-1182, 1291-1298` | SENDER_OUTER / SENDER_IFRAME prevent postMessage self-echo |
| `tuneStreamBusy` busy guard | `extension.ts:676-772` | Single bool prevents tuneStream re-entry |
| `muteStateRenderer` wiring | `connectionManager.ts:53-62` | Callback decoupling for status-bar mute icon |

### Existing infrastructure relevant to PHASE 3 watchdog

- **`SUNSHINE_LOG_DIR`** (`constants.ts:69`) → what watchdog tails.
- **fs.watch / debounce / single-watcher invariant** documented at
  `extension.ts:557-571`. The watchdog must reuse `subscribeLatency`
  pattern, NOT spawn its own fs.watch (that would violate the
  "exactly one fs.FSWatcher exists" invariant).
- **`subscribeLatency(cb)`** (`extension.ts:633-644`) returns an
  unsubscribe function — perfect signature for the watchdog to
  consume. We add a parallel `subscribeLogLines` or pass a richer
  snapshot through the existing `LatencySnapshot`.
- **Relay `healthInterval`** (`relayManager.ts:228-235`) polls HTTP
  every 5s but only LOGS failures. The watchdog could extend this
  to also act on detected relay death.

### Existing infrastructure relevant to PHASE 2 dispose race

- **`killStaleRelayProcesses`** (`relayManager.ts:49-63`) already
  kills orphan `web-server.exe` BEFORE spawning a new relay. **GAP:**
  it does NOT kill orphan `streamer.exe`. The user's PID 44080 is
  exactly this case — streamer outlived web-server's death. This is
  worth fixing in the same area as PHASE 2 (dispose race).
- **`Defensive teardown`** (`connectionManager.ts:85-89`) gated on
  `apiClient && lastHostId !== null && relay.isRunning` — cannot fire
  after Cursor reload (fresh ConnectionManager has all-null state).
  Activation-time orphan check fills this gap.

### Sunshine log evidence (re-confirmed iteration 2)

Pattern across all 4 disconnects today is identical:
```
[normal frame activity, then sudden silence]
Error: Couldn't receive data from udp socket: ...refused
CLIENT DISCONNECTED
Error: Couldn't receive data from udp socket: ...refused
Starting async encoder teardown
Async encoder teardown complete
Resetting Input...
```

The UDP refused error PRECEDES the disconnect logging by ms — Sunshine
is REACTING to the streamer's UDP listener disappearing, not initiating
the teardown. This rules out Sunshine-side timeout configuration as
the cause; the relay's streamer.exe closes its sockets first.

### Iteration 2 status

PHASE ONE deepened, no code changed. Still STOPPED on premise #2
wording. Proceeding to PHASE TWO requires either prompt amendment or
explicit acceptance of the corrected mechanism. Iteration 3 (last
PHASE ONE iteration per the prompt budget) can use either to:
- Verify the proposed activation-time orphan check fits cleanly into
  the existing connect() flow without violating audits, OR
- Verify the streamer.exe gap in killStaleRelayProcesses can be
  patched without breaking that audit.
