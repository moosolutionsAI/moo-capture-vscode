// ---------------------------------------------------------------------------
// Virtual Display Driver (VDD) lifecycle management
// ---------------------------------------------------------------------------

import { exec } from 'child_process';
import * as https from 'https';
import * as fs from 'fs';
import * as path from 'path';
import { createWriteStream } from 'fs';
import type { OutputChannel } from 'vscode';
import type { DisplayInfo } from './types';
import { VDD_GITHUB_REPO } from './constants';

/** Friendly name pattern used to find the VDD device dynamically. */
const VDD_FRIENDLY_NAME_PATTERN = '*Virtual Display*';

/**
 * Manages the Virtual Display Driver lifecycle: installation, enable/disable,
 * display enumeration, and new-display detection.
 */
export class VirtualDisplayManager {
  constructor(private readonly output: OutputChannel) {}

  // -------------------------------------------------------------------------
  // Installation
  // -------------------------------------------------------------------------

  /**
   * Returns `true` if a Virtual Display Driver PnP device is present on the
   * system (enabled or disabled).
   */
  async isVddInstalled(): Promise<boolean> {
    return new Promise((resolve) => {
      const cmd = `powershell -NoProfile -Command "Get-PnpDevice | Where-Object { $_.FriendlyName -like '*Virtual Display*' }"`;
      exec(cmd, { timeout: 15000 }, (err, stdout) => {
        if (err) {
          this.output.appendLine(`[VDD] isVddInstalled check failed: ${err.message}`);
          resolve(false);
          return;
        }
        // If the command produced output lines beyond the header, the device exists
        const lines = stdout.trim().split('\n').filter((l) => l.trim().length > 0);
        resolve(lines.length > 1);
      });
    });
  }

  /**
   * Downloads the VDD installer `.exe` from the latest GitHub release.
   *
   * Uses the same redirect-following HTTPS pattern as `relayDownloader.ts`.
   *
   * @returns Absolute path to the downloaded installer executable.
   */
  async downloadVddInstaller(
    globalStoragePath: string,
    onProgress?: (msg: string) => void,
  ): Promise<string> {
    fs.mkdirSync(globalStoragePath, { recursive: true });

    const installerDest = path.join(globalStoragePath, 'vdd-installer.exe');

    // Resolve the latest release redirect to find the actual .exe asset URL.
    const latestUrl = `https://github.com/${VDD_GITHUB_REPO}/releases/latest`;
    this.output.appendLine(`[VDD] Resolving latest release from ${latestUrl}`);
    onProgress?.('Resolving latest VDD release...');

    const releaseTag = await this.resolveLatestReleaseTag(latestUrl);
    this.output.appendLine(`[VDD] Latest release tag: ${releaseTag}`);

    // The release page lists assets. The Windows installer is a .exe in the
    // release assets. Convention:
    //   https://github.com/<repo>/releases/download/<tag>/<asset>
    // We try the common asset naming patterns.
    const assetUrl = await this.resolveInstallerAssetUrl(releaseTag);
    this.output.appendLine(`[VDD] Downloading installer from ${assetUrl}`);
    onProgress?.('Downloading VDD installer...');

    await this.downloadFile(assetUrl, installerDest);
    this.output.appendLine(`[VDD] Installer saved to ${installerDest}`);
    onProgress?.('Download complete.');

    return installerDest;
  }

