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
  context.subscriptions.push(
    vscode.commands.registerCommand(COMMANDS.connect, async () => {
      const config = getConfig();

      // If headless mode, ensure VDD is installed and credentials are available
      if (config.headlessMode) {
        const vdm = new VirtualDisplayManager(output);
        const installed = await vdm.isVddInstalled();

        if (!installed) {
          const choice = await vscode.window.showWarningMessage(
            'Virtual Display Driver is not installed. Headless mode requires it.',
            'Setup Now',
            'Continue Without Headless',
          );
          if (choice === 'Setup Now') {
            await vscode.commands.executeCommand('moo-capture.setupVirtualDisplay');
            // Re-check after setup
            const nowInstalled = await vdm.isVddInstalled();
            if (!nowInstalled) {
              vscode.window.showErrorMessage('VDD installation did not succeed. Continuing without headless mode.');
              config.headlessMode = false;
            }
          } else {
            config.headlessMode = false;
          }
        }

        // Get Vibeshine credentials for REST API
        if (config.headlessMode) {
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

        panel.onDidDispose(() => {
          connManager.disconnect();
          panel = undefined;
          statusBar.text = STATE_LABELS.disconnected;
        });

        // Show loading state while relay starts up
        panel.webview.html = getLoadingHtml();
      } else {
        panel.reveal(vscode.ViewColumn.One);
      }

      try {
        const { port, hostId, apps } = await connManager.connect(config, (pin: string) => {
          vscode.window.showInformationMessage(
            `Enter this PIN in Vibeshine: ${pin}`,
            { modal: true },
            'Done',
          );
        });

        if (apps.length === 0) {
          panel.webview.html = getErrorHtml('No apps found in Vibeshine. Add apps at https://localhost:47990/applications');
          return;
        }

        // Let user pick which app to stream
        let selectedApp = apps[0];
        if (apps.length > 1) {
          const pick = await vscode.window.showQuickPick(
            apps.map(a => ({ label: a.name, appId: a.id })),
            { placeHolder: 'Select an app to stream' },
          );
          if (!pick) { return; } // User cancelled
          selectedApp = { id: pick.appId, name: pick.label };
        }

        // Load stream.html directly with the selected app
        const streamUrl = `http://127.0.0.1:${port}/stream.html?hostId=${hostId}&appId=${selectedApp.id}`;
        output.appendLine(`[Connect] Streaming ${selectedApp.name}: ${streamUrl}`);
        panel.webview.html = getWebviewContent(streamUrl);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        output.appendLine(`[Connect] Failed: ${msg}`);
        if (panel) {
          panel.webview.html = getErrorHtml(msg);
        }
      }
    }),
  );

  // Disconnect command
  context.subscriptions.push(
    vscode.commands.registerCommand(COMMANDS.disconnect, () => {
      if (panel) {
        connManager.disconnect();
        panel.dispose();
        panel = undefined;
        statusBar.text = STATE_LABELS.disconnected;
      }
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

function getWebviewContent(streamUrl: string): string {
  const relayUrl = streamUrl;
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="default-src http://127.0.0.1:* 'unsafe-inline'; frame-src http://127.0.0.1:*; script-src 'unsafe-inline' http://127.0.0.1:*; style-src 'unsafe-inline' http://127.0.0.1:*; connect-src ws://127.0.0.1:* http://127.0.0.1:*; media-src blob: mediastream: *; img-src http://127.0.0.1:* blob: data:;">
  <style>
    html, body {
      margin: 0;
      padding: 0;
      width: 100%;
      height: 100%;
      overflow: hidden;
      background: #1e1e2e;
    }
    iframe {
      width: 100%;
      height: 100%;
      border: none;
    }
    #exit-overlay {
      display: flex;
      align-items: center;
      justify-content: center;
      position: fixed;
      inset: 0;
      background: #1e1e2e;
      color: #cdd6f4;
      font-family: system-ui, -apple-system, sans-serif;
      z-index: 10;
    }
    #exit-overlay.hidden { display: none; }
  </style>
</head>
<body>
  <div id="exit-overlay" class="hidden">
    <div style="text-align:center">
      <p>Stream ended.</p>
      <p style="color:#a6adc8;font-size:0.9em">You can close this tab or reconnect.</p>
    </div>
  </div>
  <iframe
    id="streamFrame"
    src="${relayUrl}"
    allow="autoplay; fullscreen; microphone; gamepad; camera; display-capture"
    allowfullscreen
  ></iframe>
  <script>
    (function() {
      const iframe = document.getElementById('streamFrame');

      // After each iframe page load, patch the iframe's window to:
      // 1. Make it think it's a PWA (display-mode: standalone) so clicks
      //    use window.location.href instead of window.open (which is blocked)
      // 2. Suppress Keyboard.lock errors
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
        } catch(e) {
          // cross-origin — cannot patch
        }
      }

      iframe.addEventListener('load', patchIframe);
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
