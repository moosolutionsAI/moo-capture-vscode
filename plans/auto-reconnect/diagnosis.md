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
