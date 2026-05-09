import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import {
  COMMANDS,
  CONFIG_SECTION,
  STATUS_BAR_PRIORITY,
  RELAY_DEFAULT_PORT,
  SUNSHINE_LOG_DIR,
  HEARTBEAT_TIMEOUT_MS,
  HEARTBEAT_CHECK_INTERVAL_MS,
} from './constants';
import { ConnectionManager } from './connectionManager';
import { VirtualDisplayManager } from './virtualDisplayManager';
import { readLatencySnapshot, type LatencySnapshot, EMPTY_SNAPSHOT } from './sunshineLogReader';
import { startStreamHealthWatchdog, type StreamHealthHandle } from './streamHealthWatchdog';
import type { MooCaptureConfig, ConnectionState } from './types';

// ---------------------------------------------------------------------------
// Config helper
// ---------------------------------------------------------------------------

/**
 * Map our MooCaptureConfig values into the localStorage shape the relay
 * (moonlight-web-stream) reads when stream.html boots. Keys are documented
 * in .relay/package/static/default_settings.js. We only override the
 * latency-relevant subset; everything else falls through to relay defaults.
 *
 * codec mapping: VS Code config exposes 'h264' | 'hevc'; relay expects
 * 'h264' | 'h265' | 'av1' | 'auto'. 'hevc' becomes 'h265'.
 */
interface MlStreamSettings {
  bitrate: number;
  fps: number;
  videoSize: 'custom';
  videoSizeCustom: { width: number; height: number };
  videoCodec: 'h264' | 'h265';
  /**
   * Force the iframe's stream/index.js to skip WebRTC and use the
   * WebSocket transport directly. Required on localhost: Chromium
   * anonymises LAN host candidates as `*.local` mDNS names that the
   * Rust relay cannot resolve, so WebRTC ICE always times out and
   * falls back to WebSocket — but the relay's streamer.exe has
   * already started its 10s "no transport attached" timer by then,
   * so the fallback arrives after the streamer has self-terminated
   * and the whole stream fails. Forcing 'websocket' skips the wasted
   * WebRTC attempt entirely; the streamer sees SetTransport
   * immediately and stays alive.
   */
  dataTransport: 'auto' | 'webrtc' | 'websocket';
}

function buildMlSettings(cfg: MooCaptureConfig): MlStreamSettings {
  const match = /^(\d+)x(\d+)$/.exec(cfg.resolution);
  const width = match ? Number(match[1]) : 1920;
  const height = match ? Number(match[2]) : 1080;
  return {
    bitrate: cfg.bitrate,
    fps: cfg.fps,
    videoSize: 'custom',
    videoSizeCustom: { width, height },
    videoCodec: cfg.codec === 'hevc' ? 'h265' : 'h264',
    dataTransport: 'websocket',
  };
}

function getConfig(): MooCaptureConfig {
  const cfg = vscode.workspace.getConfiguration(CONFIG_SECTION);
  // Moonlight applies a "remote IPv4 streaming" 1024-byte MTU cap when the
  // resolved host is non-loopback. "localhost" can resolve via DNS to a
  // non-loopback interface on Windows, so always use the literal loopback IP.
  const rawHost = cfg.get<string>('sunshineHost', '127.0.0.1');
  const sunshineHost = (rawHost === 'localhost' || rawHost === '::1') ? '127.0.0.1' : rawHost;
  return {
    sunshineHost,
    sunshinePort: cfg.get<number>('sunshinePort', 47989),
    relayPort: cfg.get<number>('relayPort', RELAY_DEFAULT_PORT),
    resolution: cfg.get<string>('resolution', '1920x1080'),
    fps: cfg.get<number>('fps', 60),
    codec: cfg.get<'h264' | 'hevc'>('codec', 'h264'),
    bitrate: cfg.get<number>('bitrate', 20000),
    headlessMode: cfg.get<boolean>('headlessMode', true),
    virtualDisplayResolution: cfg.get<string>('virtualDisplayResolution', '1920x1080'),
  };
}

// ---------------------------------------------------------------------------
// Status bar labels
// ---------------------------------------------------------------------------

const STATE_LABELS: Record<ConnectionState, string> = {
  disconnected: '$(game) Moo Capture',
  downloading_relay: '$(sync~spin) Downloading Relay...',
  starting_relay: '$(sync~spin) Starting Relay...',
  pairing: '$(key) Pairing with Vibeshine...',
  setting_up_display: '$(sync~spin) Setting Up Display...',
  tearing_down_display: '$(sync~spin) Restoring Displays...',
  connecting_webrtc: '$(sync~spin) Connecting...',
  streaming: '$(circle-filled) Streaming',
  error: '$(error) Moo Capture: Error',
};

// ---------------------------------------------------------------------------
// Vibeshine credential helpers
// ---------------------------------------------------------------------------

const VIBESHINE_USERNAME_KEY = 'mooCaptureVscode.vibeshineUsername';
const VIBESHINE_PASSWORD_KEY = 'mooCaptureVscode.vibeshinePassword';

async function getVibeshineCredentials(
  secrets: vscode.SecretStorage,
): Promise<{ username: string; password: string } | null> {
  const username = await secrets.get(VIBESHINE_USERNAME_KEY);
  const password = await secrets.get(VIBESHINE_PASSWORD_KEY);
  if (username && password) {
    return { username, password };
  }
  return null;
}

async function promptAndStoreVibeshineCredentials(
  secrets: vscode.SecretStorage,
): Promise<{ username: string; password: string } | null> {
  const username = await vscode.window.showInputBox({
    prompt: 'Vibeshine REST API username',
    placeHolder: 'admin',
    value: 'admin',
  });
  if (!username) { return null; }

  const password = await vscode.window.showInputBox({
    prompt: 'Vibeshine REST API password',
    password: true,
  });
  if (!password) { return null; }

  await secrets.store(VIBESHINE_USERNAME_KEY, username);
  await secrets.store(VIBESHINE_PASSWORD_KEY, password);

  return { username, password };
}

// ---------------------------------------------------------------------------
// Crash recovery
// ---------------------------------------------------------------------------

function checkCrashRecovery(globalStoragePath: string, output: vscode.OutputChannel): void {
  const sentinelPath = path.join(globalStoragePath, 'headless-sentinel.json');
  if (!fs.existsSync(sentinelPath)) { return; }

  try {
    const raw = fs.readFileSync(sentinelPath, 'utf-8');
    const sentinel = JSON.parse(raw);
    const timestamp = new Date(sentinel.timestamp);
    const ageMs = Date.now() - timestamp.getTime();

    // Only auto-recover if sentinel is less than 6 hours old
    const maxAgeMs = 6 * 60 * 60 * 1000;
    if (ageMs > maxAgeMs) {
      output.appendLine(`[Recovery] Sentinel is ${Math.round(ageMs / 3600000)}h old — too old, removing.`);
      fs.unlinkSync(sentinelPath);
      return;
    }

    output.appendLine(`[Recovery] Found recent sentinel (${Math.round(ageMs / 60000)}min old). Running teardown...`);

    const teardownScript = sentinel.teardownScript;
    if (teardownScript && fs.existsSync(teardownScript)) {
      const { exec } = require('child_process');
      exec(
        `powershell.exe -NoProfile -ExecutionPolicy Bypass -File "${teardownScript}"`,
        { timeout: 30000 },
        (err: any, stdout: string, stderr: string) => {
          if (err) {
            output.appendLine(`[Recovery] Teardown failed: ${err.message}`);
          } else {
            output.appendLine(`[Recovery] Teardown complete: ${stdout.trim()}`);
          }
        },
      );
    } else {
      output.appendLine('[Recovery] Teardown script not found — removing stale sentinel.');
      fs.unlinkSync(sentinelPath);
    }
  } catch (err) {
    output.appendLine(`[Recovery] Failed to process sentinel: ${err}`);
    try { fs.unlinkSync(sentinelPath); } catch { /* ignore */ }
  }
}

// ---------------------------------------------------------------------------
// Pre-flight checks
// ---------------------------------------------------------------------------

/** Quick check if Vibeshine's NVHTTP port is responding. */
function checkVibeshineReachable(host: string, port: number, output: vscode.OutputChannel): Promise<boolean> {
  return new Promise((resolve) => {
    const http = require('http') as typeof import('http');
    const net = require('net') as typeof import('net');

    // Bypass VS Code/Cursor's proxy-patched http module by using a raw TCP socket
    output.appendLine(`[PreFlight] Checking ${host}:${port}...`);
    const socket = net.createConnection({ host, port }, () => {
      output.appendLine('[PreFlight] TCP connected — Vibeshine is reachable');
      socket.destroy();
      resolve(true);
    });
    socket.setTimeout(5000);
    socket.on('error', (err: Error) => {
      output.appendLine(`[PreFlight] Error: ${err.message}`);
      resolve(false);
    });
    socket.on('timeout', () => {
      output.appendLine('[PreFlight] Timeout after 5s');
      socket.destroy();
      resolve(false);
    });
  });
}

// ---------------------------------------------------------------------------
// Activation
// ---------------------------------------------------------------------------

