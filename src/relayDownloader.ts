import * as https from 'https';
import * as fs from 'fs';
import * as path from 'path';
import { createWriteStream } from 'fs';
import type { OutputChannel } from 'vscode';
import {
  RELAY_GITHUB_REPO,
  RELAY_VERSION,
  RELAY_ASSET_WIN,
  RELAY_BINARY_NAME_WIN,
} from './constants';

// In-page mute handler + heartbeat + settings injection injected into the
// relay's stream.html.
//
// SETTINGS (0.1.6): reads `mlSettings` from a base64-JSON `?mlSettings=`
// URL query param and seeds it into localStorage BEFORE the relay's
// stream.js parses. Replaces the parent's bootstrap → load → redirect
// pattern (which loaded /index.html first only to get same-origin
// localStorage write access, then redirected to stream.html). With
// settings in the URL, stream.html can be loaded directly — one iframe
// load instead of two. Saves ~600-900ms of cold-start budget and removes
// a whole class of two-phase race conditions. The relay's
// getLocalStreamSettings() at component/settings_menu.js:13 reads
// localStorage.mlSettings — this IIFE runs first because moo-mute.js is
// in <head> while stream.js is loaded as a deferred module.
//
// MUTE: the parent webview cannot reach the iframe's <audio> element to set
// .muted (the existing in-extension bridge silently fails because the audio
// element is either unreachable cross-origin or not yet mounted at install
// time). This snippet runs in the relay's own document, so the querySelector
// resolves against the right tree and DOM access is same-origin. Listener
// arms before the audio pipeline initialises, so toggling mute before audio
// starts is remembered when the element appears (the next moo-set-mute
// message wins).
//
// HEARTBEAT (PHASE FOUR): posts moo-heartbeat to window.parent every 2000ms.
// The parent's onDidReceiveMessage handler resets a per-panel timeout. If
// 5000ms passes without a heartbeat AND the panel is visible, the parent
// triggers a programmatic reconnect (PHASE THREE). Sub-2s detection
// complements the Sunshine-log watchdog — catches iframe death (page
// navigated, JS crashed, GPU process killed) faster than Sunshine can log
// CLIENT DISCONNECTED.
//
// The setInterval lives in the iframe's JS context; cleanup is automatic
// when the page unloads. Per the loop's CRITICAL RULES, this is browser
// JS not Node — the registered-teardown rule covers extension code only.
//
// Version marker (v3) is the ensureMutePatch drift detector — bumping the
// marker forces a content-mismatch and re-write on existing installs the
// next time connect() runs ensureMutePatch.
const MOO_MUTE_JS = `// Injected by moo-capture-vscode v3 (mute + heartbeat + settings). Do not edit.

// Settings injection (0.1.6): seed localStorage.mlSettings from URL param
// before stream.js calls getLocalStreamSettings().
(function () {
  try {
    var params = new URLSearchParams(window.location.search);
    var raw = params.get('mlSettings');
    if (!raw) { return; }
    var settings = JSON.parse(atob(raw));
    var existing = {};
    try {
      var stored = localStorage.getItem('mlSettings');
      if (stored) { existing = JSON.parse(stored); }
    } catch (_) { /* corrupt — start fresh */ }
    Object.assign(existing, settings);
    localStorage.setItem('mlSettings', JSON.stringify(existing));
    console.log('[moo-mute] Seeded mlSettings from URL:', settings);
  } catch (e) {
    console.warn('[moo-mute] Failed to parse mlSettings URL param:', e);
  }
})();

window.addEventListener('message', function (e) {
  if (!e || !e.data || e.data.type !== 'moo-set-mute') { return; }
  var audio = document.querySelector('audio.audio-stream');
  if (audio) { audio.muted = !!e.data.muted; }
});

setInterval(function () {
  try {
    if (window.parent && window.parent !== window) {
      window.parent.postMessage({ type: 'moo-heartbeat' }, '*');
    }
  } catch (_) { /* parent may be cross-origin in some contexts */ }
}, 2000);
`;
const MOO_MUTE_SCRIPT_TAG = '<script src="moo-mute.js"></script>';
const MOO_MUTE_MARKER = 'moo-mute.js';

/**
 * Downloads moonlight-web-stream from GitHub releases and extracts it.
 * Returns the path to the executable.
 */
export class RelayDownloader {
  private readonly installDir: string;

  constructor(
    globalStoragePath: string,
    private readonly output: OutputChannel,
  ) {
    this.installDir = path.join(globalStoragePath, 'relay');
  }

  /** Path to the relay binary */
  get binaryPath(): string {
    return path.join(this.installDir, RELAY_BINARY_NAME_WIN);
  }

  /** Check if the relay is already downloaded */
  isInstalled(): boolean {
    return fs.existsSync(this.binaryPath);
  }

