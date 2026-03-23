import * as vscode from 'vscode';
import * as fs from 'fs';
import { COMMANDS, CONFIG_SECTION, STATUS_BAR_PRIORITY, RELAY_DEFAULT_PORT } from './constants';
import { ConnectionManager } from './connectionManager';
import type { MooCaptureConfig, ConnectionState } from './types';

// ---------------------------------------------------------------------------
// Config helper
// ---------------------------------------------------------------------------

function getConfig(): MooCaptureConfig {
  const cfg = vscode.workspace.getConfiguration(CONFIG_SECTION);
  return {
    sunshineHost: cfg.get<string>('sunshineHost', 'localhost'),
    sunshinePort: cfg.get<number>('sunshinePort', 47984),
    relayPort: cfg.get<number>('relayPort', RELAY_DEFAULT_PORT),
    resolution: cfg.get<string>('resolution', '1920x1080'),
    fps: cfg.get<number>('fps', 60),
    codec: cfg.get<'h264' | 'hevc'>('codec', 'h264'),
    bitrate: cfg.get<number>('bitrate', 20000),
  };
}

// ---------------------------------------------------------------------------
// Status bar labels
// ---------------------------------------------------------------------------

const STATE_LABELS: Record<ConnectionState, string> = {
  disconnected: '$(game) Moo Capture',
  downloading_relay: '$(sync~spin) Downloading Relay...',
  starting_relay: '$(sync~spin) Starting Relay...',
  pairing: '$(key) Pairing with Sunshine...',
  connecting_webrtc: '$(sync~spin) Connecting...',
  streaming: '$(circle-filled) Streaming',
  error: '$(error) Moo Capture: Error',
};

// ---------------------------------------------------------------------------
// Activation
// ---------------------------------------------------------------------------

export function activate(context: vscode.ExtensionContext): void {
  const output = vscode.window.createOutputChannel('Moo Capture');
  output.appendLine('Moo Capture: activate()');

  // Ensure globalStoragePath exists
  fs.mkdirSync(context.globalStorageUri.fsPath, { recursive: true });

  const connManager = new ConnectionManager(output, context.globalStorageUri.fsPath);
  let panel: vscode.WebviewPanel | undefined;

  // Status bar
  const statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, STATUS_BAR_PRIORITY);
  statusBar.command = COMMANDS.connect;
  statusBar.text = STATE_LABELS.disconnected;
  statusBar.tooltip = 'Click to connect to Sunshine';
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
        const streamUrl = await connManager.connect(config, (pin: string) => {
          vscode.window.showInformationMessage(
            `Enter this PIN in Sunshine: ${pin}`,
            { modal: true },
            'Done',
          );
        });

        // Load stream page directly in iframe — skips app selection
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