export function activate(context: vscode.ExtensionContext): void {
  const output = vscode.window.createOutputChannel('Moo Capture');
  output.appendLine('Moo Capture: activate()');

  // Ensure globalStoragePath exists
  fs.mkdirSync(context.globalStorageUri.fsPath, { recursive: true });

  // Crash recovery: check for leftover sentinel file
  checkCrashRecovery(context.globalStorageUri.fsPath, output);

  const connManager = new ConnectionManager(output, context.globalStorageUri.fsPath);
  let panel: vscode.WebviewPanel | undefined;
  // Set during a known disconnect+reconnect transition (e.g. preset apply)
  // so the panel.onDidDispose handler skips its interactive Keep Relay /
  // Shut Down modal. Cleared by the path that set it.
  let programmaticReconnect = false;

  // Status bar
  const statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, STATUS_BAR_PRIORITY);
  statusBar.command = COMMANDS.connect;
  statusBar.text = STATE_LABELS.disconnected;
  statusBar.tooltip = 'Click to connect to Vibeshine';
  statusBar.show();
  context.subscriptions.push(statusBar);

  // Mute status-bar item — visible only while streaming. Click runs the
  // toggleMute command (same path as Ctrl+Shift+M and the floating toolbar
  // button) so all three controls share a single mute pipeline.
  const muteStatusBar = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Left,
    STATUS_BAR_PRIORITY - 1,
  );
  muteStatusBar.command = COMMANDS.toggleMute;
  muteStatusBar.text = '$(unmute)';
  muteStatusBar.tooltip = 'Stream audio (click to mute, Ctrl+Shift+M)';
  context.subscriptions.push(muteStatusBar);

  // Latency status-bar item — visible only while streaming. Sourced from
  // the same fs.watch driver used by the Show Stats panel (subscribeLatency
  // below). Click opens the full Stats webview.
  const latencyStatusBar = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Left,
    STATUS_BAR_PRIORITY - 2,
  );
  latencyStatusBar.command = COMMANDS.showStats;
  latencyStatusBar.text = '$(pulse) --/-- ms';
  latencyStatusBar.tooltip = 'Stream latency (click for Stats)';
  context.subscriptions.push(latencyStatusBar);
  // Subscription handle tied to the streaming session — populated when
  // entering streaming state, released when leaving.
  let latencyUnsub: (() => void) | null = null;

  // Stream health watchdog handle (PHASE THREE). Lifecycle mirrors
  // latencyUnsub: started on streaming-state, disposed on leaving it.
  // Reacts to spontaneous CLIENT DISCONNECTED events in the Sunshine log
  // by routing into fireReconnect, which prompts the user instead of
  // tearing down silently — see fireReconnect below.
  //
  // 0.1.4 design change: pre-0.1.4 the watchdog auto-cancelled and
  // auto-reconnected. That tore down the relay session (and any virtual
  // displays it owned) on every transient blip, and on cold-start
  // failures it locked the user out of the manual-retry path that often
  // succeeded on the second try. The watchdog now ALWAYS surfaces a
  // toast with [Reconnect]/[Disconnect] — the user is the rate limiter,
  // and virtual displays survive a dismissed prompt because we don't
  // touch the relay until they choose. The old circuit-breaker state
  // (reconnectTimestamps + RECONNECT_LIMIT/WINDOW_MS) is gone for the
  // same reason.
  let watchdogHandle: StreamHealthHandle | null = null;
  // Timestamp of the most recent INTENTIONAL disconnect — both user-
  // initiated (Disconnect command) and programmatic (tuneStream reconnect,
  // watchdog reconnect). Used to gate the watchdog from re-firing on the
  // CLIENT DISCONNECTED line that its OWN cancelStream produced.
  let lastIntentionalDisconnectMs = 0;
  // Shared in-flight gate for fireReconnect's reconnect path — prevents
  // a second reconnect cycle from starting while one is already running
  // (e.g. user clicks Reconnect twice in rapid succession).
  let reconnectInFlight = false;
  // Gate on the user-facing toast itself — prevents stacking duplicate
  // toasts when both the heartbeat checker and the Sunshine log watchdog
  // notice the same disconnect within the same window.
  let promptInFlight = false;

  // Iframe heartbeat tracking (PHASE FOUR). The injected moo-mute.js
  // posts {type:'moo-heartbeat'} every 2000ms; the parent records the
  // most recent receive time and a per-panel 1000ms checker fires
  // fireReconnect('heartbeat-timeout') when 5000ms has passed AND the
  // panel is visible AND at least one heartbeat has ever been received.
  //
  // Lifecycle invariants (iter 15 audit):
  //   - exactly one heartbeatChecker setInterval at a time (single slot)
  //   - re-creation always preceded by clearInterval (the if (!panel)
  //     block runs once per panel session, but the clearInterval is
  //     defensive against any future code path that recreates the
  //     panel without disposing first)
  //   - cleared via THREE paths: panel.onDidDispose,
  //     COMMANDS.disconnect (implicit via panel.dispose), and
  //     context.subscriptions on extension deactivate
  //   - hasReceivedFirstHeartbeat reset when starting a new checker
  //     so a cold-start iframe (slow first-heartbeat) cannot trigger
  //     a false-positive timeout reconnect
  //   - panel.visible gate prevents Chromium-throttled hidden iframes
  //     from triggering false positives
  //   - lastHeartbeatMs reset only on the Reconnect path so a dismissed
  //     prompt leaves session state intact
  //   - reconnectInFlight + promptInFlight gates in fireReconnect prevent
  //     duplicate toasts and concurrent reconnect cycles when both
  //     watchdog sources fire on the same disconnect
  // Tuning constants HEARTBEAT_TIMEOUT_MS / HEARTBEAT_CHECK_INTERVAL_MS
  // imported from constants.ts.
  //
  // hasEverStreamed (0.1.4) flips true on the SECOND heartbeat (~4s of
  // iframe liveness) — single first-heartbeat is too eager because the
  // iframe's setInterval can fire before the WebRTC peer attaches.
  // Used by fireReconnect to differentiate cold-start failure ("Stream
  // failed to start. Retry?") from mid-stream disconnect ("Stream
  // disconnected. Reconnect?"). Reset alongside hasReceivedFirstHeartbeat
  // when starting a new checker or completing a reconnect.
  let lastHeartbeatMs = Date.now();
  let hasReceivedFirstHeartbeat = false;
  let heartbeatCount = 0;
  let hasEverStreamed = false;
  let heartbeatChecker: NodeJS.Timeout | null = null;

  /**
   * Single disconnect-detected entry point. Both the log-watchdog
   * (PHASE THREE) and the heartbeat detector (PHASE FOUR) call this.
   *
   * 0.1.4 behavior: NEVER auto-reconnects. Surfaces a non-modal toast
   * with [Reconnect] / [Disconnect] and waits for the user. Rationale:
   *   - Auto-reconnect tears down the relay session, which kills any
   *     virtual displays Vibeshine owns. Every transient blip wiped
   *     and respawned the user's monitors.
   *   - On cold-start failures (which are intermittent — the iframe's
   *     WebRTC handshake races a hardcoded ~10s relay-side timeout
   *     and sometimes loses), auto-reconnect runs the same flaky
   *     sequence in a tight loop, locking the user out of the
   *     manual-retry path that historically worked on the second try.
   *
   * The toast wording differs based on hasEverStreamed:
   *   - false → "Stream failed to start. Retry?" (cold-start case)
   *   - true  → "Stream disconnected. Reconnect?" (mid-stream case)
   *
   * If the user dismisses the toast, the session is left untouched —
   * the status-bar still routes to COMMANDS.connect for manual retry.
   */
  async function fireReconnect(reason: string): Promise<void> {
    if (reconnectInFlight) {
      output.appendLine(`[Reconnect:${reason}] reconnect already in flight — skipping`);
      return;
    }
    if (promptInFlight) {
      output.appendLine(`[Reconnect:${reason}] prompt already shown — skipping duplicate`);
      return;
    }

    const message = hasEverStreamed
      ? `Moo Capture: stream disconnected (${reason}). Reconnect?`
      : `Moo Capture: stream failed to start (${reason}). Retry?`;

    // Update status bar so the user has a second route back to a
    // working stream even if they dismiss the toast.
    statusBar.text = STATE_LABELS.disconnected;
    statusBar.tooltip = 'Stream disconnected — click to reconnect';

    output.appendLine(`[Reconnect:${reason}] prompting user (hasEverStreamed=${hasEverStreamed})`);
    promptInFlight = true;
    try {
      const choice = await vscode.window.showInformationMessage(
        message,
        'Reconnect',
        'Disconnect',
      );

      if (choice === 'Reconnect') {
        reconnectInFlight = true;
        programmaticReconnect = true;
        try {
          await vscode.commands.executeCommand(COMMANDS.disconnect);
          // Snapshot the intent timestamp set by our own disconnect.
          // Any later update during the settle means a NEW intentional
          // disconnect happened — honour that intent and abort.
          const ownDisconnectMs = lastIntentionalDisconnectMs;
          await new Promise((r) => setTimeout(r, 1500));
          if (lastIntentionalDisconnectMs !== ownDisconnectMs) {
            output.appendLine(
              `[Reconnect:${reason}] aborted — intent changed during 1.5s settle`,
            );
            return;
          }
          await vscode.commands.executeCommand(COMMANDS.connect);
        } finally {
          programmaticReconnect = false;
          reconnectInFlight = false;
          // Reset heartbeat clock AND cold-start gates so the new
          // session has a fresh window AND can't trip the timeout
          // before the new iframe sends its first heartbeat.
          lastHeartbeatMs = Date.now();
          hasReceivedFirstHeartbeat = false;
          heartbeatCount = 0;
          hasEverStreamed = false;
        }
      } else if (choice === 'Disconnect') {
        output.appendLine(`[Reconnect:${reason}] user chose Disconnect`);
        await vscode.commands.executeCommand(COMMANDS.disconnect);
      } else {
        // Toast dismissed (X or timeout). Leave session as-is — virtual
        // displays survive, status bar already routes to manual reconnect.
        output.appendLine(`[Reconnect:${reason}] user dismissed prompt — leaving session as-is`);
      }
    } finally {
      promptInFlight = false;
    }
  }

  // Render the icon based on mute state. Updated by webview messages.
  let muteState: boolean | null = null;
  const renderMuteStatusBar = (): void => {
    if (muteState === null) {
      muteStatusBar.text = '$(unmute)';
      muteStatusBar.tooltip = 'Stream audio (click to mute, Ctrl+Shift+M)';
    } else if (muteState) {
      muteStatusBar.text = '$(mute)';
      muteStatusBar.tooltip = 'Stream muted (click to unmute, Ctrl+Shift+M)';
    } else {
      muteStatusBar.text = '$(unmute)';
      muteStatusBar.tooltip = 'Stream audio (click to mute, Ctrl+Shift+M)';
    }
  };
  renderMuteStatusBar();
  // Expose the setter on the manager so other code can sync state without
  // closing over module-private symbols. Keeps lifecycle coupled to connect.
  connManager.setMuteStateRenderer((next) => {
    muteState = next;
    renderMuteStatusBar();
  });

  connManager.onState((state: ConnectionState, message?: string) => {
    statusBar.text = STATE_LABELS[state];
    if (message) {
      statusBar.tooltip = message;
    }
    if (state === 'streaming') {
      muteStatusBar.show();
      // Subscribe to the latency monitor only while streaming. Watcher is
      // reference-counted; this is the only consumer when no Stats panel
      // is open. Single-slot guard prevents double-subscribing on any
      // future onState re-entry.
      if (!latencyUnsub) {
        latencyUnsub = subscribeLatency((snap) => {
          const enc = snap.frameProcessingMs && typeof snap.frameProcessingMs.avg === 'number'
            ? snap.frameProcessingMs.avg.toFixed(1)
            : '--';
          const net = snap.networkMs && typeof snap.networkMs.avg === 'number'
            ? snap.networkMs.avg.toFixed(1)
            : '--';
          latencyStatusBar.text = `$(pulse) ${enc}/${net} ms`;
          latencyStatusBar.tooltip = `Encode ${enc} ms / Network ${net} ms (click for full Stats)`;
        });
      }
      // Start the stream health watchdog. Single-slot guard mirrors
      // latencyUnsub above so re-entry into 'streaming' (e.g. transient
      // state churn) cannot spawn a second watchdog.
      if (!watchdogHandle) {
        watchdogHandle = startStreamHealthWatchdog({
          sunshineLogDir: SUNSHINE_LOG_DIR,
          output,
          isPanelOpen: () => panel !== undefined,
          isUserDisconnectRecent: () =>
            (Date.now() - lastIntentionalDisconnectMs) < 2000,
          triggerReconnect: () => fireReconnect('log-watchdog'),
          subscribeTicks,
        });
      }
      latencyStatusBar.show();
    } else {
      muteStatusBar.hide();
      // Reset for next session so the icon does not flash a stale state.
      muteState = null;
      renderMuteStatusBar();
      // Drop the latency subscription so the watcher can stop if no Stats
      // panel is also subscribed.
      if (latencyUnsub) { latencyUnsub(); latencyUnsub = null; }
      // Dispose the watchdog when leaving streaming. Same single-slot
      // pattern as latencyUnsub — disposed instance is dropped to null
      // so a future re-entry into 'streaming' constructs a fresh one.
      if (watchdogHandle) { watchdogHandle.dispose(); watchdogHandle = null; }
      latencyStatusBar.text = '$(pulse) --/-- ms';
      latencyStatusBar.hide();
    }
  });

  // Connect command
  let connectInProgress = false;
  context.subscriptions.push(
    vscode.commands.registerCommand(COMMANDS.connect, async () => {
      // Guard: prevent CONCURRENT connect flows (real in-flight only).
      //
      // 0.1.5: dropped the `currentState !== 'disconnected'` check.
      // The iframe can fail (e.g. WebRTC ICE timeout) WITHOUT throwing
      // in connManager.connect() — the connect-side promise resolved
      // successfully with port/hostId/apps, then the iframe died on
      // its own. State stays at 'streaming' from the extension's
      // perspective even though no frames are flowing. The old guard
      // refused EVERY subsequent retry as "duplicate connect request",
      // locking the user out of recovery without reloading Cursor.
      // Now we only block on a genuine in-flight connect.
      if (connectInProgress) {
        output.appendLine('[Connect] Ignoring duplicate connect request (in-flight).');
        return;
      }
      // If state is anything other than 'disconnected', force a quick
      // teardown first so we start from a clean slate. disconnect() is
      // synchronous and idempotent — safe to call from any state.
      if (connManager.currentState !== 'disconnected') {
        output.appendLine(`[Connect] Forcing teardown from stuck state '${connManager.currentState}' before reconnect`);
        connManager.disconnect();
      }
      connectInProgress = true;

      const config = getConfig();

      // Pre-flight: check if Vibeshine is reachable
      const vibeshineOk = await checkVibeshineReachable(config.sunshineHost, config.sunshinePort, output);
      if (!vibeshineOk) {
        const action = await vscode.window.showErrorMessage(
          'Vibeshine is not responding. Is the Vibeshine Service running?',
          'Retry',
          'Open Vibeshine Web UI',
        );
        if (action === 'Retry') {
          await vscode.commands.executeCommand(COMMANDS.connect);
        } else if (action === 'Open Vibeshine Web UI') {
          vscode.env.openExternal(vscode.Uri.parse('https://localhost:47990'));
        }
        return;
      }

      // If headless mode, get Vibeshine credentials for REST API.
      // Vibeshine manages the virtual display via its built-in SudoVDA driver —
      // no external VDD installation check needed.
      if (config.headlessMode) {
        {
          let creds = await getVibeshineCredentials(context.secrets);
          if (!creds) {
            creds = await promptAndStoreVibeshineCredentials(context.secrets);
          }
          if (creds) {
            connManager.vibeshineUsername = creds.username;
            connManager.vibeshinePassword = creds.password;
          } else {
            output.appendLine('[Connect] No Vibeshine credentials — headless prep-cmd will not be auto-configured.');
          }
        }
      }

      // Create panel if it doesn't exist
      if (!panel) {
        panel = vscode.window.createWebviewPanel(
          'mooCaptureStream',
          'Moo Capture',
          vscode.ViewColumn.One,
          {
            enableScripts: true,
            retainContextWhenHidden: true,
          },
        );

        // Capture the Disposable so the listener is also tied to the
        // extension lifetime. Auto-cleaned with panel.dispose(), but pushing
        // to context.subscriptions prevents subtle leaks if the panel
        // reference is ever lost without dispose firing.
        context.subscriptions.push(
          panel.onDidDispose(async () => {
            // CRITICAL: dispose synchronously BEFORE awaiting the modal.
            // The 2026-05-09 16:27 collision was caused by Cursor reload
            // tearing down the extension host while this handler was
            // suspended at the await below — disconnect() was reached
            // only on interactive close, never on reload. Moving the
            // call here guarantees the cancelStream HTTP is dispatched
            // the moment the panel disappears, regardless of whether
            // the modal ever resolves.
            lastIntentionalDisconnectMs = Date.now();
            watchdogHandle?.noteUserDisconnect();
            // Stop the heartbeat checker — the iframe is gone.
            if (heartbeatChecker) { clearInterval(heartbeatChecker); heartbeatChecker = null; }
            connManager.disconnect();

            // Programmatic reconnect: skip the user-facing modal — we're
            // tearing the panel down deliberately to apply new settings.
            // The triggering path (e.g. tuneStream) is responsible for
            // creating a new panel via the connect command.
            if (programmaticReconnect) {
              statusBar.text = STATE_LABELS.disconnected;
              statusBar.tooltip = 'Reconnecting with new settings...';
              panel = undefined;
              return;
            }
            // Modal collapsed from 3 options to 2 since the stream is
            // always cancelled above. The only meaningful question is
            // whether to also stop the relay binary for a cold restart.
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
              // Keep Relay (or dismissed) — stream already cancelled above.
              statusBar.text = '$(game) Moo Capture (Ready)';
              statusBar.tooltip = 'Relay running. Click to reconnect instantly.';
            }
            panel = undefined;
          }),
        );

        // Show loading state while relay starts up
        panel.webview.html = getLoadingHtml();

        // Heartbeat checker — fires fireReconnect if 5000ms elapses
        // without a moo-heartbeat from the iframe AND the panel is
        // visible AND at least one heartbeat has ever been received.
        // Hidden panels expect Chromium to throttle the setInterval
        // inside the iframe, so we deliberately do NOT act on missed
        // heartbeats while hidden. Cold-start iframes can take a few
        // seconds to load and start posting; the
        // hasReceivedFirstHeartbeat gate suppresses false positives
        // during that window. Cleared in panel.onDidDispose AND
        // registered with context.subscriptions for deactivate.
        lastHeartbeatMs = Date.now();
        hasReceivedFirstHeartbeat = false;
        heartbeatCount = 0;
        hasEverStreamed = false;
        if (heartbeatChecker) { clearInterval(heartbeatChecker); }
        heartbeatChecker = setInterval(() => {
          if (!panel || !panel.visible) { return; }
          if (!hasReceivedFirstHeartbeat) { return; }
          if (Date.now() - lastHeartbeatMs > HEARTBEAT_TIMEOUT_MS) {
            // Reset clock so we don't fire-and-fire while reconnect
            // is in flight (fireReconnect's reconnectInFlight gate
            // handles that too, but resetting here avoids log spam).
            lastHeartbeatMs = Date.now();
            output.appendLine(
              `[Heartbeat] no iframe heartbeat for ${HEARTBEAT_TIMEOUT_MS}ms while panel visible`,
            );
            void fireReconnect('heartbeat-timeout');
          }
        }, HEARTBEAT_CHECK_INTERVAL_MS);
      } else {
        panel.reveal(vscode.ViewColumn.One);
      }

      try {
        const { port, hostId, apps } = await connManager.connect(config, (pin: string) => {
          vscode.window.showInformationMessage(
            `Enter PIN ${pin} in Vibeshine to pair.`,
            { modal: true },
            'Open Vibeshine',
            'Done',
          ).then((choice) => {
            if (choice === 'Open Vibeshine') {
              vscode.env.openExternal(vscode.Uri.parse('https://localhost:47990/#/clients'));
            }
          });
        });

        if (!panel) {
          output.appendLine('[Connect] Panel was closed during connection. Aborting.');
          return;
        }

        if (apps.length === 0) {
          panel.webview.html = getErrorHtml('No apps found in Vibeshine. Add apps at https://localhost:47990/applications');
          return;
        }

        // Show the app launcher overlay inside the stream webview
        output.appendLine(`[Connect] ${apps.length} app(s) available. Showing in-stream launcher.`);
        panel.webview.html = getWebviewContent('', port, hostId, apps);

        // Listen for app selection and mute-state updates from the webview.
        // Captured Disposable goes to context.subscriptions so the listener
        // is freed at extension deactivate even if the panel disposal is
        // missed for any reason.
        context.subscriptions.push(
          panel.webview.onDidReceiveMessage((msg: { command?: string; type?: string; appId?: number; appName?: string; muted?: boolean }) => {
            if (msg.command === 'launchApp' && msg.appId !== undefined) {
              const mlSettings = buildMlSettings(getConfig());
              // 0.1.6: encode mlSettings as a base64-JSON query param so
              // the iframe loads stream.html DIRECTLY — no bootstrap →
              // load → redirect dance. moo-mute.js (already loaded in
              // stream.html's <head> before stream.js parses) decodes
              // the param and seeds localStorage.mlSettings for the
              // relay's getLocalStreamSettings(). Saves ~600-900ms of
              // cold-start vs the previous two-iframe-load pattern.
              const settingsParam = Buffer.from(JSON.stringify(mlSettings)).toString('base64');
              const streamUrl = `http://127.0.0.1:${port}/stream.html?hostId=${hostId}&appId=${msg.appId}&mlSettings=${encodeURIComponent(settingsParam)}`;
              output.appendLine(`[Connect] Launching ${msg.appName} settings=${JSON.stringify(mlSettings)}`);
              if (panel) {
                panel.webview.html = getWebviewContent(streamUrl, port, hostId, apps, mlSettings);
              }
            } else if (msg.type === 'moo-mute' && typeof msg.muted === 'boolean') {
              connManager.notifyMuteState(msg.muted);
            } else if (msg.type === 'moo-heartbeat') {
              lastHeartbeatMs = Date.now();
              hasReceivedFirstHeartbeat = true;
              heartbeatCount++;
              // After the second heartbeat (~4s of iframe liveness) we
              // treat the stream as having actually started — strongly
              // implies the WebRTC peer attached and frames are flowing.
              // Used by fireReconnect to distinguish cold-start failure
              // from mid-stream disconnect.
              if (heartbeatCount >= 2) { hasEverStreamed = true; }
            }
          }),
        );
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        output.appendLine(`[Connect] Failed: ${msg}`);
        if (panel) {
          panel.webview.html = getErrorHtml(msg);
        }
      } finally {
        connectInProgress = false;
      }
    }),
  );

  // Disconnect command (stops stream, keeps relay for quick reconnect)
  context.subscriptions.push(
    vscode.commands.registerCommand(COMMANDS.disconnect, () => {
      // Record intent timestamp BEFORE disconnect so the watchdog's
      // 2-second gate reliably suppresses the CLIENT DISCONNECTED line
      // that this disconnect itself produces. Both user clicks AND
      // programmatic reconnects (tuneStream, watchdog) flow through here.
      lastIntentionalDisconnectMs = Date.now();
      watchdogHandle?.noteUserDisconnect();
      connManager.disconnect();
      if (panel) {
        panel.dispose();
        panel = undefined;
      }
      statusBar.text = '$(game) Moo Capture (Ready)';
      statusBar.tooltip = 'Stream stopped. Relay still running for quick reconnect.';
    }),
  );

  // Shutdown command (stops everything — relay, stream, cleanup)
  context.subscriptions.push(
    vscode.commands.registerCommand(COMMANDS.shutdown, async () => {
      const choice = await vscode.window.showWarningMessage(
        'Shut down Moo Capture? The virtual display can be kept for quick reconnect or removed.',
        { modal: true },
        'Shutdown (Keep Display)',
        'Shutdown & Remove Display',
      );
      if (!choice) { return; }

      // 0.1.7: graceful path awaits cancelStream + 500ms settle BEFORE
      // killing the relay so Sunshine actually receives the cancel. The
      // old `connManager.dispose()` was sync and killed the relay
      // mid-flight, leaving an orphan session that collided with the
      // next connect (`[active sessions: 2]` → 555ms disconnect).
      await connManager.gracefulDispose();
      if (panel) {
        panel.dispose();
        panel = undefined;
      }

      if (choice === 'Shutdown & Remove Display') {
        const vdm = new VirtualDisplayManager(output);
        try {
          const installed = await vdm.isVddInstalled();
          if (installed) {
            output.appendLine('[Shutdown] Disabling virtual display device...');
            await vdm.disableVdd();
            output.appendLine('[Shutdown] Virtual display removed.');
          }
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          output.appendLine(`[Shutdown] Failed to remove virtual display: ${msg}`);
          vscode.window.showWarningMessage(
            `Virtual display could not be removed: ${msg}. You may need to disable it manually in Device Manager.`,
          );
        }
      }

      statusBar.text = STATE_LABELS.disconnected;
      statusBar.tooltip = 'Click to connect to Vibeshine';
      vscode.window.showInformationMessage(
        choice === 'Shutdown & Remove Display'
          ? 'Moo Capture shut down. Relay stopped and virtual display removed.'
          : 'Moo Capture shut down. Relay stopped. Virtual display kept for quick reconnect.',
      );
    }),
  );

  // Toggle Mute command — keybinding ctrl+shift+m. Forwards to the active
  // panel which delegates to the existing mute button click handler so the
  // actual mute logic lives in one place.
  context.subscriptions.push(
    vscode.commands.registerCommand(COMMANDS.toggleMute, () => {
      if (!panel) {
        vscode.window.showInformationMessage('Moo Capture: connect first to control stream audio.');
        return;
      }
      panel.webview.postMessage({ type: 'moo-toggle-mute' });
    }),
  );

  // ---------------------------------------------------------------------------
  // Latency monitor — shared fs.watch driver
  //
  // Iter 1 (Stats panel) and iter 2 (status-bar item) both subscribe via
  // subscribeLatency. Iter 3 audited the lifecycle and documents the
  // invariants here. Iter 8 added a parallel `tickSubs` channel for
  // consumers that need to react to log-file changes without parsing a
  // snapshot (StreamHealthWatchdog uses it for incremental tail reads).
  //
  // Invariants (must hold across all paths):
  //   - exactly one fs.FSWatcher exists at a time, on `latencyWatcher`
  //   - exactly one debounce setTimeout exists at a time, on `latencyDebounce`
  //   - `stopLatencyWatching` is idempotent and closes both
  //   - `ensureLatencyWatching` returns early if a watcher exists, never
  //     accumulates
  //   - `latencySubs` and `tickSubs` are the only fanout targets; entries
  //     are cleared on unsubscribe
  //   - watcher is closed via TWO dispose paths: last-unsubscribe and
  //     extension deactivate; both call stopLatencyWatching which is safe
  //     to call repeatedly
  //   - watcher stays alive while EITHER set is non-empty; closes only
  //     when both reach zero (last-unsubscribe path)
  //   - log file is read-only; the watcher cannot trigger a write that
  //     re-fires itself
  //   - fanOutLatency snapshots both subscriber Sets before iterating so a
  //     callback that unsubscribes during fanout does not desync iteration
  // ---------------------------------------------------------------------------
  type LatencySub = (snapshot: LatencySnapshot) => void;
  type TickSub = () => void;
  const latencySubs = new Set<LatencySub>();
  const tickSubs = new Set<TickSub>();
  let latencyWatcher: fs.FSWatcher | null = null;
  let latencyDebounce: NodeJS.Timeout | null = null;
  let lastLatencySnapshot: LatencySnapshot = EMPTY_SNAPSHOT;

  function fanOutLatency(): void {
    lastLatencySnapshot = readLatencySnapshot(SUNSHINE_LOG_DIR);
    // Snapshot subscribers before iterating: a callback that unsubscribes
    // during fanout (e.g., disconnect during a status-bar update) must not
    // desync iteration.
    const subs = Array.from(latencySubs);
    for (const sub of subs) {
      try { sub(lastLatencySnapshot); } catch { /* never let a bad sub break others */ }
    }
    // Same snapshot-then-iterate pattern for the tick channel. Tick
    // callbacks have no payload — they're a "log changed, go look" pulse.
    const ticks = Array.from(tickSubs);
    for (const tick of ticks) {
      try { tick(); } catch { /* never let a bad sub break others */ }
    }
  }

  function ensureLatencyWatching(): void {
    if (latencyWatcher) { return; }
    if (!fs.existsSync(SUNSHINE_LOG_DIR)) {
      // No logs dir yet — emit one snapshot so subscribers see the empty
      // state, but skip the watcher (fs.watch on a missing path throws).
      fanOutLatency();
      return;
    }
    try {
      latencyWatcher = fs.watch(SUNSHINE_LOG_DIR, { persistent: false }, (_event, filename) => {
        // Filter to sunshine-*.log writes only; ignore unrelated activity.
        if (filename && !/^sunshine-.*\.log$/i.test(String(filename))) { return; }
        // Debounce: each event clears the prior timer and sets a fresh
        // one. Single slot — never accumulates.
        if (latencyDebounce) { clearTimeout(latencyDebounce); }
        latencyDebounce = setTimeout(() => {
          latencyDebounce = null;
          fanOutLatency();
        }, 500);
      });
      latencyWatcher.on('error', (err) => {
        output.appendLine(`[LatencyMonitor] watcher error (non-fatal): ${err.message}`);
      });
      // Initial snapshot so subscribers don't sit blank waiting for the
      // next 20s log tick.
      fanOutLatency();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      output.appendLine(`[LatencyMonitor] could not start watcher: ${msg}`);
      // Still fan out a single snapshot so subscribers can render an
      // error state.
      fanOutLatency();
    }
  }

  function stopLatencyWatching(): void {
    if (latencyDebounce) { clearTimeout(latencyDebounce); latencyDebounce = null; }
    if (latencyWatcher) {
      try { latencyWatcher.close(); } catch { /* ignore */ }
      latencyWatcher = null;
    }
  }

  function subscribeLatency(cb: LatencySub): () => void {
    latencySubs.add(cb);
    ensureLatencyWatching();
    // Push the most recent snapshot to the new subscriber immediately so
    // the UI shows something on open instead of waiting for the next
    // 20-second log tick.
    try { cb(lastLatencySnapshot); } catch { /* ignore */ }
    return () => {
      latencySubs.delete(cb);
      if (latencySubs.size === 0 && tickSubs.size === 0) { stopLatencyWatching(); }
    };
  }

  /**
   * Subscribe to log-file change pulses without parsing a latency snapshot.
   * Used by StreamHealthWatchdog to drive its incremental tail reads.
   * Watcher is shared with subscribeLatency — only stopped when BOTH sets
   * reach zero subscribers.
   */
  function subscribeTicks(cb: TickSub): () => void {
    tickSubs.add(cb);
    ensureLatencyWatching();
    return () => {
      tickSubs.delete(cb);
      if (latencySubs.size === 0 && tickSubs.size === 0) { stopLatencyWatching(); }
    };
  }

  // Ensure the watcher is closed at extension deactivate even if all
  // subscribers somehow leaked. Also drop the status-bar latency
  // subscription explicitly — it lives in an activate-scope closure
  // (latencyUnsub) so registering its release here makes the intent
  // explicit and survives any future refactor that breaks the watcher
  // teardown chain.
  context.subscriptions.push({ dispose: stopLatencyWatching });
  context.subscriptions.push({
    dispose: () => {
      if (latencyUnsub) { latencyUnsub(); latencyUnsub = null; }
    },
  });
  // Stream health watchdog teardown — same explicit-cleanup pattern as
  // latencyUnsub. Defends against a refactor that breaks the
  // onState('disconnected') dispose path.
  context.subscriptions.push({
    dispose: () => {
      if (watchdogHandle) { watchdogHandle.dispose(); watchdogHandle = null; }
    },
  });
  // Heartbeat checker teardown — fires at extension deactivate even if
  // panel.onDidDispose was missed for any reason. Mirrors the
  // watchdog teardown pattern above.
  context.subscriptions.push({
    dispose: () => {
      if (heartbeatChecker) { clearInterval(heartbeatChecker); heartbeatChecker = null; }
    },
  });

  // Open Settings command — opens VS Code settings filtered to this
  // extension's CONFIG_SECTION so all knobs are visible together.
  context.subscriptions.push(
    vscode.commands.registerCommand(COMMANDS.openSettings, () => {
      vscode.commands.executeCommand('workbench.action.openSettings', `@ext:MooKeyboardAI.moo-capture`);
    }),
  );

  // Tune Stream — quick-pick preset selector for the latency-relevant
  // settings. Esports = aggressive low latency (Tekken, FPS), Game =
  // balanced (action / RPG), Video = quality (watching), Custom = settings.
  //
  // Recursion / re-fire audit (iter 9): tuneStream cannot re-enter itself.
  // The selection path is settings update -> optional reconnect modal ->
  // optional disconnect command. None of those re-invoke tuneStream.
  // tuneStreamBusy is a UX guard against rapid double-invocation racing
  // two quick-picks.
  let tuneStreamBusy = false;
  context.subscriptions.push(
    vscode.commands.registerCommand(COMMANDS.tuneStream, async () => {
      if (tuneStreamBusy) { return; }
      tuneStreamBusy = true;
      try {
      type PresetId = 'esports' | 'game' | 'video' | 'custom';
      interface Preset extends vscode.QuickPickItem {
        id: PresetId;
      }
      const items: Preset[] = [
        {
          id: 'esports',
          label: '$(zap) Esports Mode',
          description: 'h264 / 120 fps / 15000 Kbps / 1280x720',
          detail: 'Aggressive low latency. Tekken, fighters, FPS, rhythm games.',
        },
        {
          id: 'game',
          label: '$(rocket) Game Mode',
          description: 'h264 / 60 fps / 30000 Kbps / 1920x1080',
          detail: 'Balanced. Action games, single-player, RPGs.',
        },
        {
          id: 'video',
          label: '$(device-camera-video) Video Mode',
          description: 'hevc / 60 fps / 25000 Kbps / 2560x1440',
          detail: 'Highest fidelity. Watching streams, video, desktop content.',
        },
        {
          id: 'custom',
          label: '$(settings-gear) Custom',
          description: 'Open the full settings UI',
        },
      ];
      const choice = await vscode.window.showQuickPick(items, {
        placeHolder: 'Select a streaming preset',
        ignoreFocusOut: false,
      });
      if (!choice) { return; }
      if (choice.id === 'custom') {
        await vscode.commands.executeCommand(COMMANDS.openSettings);
        return;
      }
      const cfg = vscode.workspace.getConfiguration(CONFIG_SECTION);
      const target = vscode.ConfigurationTarget.Global;
      if (choice.id === 'esports') {
        await cfg.update('codec', 'h264', target);
        await cfg.update('fps', 120, target);
        await cfg.update('bitrate', 15000, target);
        await cfg.update('resolution', '1280x720', target);
      } else if (choice.id === 'game') {
        await cfg.update('codec', 'h264', target);
        await cfg.update('fps', 60, target);
        await cfg.update('bitrate', 30000, target);
        await cfg.update('resolution', '1920x1080', target);
      } else if (choice.id === 'video') {
        await cfg.update('codec', 'hevc', target);
        await cfg.update('fps', 60, target);
        await cfg.update('bitrate', 25000, target);
        await cfg.update('resolution', '2560x1440', target);
      }
      const presetName = choice.label.replace(/^\$\([^)]+\)\s*/, '');

      // If currently streaming, the preset values only land on the next
      // connect. Click on Reconnect IS consent — bypass the panel-dispose
      // modal via programmaticReconnect, then re-run connect to land on
      // the launcher with the new settings applied. User picks the app
      // again from the launcher (one click, no second modal).
      if (connManager.currentState === 'streaming') {
        const action = await vscode.window.showWarningMessage(
          `Moo Capture: ${presetName} preset saved. Reconnect now to apply?`,
          { modal: true },
          'Reconnect',
          'Later',
        );
        if (action === 'Reconnect') {
          programmaticReconnect = true;
          try {
            await vscode.commands.executeCommand(COMMANDS.disconnect);
            // Brief settle so the relay tears down the prior session
            // before connect reads /api/hosts. Without it, the SSE guard
            // can briefly observe sessions=1 from the dying session.
            await new Promise((r) => setTimeout(r, 300));
            await vscode.commands.executeCommand(COMMANDS.connect);
          } finally {
            programmaticReconnect = false;
          }
        }
        return;
      }

      vscode.window.showInformationMessage(
        `Moo Capture: ${presetName} preset saved. Connect to apply.`,
      );
      } finally {
        tuneStreamBusy = false;
      }
    }),
  );

  // Show Latency Stats command — opens a singleton webview that subscribes
  // to the latency monitor.
  //
  // Memory hygiene (iter 8 audit): per-panel cleanup state is held in a
  // single slot `statsCleanup`. Each new panel disposes the prior slot's
  // listener-disposable before installing a new one, so context.subscriptions
  // does not accumulate idle entries across open/close cycles. The panel
  // itself, the latency subscription, and the onDidDispose handler are all
  // tied to this slot.
  let statsPanel: vscode.WebviewPanel | undefined;
  let statsCleanup: vscode.Disposable | null = null;
  context.subscriptions.push({
    dispose: () => {
      if (statsCleanup) { statsCleanup.dispose(); statsCleanup = null; }
    },
  });
  context.subscriptions.push(
    vscode.commands.registerCommand(COMMANDS.showStats, () => {
      if (statsPanel) {
        statsPanel.reveal(vscode.ViewColumn.Beside);
        return;
      }
      // Defensive: drop any prior cleanup before creating a new panel.
      if (statsCleanup) { statsCleanup.dispose(); statsCleanup = null; }

      statsPanel = vscode.window.createWebviewPanel(
        'mooCaptureStats',
        'Moo Capture Stats',
        vscode.ViewColumn.Beside,
        { enableScripts: true, retainContextWhenHidden: true },
      );
      statsPanel.webview.html = getStatsHtml();
      const unsubscribe = subscribeLatency((snap) => {
        if (!statsPanel) { return; }
        statsPanel.webview.postMessage({ type: 'moo-stats-update', snap });
      });
      statsCleanup = statsPanel.onDidDispose(() => {
        unsubscribe();
        statsPanel = undefined;
        statsCleanup = null;
      });
    }),
  );

  // Setup Virtual Display command
  context.subscriptions.push(
    vscode.commands.registerCommand('moo-capture.setupVirtualDisplay', async () => {
      const vdm = new VirtualDisplayManager(output);

      // Check if already installed
      const alreadyInstalled = await vdm.isVddInstalled();
      if (alreadyInstalled) {
        vscode.window.showInformationMessage('Virtual Display Driver is already installed.');
        return;
      }

      // Download and install with progress
      await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: 'Moo Capture: Setting up Virtual Display',
          cancellable: false,
        },
        async (progress) => {
          try {
            progress.report({ message: 'Downloading VDD installer...' });
            const installerPath = await vdm.downloadVddInstaller(
              context.globalStorageUri.fsPath,
              (msg) => progress.report({ message: msg }),
            );

            progress.report({ message: 'Running installer (UAC prompt expected)...' });
            await vdm.installVdd(installerPath);

            progress.report({ message: 'Verifying installation...' });
            const verified = await vdm.verifyVddInstalled();

            if (verified) {
              vscode.window.showInformationMessage('Virtual Display Driver installed successfully.');
            } else {
              vscode.window.showWarningMessage(
                'VDD installer ran but the device was not detected. You may need to restart your PC.',
              );
            }
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            output.appendLine(`[VDD Setup] Error: ${msg}`);
            vscode.window.showErrorMessage(`Failed to set up Virtual Display Driver: ${msg}`);
          }
        },
      );
    }),
  );

  context.subscriptions.push({ dispose: () => connManager.dispose() });
}

