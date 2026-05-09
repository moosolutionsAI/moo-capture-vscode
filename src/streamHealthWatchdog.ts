// ---------------------------------------------------------------------------
// Stream Health Watchdog (PHASE THREE)
// ---------------------------------------------------------------------------
//
// Detects spontaneous Sunshine `CLIENT DISCONNECTED` events at runtime and
// triggers a programmatic reconnect so the user sees a brief flicker rather
// than a dead stream. The Chromium webview throttles WebRTC heartbeats when
// backgrounded, the relay's streamer.exe times out and tears down its UDP
// listener, and Sunshine logs the disconnect — this watchdog reacts to that
// log line.
//
// Architecture:
//   - DOES NOT spawn its own fs.watch. The activate() function in
//     extension.ts already owns a single fs.FSWatcher on SUNSHINE_LOG_DIR
//     (latencyWatcher), with the documented invariant "exactly one
//     fs.FSWatcher exists at a time". The watchdog instead consumes ticks
//     from a caller-provided `subscribeTicks` callback. extension.ts
//     wires this to fire on the same debounced fs.watch event that drives
//     fanOutLatency.
//   - On each tick, reads only the bytes appended since the last tick
//     (incremental tail), scans for the disconnect line, and fires
//     `triggerReconnect` if all gates pass.
//
// Gates (ALL must pass before reconnect fires):
//   1. The disconnect line is from AFTER the watchdog's start time.
//   2. `isPanelOpen()` returns true (no panel = nothing to recover).
//   3. `isUserDisconnectRecent()` returns false (don't fight the user).
//   4. `cancelInFlight` is false (one-shot; mirrors connectionManager
//      startSessionGuard's `guardCancelInFlight` pattern exactly).
//
// Lifecycle is owned by the caller via the returned dispose() — start
// returns a Disposable that the caller pushes into context.subscriptions
// (mirroring the latencyUnsub pattern at extension.ts:653-657). The
// watchdog itself holds NO timers, NO file watchers, NO subscriptions —
// just one byte offset and a few flags.

import * as fs from 'fs';
import type { OutputChannel } from 'vscode';
import { findLatestLog } from './sunshineLogReader';

export interface StreamHealthDeps {
  /** Where Sunshine writes its rolling logs. */
  sunshineLogDir: string;
  output: OutputChannel;
  /**
   * Returns true while the Moo Capture panel is open. When false, no
   * reconnect attempt fires (nothing to recover into).
   */
  isPanelOpen: () => boolean;
  /**
   * Returns true if the user explicitly clicked Disconnect (or otherwise
   * initiated a teardown) within the last 2 seconds. Acts as the
   * intent-respecting gate so we never fight a deliberate close.
   */
  isUserDisconnectRecent: () => boolean;
  /**
   * Performs the actual reconnect: cancelStream → wait 1500ms → re-run
   * connect with programmaticReconnect=true. The watchdog awaits this
   * promise and clears `cancelInFlight` only when it resolves OR rejects,
   * so a stuck reconnect cannot block subsequent tries indefinitely
   * (caller is expected to cap its own duration).
   */
  triggerReconnect: () => Promise<void>;
  /**
   * Subscribe to log-directory change ticks. Caller wires this to the
   * existing latency watcher's debounced fs.watch event. Returns an
   * unsubscribe function the watchdog calls on dispose().
   */
  subscribeTicks: (cb: () => void) => () => void;
}

export interface StreamHealthHandle {
  dispose: () => void;
  /** Called by the consumer when the user clicks Disconnect, so the
   * watchdog skips reconnect on the disconnect line that follows. */
  noteUserDisconnect: () => void;
}

/** Regex for the line Sunshine emits when a client connection ends. */
const RE_CLIENT_DISCONNECTED = /CLIENT DISCONNECTED/;

/**
 * Scan `text` for `CLIENT DISCONNECTED` lines and return how many were
 * found. Pure function — no I/O, no state. Exposed for testing.
 */
export function countDisconnectsIn(text: string): number {
  let count = 0;
  let from = 0;
  while (true) {
    const idx = text.indexOf('CLIENT DISCONNECTED', from);
    if (idx === -1) { break; }
    count++;
    from = idx + 'CLIENT DISCONNECTED'.length;
  }
  return count;
}

