# PHASE TWO Design — Dispose Race Class

PHASE TWO budget: iterations 4, 5, 6. Three discrete changes, one per
iteration, all tied to the "prior session not fully torn down" root
cause that produced the 16:27 collision.

## Iteration 4 — Move `disconnect()` to top of dispose handler (PHASE TWO core)

**File:** `src/extension.ts:377-412`

**Change:**

```ts
panel.onDidDispose(async () => {
  // CRITICAL: dispose synchronously BEFORE awaiting the modal. The
  // 2026-05-09 16:27 collision was caused by Cursor reload tearing
  // down the extension host while this handler was suspended at the
  // await below — disconnect() was reached only on interactive close,
  // never on reload. Moving the call here guarantees the cancelStream
  // HTTP is dispatched the moment the panel disappears, regardless of
  // whether the modal ever resolves.
  connManager.disconnect();

  if (programmaticReconnect) {
    statusBar.text = STATE_LABELS.disconnected;
    statusBar.tooltip = 'Reconnecting with new settings...';
    panel = undefined;
    return;
  }

  const choice = await vscode.window.showInformationMessage(
    'Moo Capture tab closed. Keep relay running for fast reconnect?',
    'Keep Relay',
    'Shut Down Everything',
  );

  if (choice === 'Shut Down Everything') {
    connManager.dispose();
    statusBar.text = STATE_LABELS.disconnected;
    statusBar.tooltip = 'Relay stopped. Click to reconnect.';
  } else {
    // Keep Relay (or dismissed) — stream is already cancelled above.
    statusBar.text = '$(game) Moo Capture (Ready)';
    statusBar.tooltip = 'Relay running. Click to reconnect instantly.';
  }
  panel = undefined;
});
```

**Audit-preservation:**
- `panel.onDidDispose` is still pushed to `context.subscriptions`
  exactly as before (line 376) — no change to the registration call.
- `programmaticReconnect` flag still respected; modal is skipped when set.
- The modal collapses from 3 options to 2 (Keep Stream / Stop Stream /
  Shutdown → Keep Relay / Shut Down). Stream is *always* stopped now
  because there's no longer a "keep stream alive" path in the new
  dispose semantics — which matches reality (the panel is gone, the
  stream has nowhere to render).
- `connManager.disconnect()` is idempotent (it checks `apiClient &&
  lastHostId`) so calling it then immediately calling `dispose()` in
  the Shutdown branch is safe; `dispose()` calls `disconnect()`
  internally as part of its sequence.

**Verification this iteration:**
1. Build clean
2. Read the modified handler in full
3. Grep for any other `panel.onDidDispose` reference (expect 1 in
   extension.ts plus 1 in stats panel) — make sure the stats panel
   handler is untouched.
4. Commit.

## Iteration 5 — Activation-time orphan check

**Rationale:** The defensive teardown at `connectionManager.ts:85-89`
gates on `apiClient && lastHostId !== null && relay.isRunning`. After
a Cursor reload (or crash, or OS reboot with relay survived) the new
ConnectionManager has all-null state, so the guard is skipped and the
new connect collides with the orphan session in Sunshine.

**File:** `src/extension.ts` — new function peer to `checkCrashRecovery`

**Change:**

