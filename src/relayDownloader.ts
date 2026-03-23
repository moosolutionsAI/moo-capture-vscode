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
    onProgress?.('Ready');
    return this.binaryPath;
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
