import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { COMMANDS, CONFIG_SECTION, STATUS_BAR_PRIORITY, RELAY_DEFAULT_PORT } from './constants';
import { ConnectionManager } from './connectionManager';
import { VirtualDisplayManager } from './virtualDisplayManager';
import type { MooCaptureConfig, ConnectionState } from './types';

// ---------------------------------------------------------------------------
// Config helper
// ---------------------------------------------------------------------------

function getConfig(): MooCaptureConfig {
  const cfg = vscode.workspace.getConfiguration(CONFIG_SECTION);
  return {
    sunshineHost: cfg.get<string>('sunshineHost', '127.0.0.1'),
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

  // Status bar
  const statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, STATUS_BAR_PRIORITY);
  statusBar.command = COMMANDS.connect;
  statusBar.text = STATE_LABELS.disconnected;
  statusBar.tooltip = 'Click to connect to Vibeshine';
  statusBar.show();
  context.subscriptions.push(statusBar);

  connManager.onState((state: ConnectionState, message?: string) => {
    statusBar.text = STATE_LABELS[state];
    if (message) {
      statusBar.tooltip = message;
    }
  });

  // Connect command
  let connectInProgress = false;
  context.subscriptions.push(
    vscode.commands.registerCommand(COMMANDS.connect, async () => {
      // Guard: prevent concurrent connect flows
      if (connectInProgress || connManager.currentState !== 'disconnected') {
        output.appendLine('[Connect] Ignoring duplicate connect request.');
        return;
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

        panel.onDidDispose(async () => {
          // Prompt the user for what to do on tab close
          const choice = await vscode.window.showInformationMessage(
            'Moo Capture tab closed. What would you like to do?',
            'Keep Relay Running',
            'Stop Stream',
            'Shutdown Everything',
          );

          if (choice === 'Shutdown Everything') {
            connManager.dispose();
            statusBar.text = STATE_LABELS.disconnected;
            statusBar.tooltip = 'Relay stopped. Click to reconnect.';
          } else if (choice === 'Stop Stream') {
            connManager.disconnect();
            statusBar.text = STATE_LABELS.disconnected;
            statusBar.tooltip = 'Stream stopped. Relay still running for quick reconnect.';
          } else {
            // Keep Relay Running (or dismissed) — just cancel the active stream
            connManager.disconnect();
            statusBar.text = '$(game) Moo Capture (Ready)';
            statusBar.tooltip = 'Relay running. Click to reconnect instantly.';
          }
          panel = undefined;
        });

        // Show loading state while relay starts up
        panel.webview.html = getLoadingHtml();
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

        // Listen for app selection from the webview
        panel.webview.onDidReceiveMessage((msg: { command: string; appId?: number; appName?: string }) => {
          if (msg.command === 'launchApp' && msg.appId !== undefined) {
            const streamUrl = `http://127.0.0.1:${port}/stream.html?hostId=${hostId}&appId=${msg.appId}`;
            output.appendLine(`[Connect] Launching ${msg.appName}: ${streamUrl}`);
            if (panel) {
              panel.webview.html = getWebviewContent(streamUrl, port, hostId, apps);
            }
          }
        });
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
      const confirm = await vscode.window.showWarningMessage(
        'Shut down Moo Capture completely? This stops the relay and stream.',
        { modal: true },
        'Shutdown',
      );
      if (confirm !== 'Shutdown') { return; }

      connManager.dispose();
      if (panel) {
        panel.dispose();
        panel = undefined;
      }
      statusBar.text = STATE_LABELS.disconnected;
      statusBar.tooltip = 'Click to connect to Vibeshine';
      vscode.window.showInformationMessage('Moo Capture shut down. Relay stopped.');
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
): string {
  const appsJson = JSON.stringify(apps || []).replace(/</g, '\\u003c');
  const isStreaming = streamUrl !== '';
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

    /* Toolbar — appears on hover */
    #toolbar {
      position: fixed;
      top: 8px;
      right: 8px;
      z-index: 20;
      display: flex;
      gap: 6px;
      opacity: 0;
      transition: opacity 0.2s;
    }
    body:hover #toolbar { opacity: 1; }
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
    <button class="tb-btn" id="mute-btn" title="Toggle audio">Unmute</button>
  </div>

  <div id="app-picker"></div>

  ${isStreaming ? `<iframe
    id="streamFrame"
    src="${streamUrl}"
    allow="autoplay; fullscreen; microphone; gamepad; camera; display-capture"
    allowfullscreen
  ></iframe>` : ''}

  <script>
    (function() {
      const vscode = acquireVsCodeApi();
      const apps = ${appsJson};
      const currentStreamUrl = '${streamUrl}';
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
        let muted = true;
        muteBtn.addEventListener('click', function() {
          muted = !muted;
          muteBtn.textContent = muted ? 'Unmute' : 'Mute';
          muteBtn.classList.toggle('active', !muted);
          // Mute/unmute all audio in the iframe
          try {
            const frame = document.getElementById('streamFrame');
            if (frame && frame.contentDocument) {
              var videos = frame.contentDocument.querySelectorAll('video, audio');
              videos.forEach(function(v) { v.muted = muted; });
            }
          } catch(e) { /* cross-origin — iframe handles its own audio */ }
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
        iframe.addEventListener('load', patchIframe);
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
