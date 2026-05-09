import { ChildProcess, spawn } from 'child_process';
import * as http from 'http';
import * as fs from 'fs';
import * as path from 'path';
import type { OutputChannel } from 'vscode';
import {
  RELAY_DEFAULT_PORT,
  RELAY_HEALTH_CHECK_INTERVAL_MS,
  RELAY_RESTART_BACKOFF_MS,
  RELAY_MAX_RETRIES,
  RELAY_STARTUP_TIMEOUT_MS,
} from './constants';

export class RelayManager {
  private process: ChildProcess | null = null;
  private healthInterval: ReturnType<typeof setInterval> | null = null;
  private retryCount = 0;
  private stopping = false;

  constructor(private readonly output: OutputChannel) {}

  /**
   * Start the moonlight-web-stream relay process.
   * @param binaryPath Path to the web-server executable
   * @param port Port to bind to
   * @param dataDir Directory for relay config and data
   */
  async start(binaryPath: string, port: number, dataDir: string): Promise<void> {
    if (this.process) {
      this.output.appendLine('[Relay] Already running (has process ref)');
      return;
    }

    // Kill any stale relay processes from previous sessions so we always
    // start fresh (avoids zombie relays that can't reach Vibeshine)
    await this.killStaleRelayProcesses(binaryPath);

    this.stopping = false;
    this.retryCount = 0;
    this.lastBinaryPath = binaryPath;

    // Write config for moonlight-web-stream
    this.writeConfig(dataDir, port);

    await this.spawnRelay(binaryPath, port, dataDir);
  }

  /**
   * Kill any orphaned web-server.exe AND streamer.exe processes from
   * previous sessions.
   *
   * Streamer.exe is the moonlight-web-stream child that holds the UDP
   * socket to Sunshine. It is NOT job-parented to web-server.exe, so a
   * parent kill leaves the child running — 2026-05-09 PID 44080 was a
   * confirmed orphan that contributed to the 16:27 collision class.
   *
   * Path filter scopes the kill to processes whose .Path contains our
   * relay install directory, so we never disturb an unrelated 'streamer'
   * process a user might happen to run. Forward-slash normalisation
   * sidesteps backslash escaping through the JS-template-to-PowerShell
   * boundary.
   */
  private killStaleRelayProcesses(binaryPath: string): Promise<void> {
    return new Promise((resolve) => {
      const { exec } = require('child_process') as typeof import('child_process');
      const binaryName = path.basename(binaryPath, '.exe');
      const installDirFwd = path.dirname(binaryPath).replace(/\\/g, '/').toLowerCase();
      const psCmd =
        `Get-Process -Name '${binaryName}','streamer' -ErrorAction SilentlyContinue | ` +
        `Where-Object { $_.Path -and ($_.Path.Replace('\\','/').ToLower().StartsWith('${installDirFwd}/')) } | ` +
        `Stop-Process -Force`;
      exec(
        `powershell -NoProfile -Command "${psCmd}"`,
        { timeout: 5000 },
        (err) => {
          if (!err) {
            this.output.appendLine('[Relay] Killed stale relay + streamer processes');
          }
          resolve();
        },
      );
    });
  }

  private writeConfig(dataDir: string, port: number): void {
    const configDir = path.join(dataDir, 'server');
    fs.mkdirSync(configDir, { recursive: true });

    // Ensure relay data directory exists (for its database)
    const relayDataDir = path.join(dataDir, 'relay', 'data');
    fs.mkdirSync(relayDataDir, { recursive: true });

    // data.json path must be relative to CWD (the relay directory)
    const dataJsonPath = path.join(configDir, 'data.json').replace(/\\/g, '/');

    // Preserve default_user_id if already set, or read from data.json
    let defaultUserId: number | null = null;
    const configPath = path.join(configDir, 'config.json');
    if (fs.existsSync(configPath)) {
      try {
        const existing = JSON.parse(fs.readFileSync(configPath, 'utf8'));
        if (existing.web_server?.default_user_id) {
          defaultUserId = existing.web_server.default_user_id;
        }
      } catch { /* ignore */ }
    }
    if (!defaultUserId && fs.existsSync(dataJsonPath)) {
      try {
        const data = JSON.parse(fs.readFileSync(dataJsonPath, 'utf8'));
        const userIds = Object.keys(data.users || {});
        if (userIds.length > 0) {
          defaultUserId = parseInt(userIds[0], 10);
        }
      } catch { /* ignore */ }
    }

    const config = {
      data_storage: {
        type: 'json',
        path: dataJsonPath,
        session_expiration_check_interval: { secs: 300, nanos: 0 },
      },
      web_server: {
        bind_address: `127.0.0.1:${port}`,
        first_login_create_admin: true,
        first_login_assign_global_hosts: true,
        session_cookie_secure: false,
        session_cookie_expiration: { secs: 86400, nanos: 0 },
        default_user_id: defaultUserId,
      },
      streamer_path: './streamer',
      webrtc: {
        port_range: { min: 40000, max: 40010 },
        ice_servers: [],
        network_types: ['udp4'],
        include_loopback_candidates: true,
        disabled: true,  // Force WebSocket transport — WebRTC ICE fails on localhost
      },
      moonlight: {
        default_http_port: 47989,
        pair_device_name: 'moo-capture',
      },
      log: {
        level_filter: 'INFO',
        file_path: null,
      },
    };

    fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
    this.output.appendLine(`[Relay] Config written to ${configPath}`);
  }