export function deactivate(): void {
  // ConnectionManager.dispose() called via subscription
}

// ---------------------------------------------------------------------------
// Webview HTML — iframe pointing to relay web UI
// ---------------------------------------------------------------------------

function getWebviewContent(
  streamUrl: string,
  port?: number,
  hostId?: number,
  apps?: Array<{ id: number; name: string }>,
  mlSettings?: MlStreamSettings,
): string {
  const appsJson = JSON.stringify(apps || []).replace(/</g, '\\u003c');
  const mlSettingsJson = JSON.stringify(mlSettings ?? null).replace(/</g, '\\u003c');
  const isStreaming = streamUrl !== '';
  // 0.1.6: single-phase load. mlSettings is encoded in streamUrl's
  // ?mlSettings= query param; moo-mute.js (loaded in stream.html's
  // <head> before stream.js parses) decodes it and seeds
  // localStorage.mlSettings before getLocalStreamSettings() runs.
  // Replaces the previous bootstrap → load → redirect pattern that
  // loaded /index.html first only to get same-origin localStorage write
  // access. Saves ~600-900ms of cold-start.
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="default-src http://127.0.0.1:* 'unsafe-inline' blob:; frame-src http://127.0.0.1:*; script-src 'unsafe-inline' 'wasm-unsafe-eval' http://127.0.0.1:* blob:; worker-src http://127.0.0.1:* blob:; style-src 'unsafe-inline' http://127.0.0.1:*; connect-src ws://127.0.0.1:* http://127.0.0.1:*; media-src blob: mediastream: *; img-src http://127.0.0.1:* blob: data:;">
  <style>
    html, body {
      margin: 0;
      padding: 0;
      width: 100%;
      height: 100%;
      overflow: hidden;
      background: #1e1e2e;
      font-family: system-ui, -apple-system, sans-serif;
      color: #cdd6f4;
    }
    iframe {
      width: 100%;
      height: 100%;
      border: none;
    }
    iframe.view-only {
      pointer-events: none;
    }
    #exit-overlay {
      display: flex;
      align-items: center;
      justify-content: center;
      position: fixed;
      inset: 0;
      background: #1e1e2e;
      z-index: 10;
    }
    #exit-overlay.hidden { display: none; }

    /* Toolbar — visible on load, on pointer movement, and while .visible class is set.
       Once the iframe takes pointer focus, body:hover stops firing reliably,
       so we drive visibility from JS pointer events on the panel. */
    #toolbar {
      position: fixed;
      top: 8px;
      right: 8px;
      z-index: 20;
      display: flex;
      gap: 6px;
      opacity: 0;
      transition: opacity 0.2s;
      pointer-events: none;
    }
    body:hover #toolbar,
    #toolbar.visible {
      opacity: 1;
      pointer-events: auto;
    }
    .tb-btn {
      background: rgba(30,30,46,0.9);
      color: #cdd6f4;
      border: 1px solid #45475a;
      border-radius: 6px;
      padding: 6px 12px;
      font: 12px system-ui, sans-serif;
      cursor: pointer;
    }
    .tb-btn:hover { background: rgba(69,71,90,0.95); }
    .tb-btn.active { border-color: #f9e2af; color: #f9e2af; }

    /* App launcher */
    #app-launcher {
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      height: 100%;
      gap: 16px;
    }
    #app-launcher h2 { margin: 0 0 8px; font-weight: 500; }
    #app-launcher p { color: #a6adc8; margin: 0 0 24px; font-size: 0.9em; }
    .app-grid {
      display: flex;
      flex-wrap: wrap;
      gap: 12px;
      justify-content: center;
      max-width: 600px;
    }
    .app-card {
      background: #313244;
      border: 1px solid #45475a;
      border-radius: 10px;
      padding: 20px 28px;
      cursor: pointer;
      transition: all 0.15s;
      text-align: center;
      min-width: 120px;
    }
    .app-card:hover {
      background: #45475a;
      border-color: #89b4fa;
      transform: translateY(-2px);
    }
    .app-card .app-name { font-size: 14px; font-weight: 500; }

    /* App picker dropdown (when streaming) */
    #app-picker {
      display: none;
      position: fixed;
      top: 40px;
      right: 8px;
      z-index: 25;
      background: rgba(30,30,46,0.95);
      border: 1px solid #45475a;
      border-radius: 8px;
      padding: 4px;
      min-width: 160px;
    }
    #app-picker.open { display: block; }
    .picker-item {
      display: block;
      width: 100%;
      padding: 8px 12px;
      background: none;
      border: none;
      color: #cdd6f4;
      font: 13px system-ui, sans-serif;
      text-align: left;
      cursor: pointer;
      border-radius: 4px;
    }
    .picker-item:hover { background: #45475a; }
    .picker-item.current { color: #a6e3a1; }
  </style>
</head>
<body>
  <div id="exit-overlay" class="hidden">
    <div style="text-align:center">
      <p>Stream ended.</p>
      <p style="color:#a6adc8;font-size:0.9em">You can close this tab or reconnect.</p>
    </div>
  </div>

  ${isStreaming ? '' : '<div id="app-launcher"></div>'}

  <div id="toolbar" ${isStreaming ? '' : 'style="display:none"'}>
    <button class="tb-btn" id="apps-btn" title="Switch app">Apps</button>
    <button class="tb-btn" id="toggle-btn" title="Toggle view-only mode">Interactive</button>
    <button class="tb-btn" id="mute-btn" title="Toggle audio (Ctrl+Shift+M)">Mute</button>
  </div>

  <div id="app-picker"></div>

  ${isStreaming ? `<iframe
    id="streamFrame"
    src="${streamUrl}"
    allow="autoplay; fullscreen; microphone; gamepad; camera; display-capture; pointer-lock; keyboard-map; clipboard-read; clipboard-write"
    allowfullscreen
  ></iframe>` : ''}

  <script>
    (function() {
      const vscode = acquireVsCodeApi();
      const apps = ${appsJson};
      const currentStreamUrl = '${streamUrl}';
      const mlSettings = ${mlSettingsJson};
      const port = ${port || 0};
      const hostId = ${hostId || 0};

      // --- App Launcher (shown when no stream is active) ---
      const launcher = document.getElementById('app-launcher');
      if (launcher && apps.length > 0) {
        let html = '<h2>Moo Capture</h2><p>Select an app to stream</p><div class="app-grid">';
        apps.forEach(function(app) {
          html += '<div class="app-card" data-id="' + app.id + '" data-name="' + app.name + '">';
          html += '<div class="app-name">' + app.name + '</div>';
          html += '</div>';
        });
        html += '</div>';
        launcher.innerHTML = html;

        launcher.querySelectorAll('.app-card').forEach(function(card) {
          card.addEventListener('click', function() {
            vscode.postMessage({
              command: 'launchApp',
              appId: parseInt(card.getAttribute('data-id')),
              appName: card.getAttribute('data-name'),
            });
          });
        });
      }

      // --- App Picker dropdown (shown when streaming) ---
      const picker = document.getElementById('app-picker');
      const appsBtn = document.getElementById('apps-btn');
      if (appsBtn && picker && apps.length > 0) {
        let pickerHtml = '';
        apps.forEach(function(app) {
          const isCurrent = currentStreamUrl.includes('appId=' + app.id);
          pickerHtml += '<button class="picker-item' + (isCurrent ? ' current' : '') + '" data-id="' + app.id + '" data-name="' + app.name + '">';
          pickerHtml += (isCurrent ? '> ' : '') + app.name;
          pickerHtml += '</button>';
        });
        picker.innerHTML = pickerHtml;

        appsBtn.addEventListener('click', function(e) {
          e.stopPropagation();
          picker.classList.toggle('open');
        });

        picker.querySelectorAll('.picker-item').forEach(function(item) {
          item.addEventListener('click', function() {
            picker.classList.remove('open');
            vscode.postMessage({
              command: 'launchApp',
              appId: parseInt(item.getAttribute('data-id')),
              appName: item.getAttribute('data-name'),
            });
          });
        });

        // Close picker when clicking elsewhere
        document.addEventListener('click', function() { picker.classList.remove('open'); });
      }

      // --- Mute toggle ---
      const muteBtn = document.getElementById('mute-btn');
      if (muteBtn) {
        // Sender tokens guard against future echo loops. Each side stamps
        // outgoing messages with its origin and skips messages whose sender
        // matches itself. Cheap defensive infrastructure.
        const SENDER_OUTER = 'moo-outer';
        const SENDER_IFRAME = 'moo-iframe';
        // Initial state mirrors the audio element's actual post-interaction
        // state. The relay creates the audio element muted=true but force-
        // unmutes via onUserInteraction on the first click/keypress that
        // reaches the stream. By the time the user can see and click this
        // toolbar button, audio is audible — so muted=false is correct, and
        // a first click correctly mutes (instead of being a no-op that just
        // flipped the label). Iteration 8 replaces this assumption with a
        // live query into the iframe.
        let muted = false;
        muteBtn.classList.toggle('active', !muted);
        function publishMuteState() {
          // Forward to the extension so the status-bar mute icon stays in sync.
          vscode.postMessage({ type: 'moo-mute', muted: muted });
        }
        publishMuteState();
        muteBtn.addEventListener('click', function() {
          muted = !muted;
          muteBtn.textContent = muted ? 'Unmute' : 'Mute';
          muteBtn.classList.toggle('active', !muted);
          var frame = document.getElementById('streamFrame');
          if (frame) {
            frame.contentWindow.postMessage(
              { type: 'moo-set-mute', muted: muted, sender: SENDER_OUTER },
              '*',
            );
          }
          publishMuteState();
        });
        // Listen for mute state changes from the iframe (sidebar mute button)
        // and toggle requests from the extension (ctrl+shift+m keybinding).
        window.addEventListener('message', function(event) {
          if (!event.data) { return; }
          // Reject messages that originated from this same outer context.
          // VS Code's vscode.postMessage does not echo to its own webview,
          // but a future code path could add an echo — drop it pre-emptively.
          if (event.data.sender === SENDER_OUTER) { return; }
          if (event.data.type === 'moo-mute') {
            muted = event.data.muted;
            muteBtn.textContent = muted ? 'Unmute' : 'Mute';
            muteBtn.classList.toggle('active', !muted);
            publishMuteState();
          } else if (event.data.type === 'moo-toggle-mute') {
            // Programmatic click reuses the existing handler so the iframe
            // postMessage and label sync stay on a single path.
            muteBtn.click();
          } else if (event.data.type === 'moo-heartbeat') {
            // Forward iframe heartbeat to the extension. The extension's
            // onDidReceiveMessage updates lastHeartbeatMs; the per-panel
            // heartbeatChecker setInterval fires fireReconnect when the
            // gap exceeds HEARTBEAT_TIMEOUT_MS.
            vscode.postMessage({ type: 'moo-heartbeat' });
          }
          // Suppress unused warning; SENDER_IFRAME is used by symmetry/docs
          // but the outer never SENDS as iframe — the iframe stamps its own.
          void SENDER_IFRAME;
        });
      }

      // --- View-only toggle ---
      const iframe = document.getElementById('streamFrame');
      const toggleBtn = document.getElementById('toggle-btn');
      if (toggleBtn && iframe) {
        let viewOnly = false;
        toggleBtn.addEventListener('click', function() {
          viewOnly = !viewOnly;
          iframe.classList.toggle('view-only', viewOnly);
          toggleBtn.classList.toggle('active', viewOnly);
          toggleBtn.textContent = viewOnly ? 'View Only' : 'Interactive';
        });
      }

      // --- Toolbar persistence ---
      // Once the iframe captures pointer focus, body:hover stops firing
      // reliably. Drive visibility from JS pointer events so the toolbar
      // is discoverable: 4s on initial load, 2s on pointer movement or
      // when the cursor crosses into the iframe. Mouse over toolbar
      // itself keeps it visible until exit.
      const toolbar = document.getElementById('toolbar');
      if (toolbar) {
        let hideTimer = null;
        function showToolbar(holdMs) {
          toolbar.classList.add('visible');
          if (hideTimer) { clearTimeout(hideTimer); hideTimer = null; }
          hideTimer = setTimeout(function() {
            toolbar.classList.remove('visible');
            hideTimer = null;
          }, holdMs);
        }
        // Initial hint so the user can find the controls
        showToolbar(4000);
        // Outer-document pointer movement (rare while iframe has focus,
        // but covers the gap between webview load and iframe focus).
        document.addEventListener('pointermove', function() { showToolbar(2000); });
        // mouseenter fires on the iframe element from the parent context
        // every time the cursor crosses into the iframe — solid signal.
        if (iframe) {
          iframe.addEventListener('mouseenter', function() { showToolbar(2000); });
        }
        // Hold visible while cursor is on the toolbar itself.
        toolbar.addEventListener('mouseenter', function() {
          if (hideTimer) { clearTimeout(hideTimer); hideTimer = null; }
          toolbar.classList.add('visible');
        });
        toolbar.addEventListener('mouseleave', function() {
          showToolbar(2000);
        });
      }

      // --- Iframe mute bridge installer ---
      // Hoisted so patchIframe (defined immediately below) can call it.
      // The bridge runs INSIDE the iframe's window context; we attach
      // properties to iframeWin so the bridge survives across patchIframe
      // calls (idempotent install via __mooMuteInstalled flag).
      function installMuteBridge(iframeWin) {
        if (!iframeWin || iframeWin.__mooMuteInstalled) { return; }
        iframeWin.__mooMuteInstalled = true;

        var doc = iframeWin.document;
        // Track all GainNodes we inject between sources and AudioContext
        // destinations. A Set tied to the iframe's window — GC'd when the
        // iframe is replaced.
        var masterGains = new Set();

        // Monkey-patch AudioNode.prototype.connect so any source connecting
        // to a destination is rerouted through a per-context master gain.
        // The dominant path (AudioElementPlayer) does NOT use this; the
        // bypass path (ContextDestinationNodeAudioPlayer) does.
        if (iframeWin.AudioNode && iframeWin.AudioNode.prototype) {
          var origConnect = iframeWin.AudioNode.prototype.connect;
          iframeWin.AudioNode.prototype.connect = function(target) {
            var rest = Array.prototype.slice.call(arguments, 1);
            try {
              if (
                iframeWin.AudioDestinationNode &&
                target instanceof iframeWin.AudioDestinationNode &&
                !masterGains.has(this) &&
                this.context && this.context.createGain
              ) {
                var gain = this.context.createGain();
                masterGains.add(gain);
                origConnect.call(gain, target);
                return origConnect.apply(this, [gain].concat(rest));
              }
            } catch (_) { /* fall through to default behaviour */ }
            return origConnect.apply(this, [target].concat(rest));
          };
        }

        function setMute(muted) {
          // (1) <audio>/<video> path
          try {
            doc.querySelectorAll('audio, video').forEach(function(el) {
              try { el.muted = !!muted; } catch (_) {}
            });
          } catch (_) {}
          // (2) Web Audio path
          masterGains.forEach(function(g) {
            try { g.gain.value = muted ? 0 : 1; } catch (_) {}
          });
        }

        iframeWin.__mooSetMute = setMute;

        var SENDER_IFRAME = 'moo-iframe';
        // Listen for moo-set-mute coming from the outer webview. Reject any
        // message that the iframe itself sent (defensive against future
        // self-echo paths via window.postMessage(..., '*') landing back in
        // the same window).
        iframeWin.addEventListener('message', function(event) {
          if (!event || !event.data) { return; }
          if (event.data.sender === SENDER_IFRAME) { return; }
          if (event.data.type === 'moo-set-mute') {
            setMute(!!event.data.muted);
          }
        });
      }

      // --- Iframe patching ---
      if (iframe) {
        function patchIframe() {
          try {
            const iframeWin = iframe.contentWindow;

            // Override matchMedia to report standalone display mode
            const origMatchMedia = iframeWin.matchMedia.bind(iframeWin);
            iframeWin.matchMedia = function(query) {
              if (query === '(display-mode: standalone)') {
                return { matches: true, media: query, addEventListener: function(){}, removeEventListener: function(){} };
              }
              return origMatchMedia(query);
            };

            // Suppress Keyboard.lock errors
            if (iframeWin.navigator && iframeWin.navigator.keyboard) {
              iframeWin.navigator.keyboard.lock = function() { return Promise.resolve(); };
            }

            // Install mute bridge: lets the outer postMessage moo-set-mute
            // actually mute the stream. Covers two pipelines —
            // (1) AudioElementPlayer: el.muted via DOM walk
            // (2) ContextDestinationNodeAudioPlayer (Web Audio bypass with
            //     no <audio> element): master GainNode injected via
            //     AudioNode.prototype.connect monkey-patch
            // Idempotent — sets a flag on iframe window to avoid reinstall.
            installMuteBridge(iframeWin);

            // Hide broken buttons in relay overlay
            setTimeout(function() {
              try {
                var iframeDoc = iframe.contentDocument;
                if (iframeDoc) {
                  iframeDoc.querySelectorAll('button').forEach(function(btn) {
                    var text = btn.textContent.trim();
                    if (text === 'Lock Mouse' || text === 'Fullscreen' || text === 'Exit') {
                      btn.style.display = 'none';
                    }
                  });
                }
              } catch(e2) {}
            }, 1000);
          } catch(e) {
            // cross-origin — cannot patch
          }
        }
        // 0.1.6: single-phase load. iframe.src is set in the HTML
        // attribute directly to streamUrl (with mlSettings encoded in
        // ?mlSettings= URL param). moo-mute.js (loaded in stream.html
        // <head> before stream.js parses) decodes the param and seeds
        // localStorage.mlSettings. The previous bootstrap →
        // localStorage write → src-redirect dance is gone — replaced
        // by one HTTP load that already has everything it needs.
        iframe.addEventListener('load', function() {
          patchIframe();
        });
      }
    })();
  </script>
</body>
</html>`;
}

// ---------------------------------------------------------------------------
// Loading HTML — shown while relay is starting
// ---------------------------------------------------------------------------

function getLoadingHtml(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline';">
  <style>
    body {
      margin: 0;
      background: #1e1e2e;
      color: #cdd6f4;
      font-family: system-ui, -apple-system, sans-serif;
      display: flex;
      align-items: center;
      justify-content: center;
      height: 100vh;
    }
    .loader {
      text-align: center;
    }
    .loader h2 {
      margin-bottom: 12px;
    }
    .loader p {
      color: #a6adc8;
    }
    .spinner {
      display: inline-block;
      width: 24px;
      height: 24px;
      border: 3px solid #45475a;
      border-top-color: #89b4fa;
      border-radius: 50%;
      animation: spin 0.8s linear infinite;
      margin-bottom: 16px;
    }
    @keyframes spin {
      to { transform: rotate(360deg); }
    }
  </style>
</head>
<body>
  <div class="loader">
    <div class="spinner"></div>
    <h2>Moo Capture</h2>
    <p>Starting streaming relay...</p>
  </div>
</body>
</html>`;
}

function getStatsHtml(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline';">
  <style>
    body {
      margin: 0;
      padding: 24px;
      background: #1e1e2e;
      color: #cdd6f4;
      font-family: system-ui, -apple-system, sans-serif;
    }
    h1 { font-size: 18px; margin: 0 0 4px; font-weight: 500; }
    .sub { color: #a6adc8; font-size: 12px; margin: 0 0 24px; }
    .empty { color: #f9e2af; font-size: 13px; }
    .grid {
      display: grid;
      grid-template-columns: 1fr 1fr 1fr;
      gap: 16px;
      max-width: 720px;
    }
    .card {
      background: #313244;
      border: 1px solid #45475a;
      border-radius: 10px;
      padding: 16px 20px;
    }
    .card .label { color: #a6adc8; font-size: 12px; margin-bottom: 8px; }
    .card .avg { font-size: 28px; font-weight: 500; color: #a6e3a1; }
    .card .unit { font-size: 13px; color: #a6adc8; margin-left: 4px; }
    .card .range { font-size: 12px; color: #a6adc8; margin-top: 6px; }
    .footer { color: #6c7086; font-size: 11px; margin-top: 24px; word-break: break-all; }
  </style>
</head>
<body>
  <h1>Moo Capture &mdash; Latency</h1>
  <p class="sub">Parsed from the latest Sunshine log. Updates as Sunshine writes new debug lines (about every 20 seconds while streaming).</p>
  <div id="empty" class="empty" style="display:none"></div>
  <div id="cards" class="grid" style="display:none">
    <div class="card">
      <div class="label">Encode (frame processing)</div>
      <div><span id="enc-avg" class="avg">-</span><span class="unit">ms avg</span></div>
      <div class="range" id="enc-range">&mdash;</div>
    </div>
    <div class="card">
      <div class="label">Network (Sunshine -> client)</div>
      <div><span id="net-avg" class="avg">-</span><span class="unit">ms avg</span></div>
      <div class="range" id="net-range">&mdash;</div>
    </div>
    <div class="card">
      <div class="label">Encoded frame size</div>
      <div><span id="size-avg" class="avg">-</span><span class="unit">kB avg</span></div>
      <div class="range" id="size-range">&mdash;</div>
    </div>
  </div>
  <div class="footer" id="provenance"></div>
  <script>
    (function() {
      function setText(id, val) { document.getElementById(id).textContent = val; }
      function fmt(n) { return (n === null || n === undefined) ? '-' : Number(n).toFixed(2); }
      function range(t, unit) {
        if (!t) { return '—'; }
        return 'min ' + fmt(t.min) + unit + ' / max ' + fmt(t.max) + unit;
      }
      function render(snap) {
        var empty = document.getElementById('empty');
        var cards = document.getElementById('cards');
        if (!snap || !snap.found) {
          cards.style.display = 'none';
          empty.style.display = 'block';
          empty.textContent = (snap && snap.error) ? snap.error : 'Waiting for Sunshine logs...';
          document.getElementById('provenance').textContent = '';
          return;
        }
        cards.style.display = 'grid';
        empty.style.display = 'none';
        setText('enc-avg', fmt(snap.frameProcessingMs && snap.frameProcessingMs.avg));
        setText('enc-range', range(snap.frameProcessingMs, 'ms'));
        setText('net-avg', fmt(snap.networkMs && snap.networkMs.avg));
        setText('net-range', range(snap.networkMs, 'ms'));
        setText('size-avg', fmt(snap.encodedSizeKb && snap.encodedSizeKb.avg));
        setText('size-range', range(snap.encodedSizeKb, 'kB'));
        document.getElementById('provenance').textContent = 'Source: ' + (snap.logPath || '');
      }
      window.addEventListener('message', function(event) {
        if (event && event.data && event.data.type === 'moo-stats-update') {
          render(event.data.snap);
        }
      });
      render(null);
    })();
  </script>
</body>
</html>`;
}

function getErrorHtml(message: string): string {
  const escaped = message.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline';">
  <style>
    body { margin: 0; background: #1e1e2e; color: #cdd6f4; font-family: system-ui; display: flex; align-items: center; justify-content: center; height: 100vh; }
    .error { text-align: center; max-width: 500px; }
    .error h2 { color: #f38ba8; }
    .error p { color: #a6adc8; word-break: break-word; }
  </style>
</head>
<body>
  <div class="error">
    <h2>Connection Failed</h2>
    <p>${escaped}</p>
  </div>
</body>
</html>`;
}
