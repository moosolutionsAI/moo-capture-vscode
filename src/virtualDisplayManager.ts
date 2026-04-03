// ---------------------------------------------------------------------------
// Virtual Display Driver (VDD) lifecycle management
// ---------------------------------------------------------------------------

import { exec } from 'child_process';
import * as https from 'https';
import * as fs from 'fs';
import * as os from 'os';
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
   * matching the friendly name pattern.  Prefers a device whose status is
   * OK (i.e. currently enabled) over one in an error/disconnected state.
   */
  private resolveVddInstanceId(): Promise<string> {
    return new Promise((resolve, reject) => {
      // Return all matching devices as "Status|InstanceId" lines so we can
      // pick the best candidate from TypeScript.
      const cmd = `powershell -NoProfile -Command "Get-PnpDevice -FriendlyName '${VDD_FRIENDLY_NAME_PATTERN}' -ErrorAction SilentlyContinue | ForEach-Object { $_.Status + '|' + $_.InstanceId }"`;
      exec(cmd, { timeout: 15000 }, (err, stdout) => {
        const lines = (stdout ?? '').trim().split('\n').map(l => l.trim()).filter(Boolean);
        if (lines.length === 0) {
          reject(new Error('VDD device not found. Ensure the Virtual Display Driver is installed.'));
          return;
        }

        // Prefer a device with Status "OK" (enabled); fall back to any other
        let bestLine = lines.find(l => l.startsWith('OK|')) ?? lines[0];
        const instanceId = bestLine.split('|').slice(1).join('|');

        if (instanceId) {
          this.output.appendLine(`[VDD] Resolved instance ID: ${instanceId} (from ${lines.length} candidate(s))`);
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
  // Virtual display detection
  // -------------------------------------------------------------------------

  /** Known hardware-ID substrings that identify virtual display monitors. */
  private static readonly VDD_HARDWARE_PATTERNS = [
    'SMKD',       // SudoMaker Virtual Display Adapter
    'MttVDD',     // MikeTheTech Virtual Display Driver
  ];

  /**
   * Identifies the virtual display by using Win32 `QueryDisplayConfig` to
   * map each GDI device name (e.g. `\\.\DISPLAY10`) to its monitor device
   * path which contains the hardware ID.  The virtual display is the one
   * whose path matches a known VDD pattern (e.g. "SMKD" for SudoMaker).
   *
   * This works regardless of how many physical monitors are connected.
   */
  async detectVirtualDisplayName(_dxgiInfoPath: string): Promise<string> {
    const mappings = await this.queryDisplayConfig();

    for (const m of mappings) {
      this.output.appendLine(`[VDD] ${m.gdiName} → ${m.monitorPath} (${m.friendlyName})`);
    }

    // Find the display whose monitor path matches a VDD hardware pattern
    for (const m of mappings) {
      const pathUpper = m.monitorPath.toUpperCase();
      for (const pattern of VirtualDisplayManager.VDD_HARDWARE_PATTERNS) {
        if (pathUpper.includes(pattern.toUpperCase())) {
          this.output.appendLine(`[VDD] Matched virtual display: ${m.gdiName} (pattern: ${pattern}, name: ${m.friendlyName})`);
          return m.gdiName;
        }
      }
    }

    this.output.appendLine('[VDD] No virtual display matched any known VDD hardware pattern.');
    return '';
  }

  /**
   * Uses Win32 `QueryDisplayConfig` + `DisplayConfigGetDeviceInfo` via
   * PowerShell P/Invoke to map each active GDI display name to its
   * monitor device path (which contains the hardware ID).
   */
  private queryDisplayConfig(): Promise<Array<{
    gdiName: string;
    friendlyName: string;
    monitorPath: string;
  }>> {
    // Write the P/Invoke script to a temp file to avoid all shell escaping
    // issues with $, quotes, and @ characters.
    const scriptPath = path.join(
      os.tmpdir(),
      `moo-capture-qdc-${process.pid}.ps1`,
    );

    const scriptContent = [
      'Add-Type -TypeDefinition @"',
      'using System;',
      'using System.Runtime.InteropServices;',
      'public class QDC {',
      '    public const uint QDC_ONLY_ACTIVE_PATHS = 2;',
      '    public const uint GET_SOURCE_NAME = 1;',
      '    public const uint GET_TARGET_NAME = 2;',
      '    [StructLayout(LayoutKind.Sequential)]',
      '    public struct LUID { public uint LowPart; public int HighPart; }',
      '    [StructLayout(LayoutKind.Sequential)]',
      '    public struct RATIONAL { public uint Num; public uint Den; }',
      '    [StructLayout(LayoutKind.Sequential)]',
      '    public struct PATH_SOURCE { public LUID adapterId; public uint id; public uint modeIdx; public uint flags; }',
      '    [StructLayout(LayoutKind.Sequential)]',
      '    public struct PATH_TARGET {',
      '        public LUID adapterId; public uint id; public uint modeIdx;',
      '        public uint outTech; public uint rot; public uint scale;',
      '        public RATIONAL refresh; public uint scanLine;',
      '        public int available; public uint flags;',
      '    }',
      '    [StructLayout(LayoutKind.Sequential)]',
      '    public struct PATH_INFO { public PATH_SOURCE src; public PATH_TARGET tgt; public uint flags; }',
      '    [StructLayout(LayoutKind.Sequential)]',
      '    public struct MODE_INFO {',
      '        public uint infoType; public uint id; public LUID adapterId;',
      '        [MarshalAs(UnmanagedType.ByValArray, SizeConst = 64)] public byte[] data;',
      '    }',
      '    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]',
      '    public struct SOURCE_NAME {',
      '        public uint type; public uint size; public LUID adapterId; public uint id;',
      '        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 32)] public string name;',
      '    }',
      '    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]',
      '    public struct TARGET_NAME {',
      '        public uint type; public uint size; public LUID adapterId; public uint id;',
      '        public uint flags; public uint outTech;',
      '        public ushort edidMfr; public ushort edidProd; public uint connInst;',
      '        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 64)] public string friendly;',
      '        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 128)] public string path;',
      '    }',
      '    [DllImport("user32.dll")] public static extern int GetDisplayConfigBufferSizes(uint f, out uint p, out uint m);',
      '    [DllImport("user32.dll")] public static extern int QueryDisplayConfig(uint f, ref uint np, [Out] PATH_INFO[] pa, ref uint nm, [Out] MODE_INFO[] ma, IntPtr t);',
      '    [DllImport("user32.dll")] public static extern int DisplayConfigGetDeviceInfo(ref SOURCE_NAME n);',
      '    [DllImport("user32.dll")] public static extern int DisplayConfigGetDeviceInfo(ref TARGET_NAME n);',
      '}',
      '"@',
      '$np=[uint32]0; $nm=[uint32]0',
      '[void][QDC]::GetDisplayConfigBufferSizes([QDC]::QDC_ONLY_ACTIVE_PATHS,[ref]$np,[ref]$nm)',
      '$pa=New-Object QDC+PATH_INFO[] $np; $ma=New-Object QDC+MODE_INFO[] $nm',
      '[void][QDC]::QueryDisplayConfig([QDC]::QDC_ONLY_ACTIVE_PATHS,[ref]$np,$pa,[ref]$nm,$ma,[IntPtr]::Zero)',
      'for($i=0;$i -lt $np;$i++){',
      '  $s=New-Object QDC+SOURCE_NAME',
      '  $s.type=[QDC]::GET_SOURCE_NAME',
      '  $s.size=[uint32][Runtime.InteropServices.Marshal]::SizeOf($s)',
      '  $s.adapterId=$pa[$i].src.adapterId; $s.id=$pa[$i].src.id',
      '  [void][QDC]::DisplayConfigGetDeviceInfo([ref]$s)',
      '  $t=New-Object QDC+TARGET_NAME',
      '  $t.type=[QDC]::GET_TARGET_NAME',
      '  $t.size=[uint32][Runtime.InteropServices.Marshal]::SizeOf($t)',
      '  $t.adapterId=$pa[$i].tgt.adapterId; $t.id=$pa[$i].tgt.id',
      '  [void][QDC]::DisplayConfigGetDeviceInfo([ref]$t)',
      '  Write-Output "$($s.name)|$($t.friendly)|$($t.path)"',
      '}',
    ].join('\n');

    fs.writeFileSync(scriptPath, scriptContent, 'utf-8');

    return new Promise((resolve, reject) => {
      const cmd = `powershell -NoProfile -ExecutionPolicy Bypass -File "${scriptPath}"`;
      exec(cmd, { timeout: 15000 }, (err, stdout) => {
        // Clean up temp file
        try { fs.unlinkSync(scriptPath); } catch { /* ok */ }

        if (err) {
          reject(new Error(`QueryDisplayConfig failed: ${err.message}`));
          return;
        }
        const results = stdout.trim().split('\n')
          .map(l => l.trim())
          .filter(Boolean)
          .map(line => {
            const parts = line.split('|');
            return {
              gdiName: parts[0] ?? '',
              friendlyName: parts[1] ?? '',
              monitorPath: parts[2] ?? '',
            };
          });
        resolve(results);
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
