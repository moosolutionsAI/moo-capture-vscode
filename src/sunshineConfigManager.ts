// ---------------------------------------------------------------------------
// Vibeshine REST API configuration manager
// (Vibeshine is a Sunshine fork — same REST API, same port)
// ---------------------------------------------------------------------------

import * as https from 'https';
import type { OutputChannel } from 'vscode';
import { VIBESHINE_API_PORT } from './constants';

/**
 * Manages interaction with Vibeshine's REST API for reading and updating
 * application configuration (apps.json). API-compatible with Sunshine.
 */
export class SunshineConfigManager {
  constructor(private readonly output: OutputChannel) {}

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  /**
   * Fetches the list of configured Sunshine apps via the REST API.
   *
   * GET https://localhost:47990/api/apps (Vibeshine REST API)
   *
   * @returns Array of app objects from the Sunshine configuration.
   */
  async getSunshineApps(username: string, password: string): Promise<{ env: any; apps: any[] }> {
    const data = await this.apiRequest('GET', '/api/apps', username, password);
    const parsed = JSON.parse(data);
    // The API returns { env: {}, apps: [...] }
    return { env: parsed.env ?? {}, apps: parsed.apps || [] };
  }

  /**
   * Saves each app individually via the Sunshine REST API.
   *
   * Sunshine's POST /api/apps expects a single app object per request
   * (not the batched `{env, apps}` format returned by GET).
   */
  async updateSunshineApps(
    username: string,
    password: string,
    _env: any,
    apps: any[],
  ): Promise<void> {
    for (const app of apps) {
      // Sunshine expects numeric fields as actual numbers, not strings
      const sanitized = { ...app };
      if (typeof sanitized.index === 'string') {
        sanitized.index = Number(sanitized.index);
      }

      const body = JSON.stringify(sanitized);
      this.output.appendLine(`[VibeshineConfig] POST app "${sanitized.name}": ${body}`);
      await this.apiRequest('POST', '/api/apps', username, password, body);
      this.output.appendLine(`[VibeshineConfig] App "${sanitized.name}" saved.`);
    }
  }

  /**
   * Modifies each app in the array to add/update `prep-cmd` entries and the
   * `output` field for headless virtual display streaming.
   *
   * - Adds (or replaces) a prep-cmd with the setup/teardown scripts.
   * - Sets the `output` field to the virtual display name so Sunshine
   *   captures from the correct monitor.
   *
   * @returns A new apps array with the modifications applied.
   */
  addPrepCommandsToApps(
    apps: any[],
    doScriptPath: string,
    undoScriptPath: string,
  ): any[] {
    const doCmd = `powershell.exe -ExecutionPolicy Bypass -WindowStyle Hidden -File "${doScriptPath.replace(/\\/g, '\\\\')}"`;
    const undoCmd = `powershell.exe -ExecutionPolicy Bypass -WindowStyle Hidden -File "${undoScriptPath.replace(/\\/g, '\\\\')}"`;

    const mooPrepCmd = {
      do: doCmd,
      undo: undoCmd,
      elevated: false,
    };

    return apps.map((app) => {
      const updated = { ...app };

      // Get existing prep-cmd array or create one
      const existingPrepCmds: any[] = Array.isArray(updated['prep-cmd'])
        ? [...updated['prep-cmd']]
        : [];

      // Remove any existing Moo Capture prep-cmd entries (identified by
      // the presence of our script filenames)
      const filtered = existingPrepCmds.filter(
        (cmd) =>
          !cmd.do?.includes('moo-capture') &&
          !cmd.do?.includes('setup.ps1'),
      );

      // Add our prep-cmd at the beginning so it runs first
      filtered.unshift(mooPrepCmd);
      updated['prep-cmd'] = filtered;

      // Use Vibeshine's built-in virtual display instead of targeting a
      // specific physical display.  This tells Vibeshine to create and
      // capture from its own headless virtual display automatically.
      updated['virtual-screen'] = true;
      updated['virtual-display-layout'] = 'extended';
      // Remove any stale output override — let Vibeshine manage the display
      delete updated.output;

      return updated;
    });
  }

  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------

  private apiRequest(
    method: string,
    path: string,
    username: string,
    password: string,
    body?: string,
  ): Promise<string> {
    return new Promise((resolve, reject) => {
      const auth = Buffer.from(`${username}:${password}`).toString('base64');

      const options: https.RequestOptions = {
        hostname: 'localhost',
        port: VIBESHINE_API_PORT,
        path,
        method,
        rejectUnauthorized: false, // Sunshine uses a self-signed cert
        headers: {
          Authorization: `Basic ${auth}`,
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
      };

      if (body) {
        options.headers!['Content-Length'] = Buffer.byteLength(body).toString();
      }

      const req = https.request(options, (res) => {
        let data = '';
        res.on('data', (chunk: Buffer) => {
          data += chunk.toString();
        });
        res.on('end', () => {
          if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
            resolve(data);
          } else {
            const msg = `Sunshine API ${method} ${path} returned ${res.statusCode}: ${data}`;
            this.output.appendLine(`[VibeshineConfig] ${msg}`);
            reject(new Error(msg));
          }
        });
      });

      req.on('error', (err) => {
        this.output.appendLine(`[VibeshineConfig] Request error: ${err.message}`);
        reject(err);
      });

      req.setTimeout(10000, () => {
        req.destroy(new Error('Sunshine API request timed out'));
      });

      if (body) {
        req.write(body);
      }
      req.end();
    });
  }
}