export function startStreamHealthWatchdog(deps: StreamHealthDeps): StreamHealthHandle {
  const startTime = Date.now();
  // Track per-log-file byte offset of the last bytes we scanned. When the
  // active log file rotates (Sunshine starts a new one), we reset the
  // offset to the new file's size — anything older is below our start
  // time and irrelevant.
  let trackedLogPath: string | null = null;
  let trackedOffset = 0;
  // One-shot in-flight gate (mirrors connectionManager.guardCancelInFlight).
  let cancelInFlight = false;
  // Timestamp of the most recent user-initiated disconnect, in ms since
  // epoch. The 2s window is enforced by isUserDisconnectRecent() in the
  // caller, but we ALSO record it here so the watchdog can self-mute
  // even if the caller's gate is wrong.
  let lastUserDisconnectMs = 0;
  // Initial sync: pin to the current end-of-file so we never reconnect
  // on stale historical disconnects from before activation.
  const initial = findLatestLog(deps.sunshineLogDir);
  if (initial) {
    try {
      trackedLogPath = initial;
      trackedOffset = fs.statSync(initial).size;
    } catch {
      // I/O race at construction is non-fatal — the next tick will retry.
      trackedLogPath = null;
      trackedOffset = 0;
    }
  }

  const tick = (): void => {
    // Re-resolve the latest log every tick — Sunshine rotates daily.
    const currentLog = findLatestLog(deps.sunshineLogDir);
    if (!currentLog) { return; }
    if (currentLog !== trackedLogPath) {
      // Rotation: pin to the new file's current size so we only react to
      // events from this point on, never to history we've never scanned.
      trackedLogPath = currentLog;
      try { trackedOffset = fs.statSync(currentLog).size; } catch { trackedOffset = 0; }
      return;
    }
    let stat: fs.Stats;
    try { stat = fs.statSync(currentLog); } catch { return; }
    if (stat.size <= trackedOffset) { return; } // file shrank or no growth
    let newText = '';
    try {
      const fd = fs.openSync(currentLog, 'r');
      try {
        const length = stat.size - trackedOffset;
        const buf = Buffer.alloc(length);
        fs.readSync(fd, buf, 0, length, trackedOffset);
        newText = buf.toString('utf8');
      } finally {
        fs.closeSync(fd);
      }
    } catch {
      // Read failed mid-tick; advance offset so we don't re-scan the
      // same range next tick (Sunshine writes are append-only).
      trackedOffset = stat.size;
      return;
    }
    trackedOffset = stat.size;
    if (!RE_CLIENT_DISCONNECTED.test(newText)) { return; }
    // A disconnect happened in the new bytes. Gate every condition.
    if (!deps.isPanelOpen()) {
      deps.output.appendLine('[HealthWatchdog] disconnect seen but panel closed — ignoring');
      return;
    }
    const recentByCallback = deps.isUserDisconnectRecent();
    const recentByLocal = (Date.now() - lastUserDisconnectMs) < 2000;
    if (recentByCallback || recentByLocal) {
      deps.output.appendLine('[HealthWatchdog] disconnect was user-initiated within 2s — ignoring');
      return;
    }
    if (cancelInFlight) {
      deps.output.appendLine('[HealthWatchdog] reconnect already in flight — skipping');
      return;
    }
    if (Date.now() < startTime) {
      // Defensive: wall clock went backwards. Skip.
      return;
    }
    cancelInFlight = true;
    deps.output.appendLine('[HealthWatchdog] CLIENT DISCONNECTED detected — programmatic reconnect');
    deps.triggerReconnect()
      .catch((err) => {
        const msg = err instanceof Error ? err.message : String(err);
        deps.output.appendLine(`[HealthWatchdog] reconnect failed: ${msg}`);
      })
      .finally(() => {
        cancelInFlight = false;
      });
  };

  const unsubscribe = deps.subscribeTicks(tick);

  return {
    dispose: () => { unsubscribe(); },
    noteUserDisconnect: () => { lastUserDisconnectMs = Date.now(); },
  };
}
