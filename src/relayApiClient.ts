import * as http from 'http';
import type { OutputChannel } from 'vscode';
import type { RelayHost, RelayApp } from './types';

/**
 * HTTP API client for moonlight-web-stream.
 * Handles authentication, host management, and pairing.
 */
export class RelayApiClient {
  private sessionCookie: string | null = null;

  constructor(
    private readonly port: number,
    private readonly output: OutputChannel,
  ) {}

  /** Get the session cookie for WebSocket auth */
  get sessionToken(): string | null {
    return this.sessionCookie;
  }

  // -------------------------------------------------------------------------
  // Auth
  // -------------------------------------------------------------------------

  async login(username: string, password: string): Promise<void> {
    const { res, body } = await this.request('POST', '/api/login', { name: username, password });

    this.output.appendLine(`[Relay API] Login: ${res.statusCode} body="${body}"`);

    if (res.statusCode !== 200) {
      throw new Error(`Relay login failed (HTTP ${res.statusCode}): ${body}`);
    }

    // Extract session cookie — try parsed headers first, then raw
    const setCookie = res.headers['set-cookie'];
    if (setCookie) {
      for (const cookie of setCookie) {
        const match = cookie.match(/mlSession=([^;]+)/);
        if (match) {
          this.sessionCookie = match[1];
          this.output.appendLine(`[Relay API] Cookie: ${this.sessionCookie.substring(0, 16)}...`);
          return;
        }
      }
    }

    // Fallback: scan raw headers
    for (let i = 0; i < res.rawHeaders.length - 1; i += 2) {
      if (res.rawHeaders[i].toLowerCase() === 'set-cookie') {
        const match = res.rawHeaders[i + 1].match(/mlSession=([^;]+)/);
        if (match) {
          this.sessionCookie = match[1];
          this.output.appendLine(`[Relay API] Cookie (raw): ${this.sessionCookie.substring(0, 16)}...`);
          return;
        }
      }
    }

    this.output.appendLine('[Relay API] WARNING: No session cookie in response');
  }

  // -------------------------------------------------------------------------
  // Host management
  // -------------------------------------------------------------------------