  private async spawnRelay(binaryPath: string, port: number, dataDir: string): Promise<void> {
    this.output.appendLine(`[Relay] Starting: ${binaryPath}`);

    const configPath = path.join(dataDir, 'server', 'config.json');

    const args = [
      '--config-path', configPath,
      '--bind-address', `127.0.0.1:${port}`,
    ];
    this.output.appendLine(`[Relay] Args: ${args.join(' ')}`);
    this.output.appendLine(`[Relay] CWD: ${dataDir}`);

    // CWD must be the relay directory so it finds static/ and writes data/ correctly
    const relayCwd = path.dirname(binaryPath);
    this.output.appendLine(`[Relay] CWD: ${relayCwd}`);

    this.process = spawn(binaryPath, args, {
      cwd: relayCwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });

    this.process.stdout?.on('data', (data: Buffer) => {
      this.output.appendLine(`[Relay] ${data.toString().trim()}`);
    });

    this.process.stderr?.on('data', (data: Buffer) => {
      this.output.appendLine(`[Relay ERR] ${data.toString().trim()}`);
    });

    this.process.on('exit', (code) => {
      this.output.appendLine(`[Relay] Process exited with code ${code}`);
      this.process = null;
      this.stopHealthCheck();

      if (!this.stopping && this.retryCount < RELAY_MAX_RETRIES) {
        const delay = RELAY_RESTART_BACKOFF_MS[Math.min(this.retryCount, RELAY_RESTART_BACKOFF_MS.length - 1)];
        this.retryCount++;
        this.output.appendLine(`[Relay] Restarting in ${delay}ms (attempt ${this.retryCount}/${RELAY_MAX_RETRIES})`);
        setTimeout(() => {
          if (!this.stopping) {
            this.spawnRelay(binaryPath, port, dataDir).catch((err) => {
              this.output.appendLine(`[Relay] Restart failed: ${err}`);
            });
          }
        }, delay);
      }
    });

    // Wait for relay to become healthy
    await this.waitForHealthy(port);
    this.startHealthCheck(port);
  }

  /** Poll relay's HTTP endpoint until it responds */
  private waitForHealthy(port: number): Promise<void> {
    return new Promise((resolve, reject) => {
      const start = Date.now();
      const check = () => {
        if (Date.now() - start > RELAY_STARTUP_TIMEOUT_MS) {
          reject(new Error(`Relay did not become healthy within ${RELAY_STARTUP_TIMEOUT_MS}ms`));
          return;
        }
        this.isHealthy(port)
          .then((ok) => {
            if (ok) {
              this.output.appendLine('[Relay] Healthy and ready');
              resolve();
            } else {
              setTimeout(check, 500);
            }
          })
          .catch(() => setTimeout(check, 500));
      };
      check();
    });
  }

  /** Check if relay's HTTP server is responding */
  private isHealthy(port: number): Promise<boolean> {
    return new Promise((resolve) => {
      const req = http.get(`http://localhost:${port}/`, { timeout: 2000 }, (res) => {
        res.resume();
        resolve(res.statusCode !== undefined);
      });
      req.on('error', () => resolve(false));
      req.on('timeout', () => {
        req.destroy();
        resolve(false);
      });
    });
  }

  /** Periodic health monitoring */
  private startHealthCheck(port: number): void {
    this.healthInterval = setInterval(async () => {
      const ok = await this.isHealthy(port);
      if (!ok && !this.stopping) {
        this.output.appendLine('[Relay] Health check failed');
      }
    }, RELAY_HEALTH_CHECK_INTERVAL_MS);
  }

  private stopHealthCheck(): void {
    if (this.healthInterval) {
      clearInterval(this.healthInterval);
      this.healthInterval = null;
    }
  }

  /**
   * Update the relay config to set default_user_id so the web UI
   * doesn't require login (needed because iframe can't set cookies).
   * Requires a relay restart to take effect.
   */
  async setDefaultUser(dataDir: string, port: number): Promise<void> {
    const configPath = path.join(dataDir, 'server', 'config.json');
    const dataJsonPath = path.join(dataDir, 'server', 'data.json');

    if (!fs.existsSync(dataJsonPath)) {
      this.output.appendLine('[Relay] No data.json yet, skipping default_user_id');
      return;
    }

    // Read user ID from data.json
    const data = JSON.parse(fs.readFileSync(dataJsonPath, 'utf8'));
    const userIds = Object.keys(data.users || {});
    if (userIds.length === 0) {
      this.output.appendLine('[Relay] No users in data.json');
      return;
    }

    const userId = parseInt(userIds[0], 10);
    this.output.appendLine(`[Relay] Setting default_user_id to ${userId}`);

    // Read and update config
    const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    if (config.web_server.default_user_id === userId) {
      this.output.appendLine('[Relay] default_user_id already set');
      return;
    }

    config.web_server.default_user_id = userId;
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2));

    // Restart relay to pick up new config
    this.output.appendLine('[Relay] Restarting relay with default_user_id...');
    this.stop();
    await new Promise(resolve => setTimeout(resolve, 1000));
    await this.start(this.lastBinaryPath!, port, dataDir);
  }

  private lastBinaryPath: string | undefined;

  /** Stop the relay process */
  stop(): void {
    this.stopping = true;
    this.stopHealthCheck();
    if (this.process) {
      this.output.appendLine('[Relay] Stopping');
      this.process.kill();
      this.process = null;
    }
  }

  get isRunning(): boolean {
    return this.process !== null;
  }
}