  /**
   * Launches the VDD installer with elevated privileges (triggers UAC).
   * Blocks until the installer process exits.
   */
  async installVdd(installerPath: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const escapedPath = installerPath.replace(/'/g, "''");
      const cmd = `powershell -NoProfile -Command "Start-Process -FilePath '${escapedPath}' -Verb RunAs -Wait"`;
      this.output.appendLine(`[VDD] Running installer: ${installerPath}`);

      exec(cmd, { timeout: 300000 }, (err) => {
        if (err) {
          reject(new Error(`VDD installation failed: ${err.message}`));
        } else {
          this.output.appendLine('[VDD] Installer process exited.');
          resolve();
        }
      });
    });
  }

  /**
   * Polls for the VDD device to appear in PnP, checking every 1 second for
   * up to 15 seconds. Returns `true` if the device was detected.
   */
  async verifyVddInstalled(): Promise<boolean> {
    const maxAttempts = 15;
    for (let i = 0; i < maxAttempts; i++) {
      const installed = await this.isVddInstalled();
      if (installed) {
        this.output.appendLine(`[VDD] Device detected after ${i + 1}s`);
        return true;
      }
      await this.sleep(1000);
    }
    this.output.appendLine('[VDD] Device NOT detected after 15s');
    return false;
  }

  // -------------------------------------------------------------------------
  // Display enumeration
  // -------------------------------------------------------------------------

  /**
   * Runs `dxgi-info.exe` and parses its output into an array of
   * {@link DisplayInfo} objects.
   *
   * Expected output format:
   * ```
   * Adapter 0: NVIDIA GeForce RTX 4060 Laptop GPU
   *   Output 0: \\.\DISPLAY2  (1920x1080, AttachedToDesktop: yes)
   *   Output 1: \\.\DISPLAY3  (1920x1080, AttachedToDesktop: no)
   * ```
   */
  async getDisplays(dxgiInfoPath: string): Promise<DisplayInfo[]> {
    return new Promise((resolve, reject) => {
      const escaped = dxgiInfoPath.replace(/'/g, "''");
      exec(`"${escaped}"`, { timeout: 15000 }, (err, stdout, stderr) => {
        if (err) {
          reject(new Error(`dxgi-info.exe failed: ${err.message}\n${stderr}`));
          return;
        }

        const displays: DisplayInfo[] = [];
        let currentAdapter = '';

        for (const line of stdout.split('\n')) {
          const trimmed = line.trim();

          // Match adapter lines
          const adapterMatch = trimmed.match(/^Adapter\s+\d+:\s+(.+)$/);
          if (adapterMatch) {
            currentAdapter = adapterMatch[1].trim();
            continue;
          }

          // Match output lines
          // e.g.  Output 0: \\.\DISPLAY2  (1920x1080, AttachedToDesktop: yes)
          const outputMatch = trimmed.match(
            /^Output\s+\d+:\s+(\\\\.\\[A-Za-z0-9]+)\s+\((\d+x\d+),\s*AttachedToDesktop:\s*(yes|no)\)/,
          );
          if (outputMatch) {
            displays.push({
              name: outputMatch[1],
              resolution: outputMatch[2],
              attached: outputMatch[3] === 'yes',
              adapter: currentAdapter,
            });
          }
        }

        resolve(displays);
      });
    });
  }

  // -------------------------------------------------------------------------
  // Enable / Disable
  // -------------------------------------------------------------------------

  /**
   * Dynamically resolves the VDD instance ID by querying for a device
   * matching the friendly name pattern.
   */
  private resolveVddInstanceId(): Promise<string> {
    return new Promise((resolve, reject) => {
      const cmd = `powershell -NoProfile -Command "Get-PnpDevice -FriendlyName '${VDD_FRIENDLY_NAME_PATTERN}' -ErrorAction SilentlyContinue | Select-Object -First 1 -ExpandProperty InstanceId"`;
      exec(cmd, { timeout: 15000 }, (err, stdout) => {
        const instanceId = stdout?.trim();
        if (instanceId) {
          this.output.appendLine(`[VDD] Resolved instance ID: ${instanceId}`);
          resolve(instanceId);
        } else {
          reject(new Error('VDD device not found. Ensure the Virtual Display Driver is installed.'));
        }
      });
    });
  }

  /**
   * Enables the VDD device via `pnputil /enable-device`.
   */
  async enableVdd(): Promise<void> {
    const instanceId = await this.resolveVddInstanceId();
    return new Promise((resolve, reject) => {
      const cmd = `powershell -NoProfile -Command "pnputil /enable-device '${instanceId}'"`;
      this.output.appendLine('[VDD] Enabling virtual display device...');

      exec(cmd, { timeout: 15000 }, (err, stdout, stderr) => {
        if (err) {
          reject(new Error(`Failed to enable VDD: ${err.message}\n${stderr}`));
        } else {
          this.output.appendLine(`[VDD] Enable result: ${stdout.trim()}`);
          resolve();
        }
      });
    });
  }

  /**
   * Disables the VDD device via `pnputil /disable-device`.
   */
  async disableVdd(): Promise<void> {
    const instanceId = await this.resolveVddInstanceId();
    return new Promise((resolve, reject) => {
      const cmd = `powershell -NoProfile -Command "pnputil /disable-device '${instanceId}'"`;
      this.output.appendLine('[VDD] Disabling virtual display device...');

      exec(cmd, { timeout: 15000 }, (err, stdout, stderr) => {
        if (err) {
          reject(new Error(`Failed to disable VDD: ${err.message}\n${stderr}`));
        } else {
          this.output.appendLine(`[VDD] Disable result: ${stdout.trim()}`);
          resolve();
        }
      });
    });
  }

  // -------------------------------------------------------------------------
  // Display diffing
  // -------------------------------------------------------------------------

  /**
   * Compares two display lists and returns the *name* of the first display
   * that is present in `afterDisplays` but not in `beforeDisplays`.
   *
   * Returns `null` if no new display was found.
   */
  detectNewDisplay(
    beforeDisplays: DisplayInfo[],
    afterDisplays: DisplayInfo[],
  ): string | null {
    const beforeNames = new Set(beforeDisplays.map((d) => d.name));
    for (const display of afterDisplays) {
      if (!beforeNames.has(display.name)) {
        return display.name;
      }
    }
    return null;
  }

  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------

  /**
   * Follows the `/releases/latest` redirect to determine the tag name.
   */
  private resolveLatestReleaseTag(latestUrl: string): Promise<string> {
    return new Promise((resolve, reject) => {
      https.get(
        latestUrl,
        { headers: { 'User-Agent': 'moo-capture-vscode' } },
        (res) => {
          // GitHub redirects /releases/latest → /releases/tag/<tag>
          if (
            res.statusCode &&
            res.statusCode >= 300 &&
            res.statusCode < 400 &&
            res.headers.location
          ) {
            res.resume();
            const location = res.headers.location;
            const tagMatch = location.match(/\/tag\/(.+)$/);
            if (tagMatch) {
              resolve(tagMatch[1]);
            } else {
              reject(new Error(`Could not parse release tag from redirect: ${location}`));
            }
            return;
          }

          // If no redirect, try to parse the HTML (unlikely for API calls)
          res.resume();
          reject(new Error(`Unexpected response ${res.statusCode} from ${latestUrl}`));
        },
      ).on('error', reject);
    });
  }

  /**
   * Attempts to resolve the `.exe` installer asset URL for the given release
   * tag. Queries the GitHub API for release assets and picks the first `.exe`.
   */
  private resolveInstallerAssetUrl(tag: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const apiUrl = `https://api.github.com/repos/${VDD_GITHUB_REPO}/releases/tags/${tag}`;

      https.get(
        apiUrl,
        {
          headers: {
            'User-Agent': 'moo-capture-vscode',
            Accept: 'application/vnd.github.v3+json',
          },
        },
        (res) => {
          if (res.statusCode !== 200) {
            res.resume();
            reject(new Error(`GitHub API returned ${res.statusCode} for ${apiUrl}`));
            return;
          }

          let body = '';
          res.on('data', (chunk: Buffer) => { body += chunk.toString(); });
          res.on('end', () => {
            try {
              const release = JSON.parse(body) as {
                assets: Array<{ name: string; browser_download_url: string }>;
              };

              const exeAsset = release.assets.find(
                (a) => a.name.endsWith('.exe'),
              );

              if (exeAsset) {
                resolve(exeAsset.browser_download_url);
              } else {
                reject(
                  new Error(
                    `No .exe installer found in release ${tag}. Assets: ${release.assets.map((a) => a.name).join(', ')}`,
                  ),
                );
              }
            } catch (e) {
              reject(new Error(`Failed to parse GitHub release JSON: ${(e as Error).message}`));
            }
          });
        },
      ).on('error', reject);
    });
  }

  /**
   * Downloads a file from `url` to `dest`, following up to 5 HTTP redirects.
   * Mirrors the pattern from `relayDownloader.ts`.
   */
  private downloadFile(url: string, dest: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const follow = (currentUrl: string, redirects = 0) => {
        if (redirects > 5) {
          reject(new Error('Too many redirects'));
          return;
        }

        https.get(
          currentUrl,
          { headers: { 'User-Agent': 'moo-capture-vscode' } },
          (res) => {
            // Follow redirects
            if (
              res.statusCode &&
              res.statusCode >= 300 &&
              res.statusCode < 400 &&
              res.headers.location
            ) {
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
              try { fs.unlinkSync(dest); } catch { /* ignore */ }
              reject(err);
            });
          },
        ).on('error', reject);
      };

      follow(url);
    });
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