  /**
   * List hosts. The /api/hosts endpoint is streaming NDJSON.
   * The first line contains {"hosts": [...]}, subsequent lines are live updates.
   * We read only what arrives in the first 2 seconds, then close.
   */
  async listHosts(): Promise<RelayHost[]> {
    const body = await this.getStreaming('/api/hosts', 2000);
    this.output.appendLine(`[Relay API] Hosts: ${body.substring(0, 500)}`);

    const hosts: RelayHost[] = [];
    for (const line of body.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) { continue; }
      try {
        const data = JSON.parse(trimmed);
        if (data.hosts && Array.isArray(data.hosts)) {
          hosts.push(...data.hosts);
        } else if (data.host_id !== undefined) {
          hosts.push(data as RelayHost);
        }
      } catch { /* skip non-JSON lines */ }
    }
    return hosts;
  }

  /** Add a new Sunshine host */
  async addHost(address: string, httpPort: number): Promise<RelayHost> {
    const { res, body } = await this.request('POST', '/api/host', { address, http_port: httpPort });
    this.output.appendLine(`[Relay API] Add host: ${res.statusCode} ${body.substring(0, 300)}`);

    if (res.statusCode !== 200) {
      throw new Error(`Failed to add host (HTTP ${res.statusCode}): ${body}`);
    }

    const data = JSON.parse(body);
    return (data.host ?? data) as RelayHost;
  }

  /** List apps on a host. Requires the host to be paired. */
  async listApps(hostId: number): Promise<RelayApp[]> {
    const { res, body } = await this.request('GET', `/api/apps?host_id=${hostId}`);
    this.output.appendLine(`[Relay API] Apps: ${res.statusCode} ${body.substring(0, 200)}`);

    if (res.statusCode !== 200) {
      throw new Error(`Failed to list apps (HTTP ${res.statusCode}): ${body}`);
    }

    const data = JSON.parse(body);
    const rawApps = data.apps ?? [];
    // API returns "app_id" and "title", normalize to our RelayApp type
    return rawApps.map((a: Record<string, unknown>) => ({
      id: a.app_id ?? a.id ?? 0,
      name: a.title ?? a.name ?? 'Unknown',
    })) as RelayApp[];
  }

  /** Cancel any active stream on a host */
  async cancelStream(hostId: number): Promise<void> {
    const { res, body } = await this.request('POST', '/api/host/cancel', { host_id: hostId });
    this.output.appendLine(`[Relay API] Cancel stream: ${res.statusCode} ${body}`);
  }

  // -------------------------------------------------------------------------
  // Pairing
  // -------------------------------------------------------------------------

  /**
   * Pair with a Sunshine host. Streams NDJSON:
   *   1. {"Pin": "1234"} — generated PIN the user must enter in Sunshine
   *   2. {"Paired": {...}} or {"PairError": null}
   */
  async pair(
    hostId: number,
    onPin: (pin: string) => void,
  ): Promise<RelayHost> {
    return new Promise((resolve, reject) => {
      const body = JSON.stringify({ host_id: hostId });
      const options: http.RequestOptions = {
        hostname: '127.0.0.1',
        port: this.port,
        path: '/api/pair',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body),
          ...this.authHeaders(),
        },
        timeout: 120000, // Pairing can take a while — user needs to enter PIN
        agent: false, // Bypass VS Code/Cursor proxy-patched globalAgent
      };

      const req = http.request(options, (res) => {
        let buffer = '';

        res.on('data', (chunk: Buffer) => {
          buffer += chunk.toString();

          // Parse NDJSON lines as they arrive
          const lines = buffer.split('\n');
          buffer = lines.pop() ?? '';

          for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed) { continue; }

            try {
              const msg = JSON.parse(trimmed);
              this.output.appendLine(`[Relay API] Pair message: ${JSON.stringify(msg)}`);

              if ('Pin' in msg) {
                onPin(msg.Pin);
              } else if ('Paired' in msg) {
                this.output.appendLine('[Relay API] Paired successfully');
                resolve(msg.Paired as RelayHost);
              } else if ('PairError' in msg) {
                reject(new Error('Pairing failed. Make sure you entered the correct PIN in Vibeshine.'));
              }
            } catch {
              this.output.appendLine(`[Relay API] Pair: unparseable line: ${trimmed.substring(0, 100)}`);
            }
          }
        });

        res.on('end', () => {
          // Handle remaining buffer
          const trimmed = buffer.trim();
          if (trimmed) {
            try {
              const msg = JSON.parse(trimmed);
              if ('Paired' in msg) {
                resolve(msg.Paired as RelayHost);
              } else if ('PairError' in msg) {
                reject(new Error('Pairing failed.'));
              }
            } catch { /* ignore */ }
          }
        });

        res.on('error', reject);
      });

      req.on('error', reject);
      req.on('timeout', () => {
        req.destroy();
        reject(new Error('Pairing timed out. Make sure Vibeshine is running and you entered the PIN.'));
      });

      req.write(body);
      req.end();
    });
  }

  // -------------------------------------------------------------------------
  // HTTP helpers
  // -------------------------------------------------------------------------

  private authHeaders(): Record<string, string> {
    const headers: Record<string, string> = {};
    if (this.sessionCookie) {
      headers['Cookie'] = `mlSession=${this.sessionCookie}`;
    }
    return headers;
  }

  /**
   * Make an HTTP request and return status + body.
   * Uses 127.0.0.1 (not localhost) to avoid IPv6 resolution issues.
   */
  private request(
    method: string,
    urlPath: string,
    data?: unknown,
  ): Promise<{ res: http.IncomingMessage; body: string }> {
    return new Promise((resolve, reject) => {
      const bodyStr = data ? JSON.stringify(data) : undefined;
      const headers: Record<string, string> = {
        ...this.authHeaders(),
      };
      if (bodyStr) {
        headers['Content-Type'] = 'application/json';
        headers['Content-Length'] = String(Buffer.byteLength(bodyStr));
      }

      const options: http.RequestOptions = {
        hostname: '127.0.0.1',
        port: this.port,
        path: urlPath,
        method,
        headers,
        timeout: 15000,
        agent: false, // Bypass VS Code/Cursor proxy-patched globalAgent
      };

      this.output.appendLine(`[Relay API] ${method} ${urlPath} (auth: ${this.sessionCookie ? 'yes' : 'no'})`);

      const req = http.request(options, (res) => {
        let body = '';
        res.on('data', (chunk: Buffer) => { body += chunk.toString(); });
        res.on('end', () => resolve({ res, body }));
        res.on('error', reject);
      });

      req.on('error', reject);
      req.on('timeout', () => {
        req.destroy();
        reject(new Error(`Request to ${urlPath} timed out`));
      });

      if (bodyStr) {
        req.write(bodyStr);
      }
      req.end();
    });
  }

  /**
   * GET a streaming NDJSON endpoint. Reads data for up to `timeoutMs`,
   * then closes the connection and returns whatever was received.
   * This prevents hanging on never-ending streaming endpoints like /api/hosts.
   */
  private getStreaming(urlPath: string, timeoutMs: number): Promise<string> {
    return new Promise((resolve, reject) => {
      const options: http.RequestOptions = {
        hostname: '127.0.0.1',
        port: this.port,
        path: urlPath,
        method: 'GET',
        headers: this.authHeaders(),
        agent: false, // Bypass VS Code/Cursor proxy-patched globalAgent
      };

      this.output.appendLine(`[Relay API] GET (streaming) ${urlPath} (auth: ${this.sessionCookie ? 'yes' : 'no'})`);

      const req = http.request(options, (res) => {
        if (res.statusCode !== 200) {
          let body = '';
          res.on('data', (chunk: Buffer) => { body += chunk.toString(); });
          res.on('end', () => reject(new Error(`HTTP ${res.statusCode}: ${body}`)));
          return;
        }

        let data = '';
        const timer = setTimeout(() => {
          // Collected enough data from the stream, close it
          req.destroy();
          resolve(data);
        }, timeoutMs);

        res.on('data', (chunk: Buffer) => { data += chunk.toString(); });
        res.on('end', () => {
          clearTimeout(timer);
          resolve(data);
        });
        res.on('error', () => {
          // If error happens after we have data, resolve with what we got
          clearTimeout(timer);
          if (data) {
            resolve(data);
          } else {
            reject(new Error(`Streaming request to ${urlPath} failed`));
          }
        });
      });

      req.on('error', reject);
      req.end();
    });
  }
}