  /** Download and extract the relay binary */
  async download(onProgress?: (message: string) => void): Promise<string> {
    // Ensure install directory exists
    fs.mkdirSync(this.installDir, { recursive: true });

    const assetUrl = `https://github.com/${RELAY_GITHUB_REPO}/releases/download/${RELAY_VERSION}/${RELAY_ASSET_WIN}`;
    const zipPath = path.join(this.installDir, RELAY_ASSET_WIN);

    this.output.appendLine(`[Relay Download] Downloading from ${assetUrl}`);
    onProgress?.('Downloading streaming relay...');

    // Download the zip file (follows redirects)
    await this.downloadFile(assetUrl, zipPath);
    this.output.appendLine(`[Relay Download] Downloaded to ${zipPath}`);

    // Extract using PowerShell (available on Windows)
    onProgress?.('Extracting...');
    await this.extractZip(zipPath, this.installDir);

    // Clean up zip
    try { fs.unlinkSync(zipPath); } catch { /* ignore */ }

    if (!fs.existsSync(this.binaryPath)) {
      // Binary might be in a subdirectory — find it
      const found = this.findBinary(this.installDir, RELAY_BINARY_NAME_WIN);
      if (found && found !== this.binaryPath) {
        // Move contents up to install dir
        const subDir = path.dirname(found);
        if (subDir !== this.installDir) {
          for (const file of fs.readdirSync(subDir)) {
            const src = path.join(subDir, file);
            const dest = path.join(this.installDir, file);
            if (!fs.existsSync(dest)) {
              fs.renameSync(src, dest);
            }
          }
        }
      }
    }

    if (!fs.existsSync(this.binaryPath)) {
      throw new Error(`Relay binary not found after extraction. Expected at: ${this.binaryPath}`);
    }

    this.output.appendLine(`[Relay Download] Binary ready at ${this.binaryPath}`);
    this.ensureMutePatch();
    onProgress?.('Ready');
    return this.binaryPath;
  }

  /**
   * Idempotently inject the in-page mute handler into the relay's static
   * files. Safe to call on every connect — only writes when content drifts
   * or the script tag is missing. Survives relay re-downloads (caller
   * invokes after download() too).
   */
  ensureMutePatch(): void {
    const staticDir = path.join(this.installDir, 'static');
    const jsPath = path.join(staticDir, 'moo-mute.js');
    const htmlPath = path.join(staticDir, 'stream.html');

    if (!fs.existsSync(staticDir) || !fs.existsSync(htmlPath)) {
      // Relay layout unexpected — skip rather than throw. Streaming will
      // still work; only the in-app mute button degrades to no-op.
      return;
    }

    try {
      const existingJs = fs.existsSync(jsPath) ? fs.readFileSync(jsPath, 'utf8') : null;
      if (existingJs !== MOO_MUTE_JS) {
        fs.writeFileSync(jsPath, MOO_MUTE_JS, 'utf8');
        this.output.appendLine('[Relay Patch] Wrote moo-mute.js');
      }

      const html = fs.readFileSync(htmlPath, 'utf8');
      if (!html.includes(MOO_MUTE_MARKER)) {
        const closingHead = '</head>';
        const idx = html.indexOf(closingHead);
        if (idx === -1) {
          this.output.appendLine('[Relay Patch] stream.html missing </head>; skipped tag injection');
          return;
        }
        const patched =
          html.slice(0, idx) +
          `    ${MOO_MUTE_SCRIPT_TAG}\n` +
          html.slice(idx);
        fs.writeFileSync(htmlPath, patched, 'utf8');
        this.output.appendLine('[Relay Patch] Injected moo-mute.js script tag into stream.html');
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.output.appendLine(`[Relay Patch] Failed: ${msg}`);
    }
  }

  private findBinary(dir: string, name: string): string | undefined {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isFile() && entry.name === name) {
        return fullPath;
      }
      if (entry.isDirectory()) {
        const found = this.findBinary(fullPath, name);
        if (found) { return found; }
      }
    }
    return undefined;
  }

  private downloadFile(url: string, dest: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const follow = (url: string, redirects = 0) => {
        if (redirects > 5) {
          reject(new Error('Too many redirects'));
          return;
        }

        https.get(url, { headers: { 'User-Agent': 'moo-capture-vscode' } }, (res) => {
          // Follow redirects
          if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
            res.resume();
            follow(res.headers.location, redirects + 1);
            return;
          }

          if (res.statusCode !== 200) {
            res.resume();
            reject(new Error(`Download failed: HTTP ${res.statusCode}`));
            return;
          }

          const file = createWriteStream(dest);
          res.pipe(file);
          file.on('finish', () => {
            file.close();
            resolve();
          });
          file.on('error', (err) => {
            fs.unlinkSync(dest);
            reject(err);
          });
        }).on('error', reject);
      };

      follow(url);
    });
  }

  private extractZip(zipPath: string, destDir: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const { exec } = require('child_process') as typeof import('child_process');
      // Use PowerShell to extract on Windows
      const cmd = `powershell -NoProfile -Command "Expand-Archive -Path '${zipPath}' -DestinationPath '${destDir}' -Force"`;
      exec(cmd, { timeout: 60000 }, (err: Error | null) => {
        if (err) {
          reject(new Error(`Extraction failed: ${err.message}`));
        } else {
          resolve();
        }
      });
    });
  }
}