```ts
function checkRelayOrphans(
  globalStoragePath: string,
  output: vscode.OutputChannel,
): void {
  // Fire-and-forget. Probes the relay's HTTP port; if up, logs in
  // with internal creds, lists hosts, and cancels any active stream.
  // Self-heals after Cursor crash / OS reboot / dispose-handler skip.
  // Wrapped in IIFE to keep activate() synchronous.
  (async () => {
    const downloader = new RelayDownloader(globalStoragePath, output);
    if (!downloader.isInstalled()) { return; }
    // Quick HTTP probe on default port; if relay isn't running, no
    // orphans are possible (Sunshine drops sessions when the client
    // socket dies).
    const port = RELAY_DEFAULT_PORT;
    const reachable = await new Promise<boolean>((resolve) => {
      const req = require('http').get(
        `http://127.0.0.1:${port}/`,
        { timeout: 1500 },
        (res: any) => { res.resume(); resolve(true); },
      );
      req.on('error', () => resolve(false));
      req.on('timeout', () => { req.destroy(); resolve(false); });
    });
    if (!reachable) { return; }
    try {
      const client = new RelayApiClient(port, output);
      await client.login(RELAY_INTERNAL_USER, RELAY_INTERNAL_PASS);
      const hosts = await client.listHosts();
      for (const host of hosts) {
        await client.cancelStream(host.host_id).catch(() => {});
        output.appendLine(`[OrphanCheck] Cancelled stale stream on host ${host.host_id}`);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      output.appendLine(`[OrphanCheck] Skipped (${msg})`);
    }
  })();
}
```

Called from activate() after `checkCrashRecovery`:
```ts
checkCrashRecovery(context.globalStorageUri.fsPath, output);
checkRelayOrphans(context.globalStorageUri.fsPath, output);
```

**Audit-preservation:**
- No setInterval / setTimeout / fs.watch introduced — pure async HTTP.
- IIFE is fire-and-forget; no subscription needed because no resources
  are held beyond the HTTP request which times out at 1500ms.
- Re-uses existing `RelayApiClient` and `RelayDownloader` patterns.

**Verification this iteration:**
1. Build clean
2. Confirm `RelayApiClient.listHosts` exists (or use `getHosts` —
   verify in iteration 5)
3. Confirm cancelStream is idempotent (already verified — disconnect()
   uses `.catch(() => {})`)
4. Grep new function for any setInterval/setTimeout — expect zero.
5. Commit.

## Iteration 6 — Extend `killStaleRelayProcesses` to also kill `streamer.exe`

**Rationale:** PID 44080 in user's environment is the `streamer.exe`
spawned by the prior `web-server.exe`. When web-server is killed by
`killStaleRelayProcesses`, streamer survives — it's not parented in a
job object. Its UDP socket continues to attempt communication with
Sunshine, contributing to the zombie-session state.

**File:** `src/relayManager.ts:49-63`

**Change:** add a second `Stop-Process` call for `streamer.exe`:

```ts
private killStaleRelayProcesses(binaryPath: string): Promise<void> {
  return new Promise((resolve) => {
    const { exec } = require('child_process') as typeof import('child_process');
    const binaryName = path.basename(binaryPath, '.exe');
    // Kill BOTH web-server (the relay HTTP server) AND streamer (its
    // child that holds the UDP socket to Sunshine). Streamer is not
    // job-parented to web-server so it outlives a parent kill;
    // 2026-05-09 PID 44080 was a confirmed streamer orphan.
    exec(
      `powershell -NoProfile -Command "Get-Process -Name '${binaryName}','streamer' -ErrorAction SilentlyContinue | Stop-Process -Force"`,
      { timeout: 5000 },
      (err) => {
        if (!err) {
          this.output.appendLine('[Relay] Killed stale relay + streamer processes');
        }
        resolve();
      },
    );
  });
}
```

**Audit-preservation:**
- Single PowerShell invocation, same pattern, same timeout.
- No new subscriptions / timers / watchers.
- The function is still called only from `start()` line 36 — flow unchanged.

**Verification this iteration:**
1. Build clean
2. Verify the PowerShell command parses both names correctly with
   `Get-Process -Name a,b` syntax (well-supported, no escaping issues).
3. Commit.

## Sequencing rationale

- **Iter 4 first** because it's the literal PHASE TWO ask and most
  important — fixes the common case (interactive panel close + reload).
- **Iter 5 second** because it's the safety net for cases iter 4 still
  misses (crash, OS reboot, force-quit, race conditions).
- **Iter 6 third** because it's the cleanup for any zombie streamer
  processes that survived the previous fixes — strictly defensive.

Each builds on the prior. Iter 6 alone wouldn't fix anything user-
visible (the next start() always kills relay processes anyway); it's
specifically about the *currently orphaned* PID 44080 that's still
running RIGHT NOW on the user's machine.