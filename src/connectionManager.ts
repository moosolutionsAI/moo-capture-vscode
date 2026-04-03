import type { OutputChannel } from 'vscode';
import { RelayManager } from './relayManager';
import { RelayDownloader } from './relayDownloader';
import { RelayApiClient } from './relayApiClient';
import { SunshineConfigManager } from './sunshineConfigManager';
import {
  RELAY_DEFAULT_PORT,
  RELAY_INTERNAL_USER,
  RELAY_INTERNAL_PASS,
} from './constants';
import type { ConnectionState, MooCaptureConfig, RelayHost } from './types';

export class ConnectionManager {
  private state: ConnectionState = 'disconnected';
  private readonly relay: RelayManager;
  private readonly downloader: RelayDownloader;
  private apiClient: RelayApiClient | null = null;
  private lastHostId: number | null = null;
  private onStateChange?: (state: ConnectionState, message?: string) => void;

  private sunshineConfig: SunshineConfigManager | null = null;

  /** Vibeshine REST API credentials (set externally before connect if headless). */
  vibeshineUsername: string = '';
  vibeshinePassword: string = '';

  /** Apps cached from Vibeshine REST API — used as fallback when relay listApps times out. */
  private cachedVibeshineApps: import('./types').RelayApp[] = [];

  constructor(
    private readonly output: OutputChannel,
    private readonly globalStoragePath: string,
  ) {
    this.relay = new RelayManager(output);
    this.downloader = new RelayDownloader(globalStoragePath, output);
  }

  onState(cb: (state: ConnectionState, message?: string) => void): void {
    this.onStateChange = cb;
  }

  private setState(state: ConnectionState, message?: string): void {
    this.state = state;
    this.onStateChange?.(state, message);
  }

  // -------------------------------------------------------------------------
  // Main connection flow — returns relay port for iframe embedding
  // -------------------------------------------------------------------------

  async connect(
    config: MooCaptureConfig,
    onNeedPairPin: (pin: string) => void,
  ): Promise<{ port: number; hostId: number; apps: import('./types').RelayApp[] }> {
    try {
      let port = config.relayPort || RELAY_DEFAULT_PORT;

      // Step 1: Ensure relay binary exists
      if (!this.downloader.isInstalled()) {
        this.setState('downloading_relay', 'Downloading streaming relay...');
        await this.downloader.download((msg) => {
          this.setState('downloading_relay', msg);
        });
      }

      // Step 2: Start relay (try alternative ports if default is taken)
      this.setState('starting_relay', 'Starting streaming relay...');
      if (!this.relay.isRunning) {
        const maxPortAttempts = 5;
        for (let attempt = 0; attempt < maxPortAttempts; attempt++) {
          try {
            await this.relay.start(
              this.downloader.binaryPath,
              port + attempt,
              this.globalStoragePath,
            );
            port = port + attempt;
            break;
          } catch (startErr) {
            const msg = startErr instanceof Error ? startErr.message : String(startErr);
            if (msg.includes('10048') || msg.includes('address already in use')) {
              this.output.appendLine(`[Connect] Port ${port + attempt} in use, trying ${port + attempt + 1}...`);
              if (attempt === maxPortAttempts - 1) { throw startErr; }
            } else {
              throw startErr;
            }
          }
        }
      }

      // Step 3: Login
      this.apiClient = new RelayApiClient(port, this.output);
      await this.apiClient.login(RELAY_INTERNAL_USER, RELAY_INTERNAL_PASS);

      // Step 4: Ensure host is added AND paired
      let host = await this.ensureHostPaired(config, onNeedPairPin);

      // Step 4.5: Headless virtual display setup (non-blocking on failure)
      if (config.headlessMode) {
        try {
          await this.setupHeadlessDisplay(config);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          this.output.appendLine(`[Connect] Headless display setup failed (falling back to normal): ${msg}`);
        }
      }

      // Step 5: Get apps list — try relay first, fall back to cached Vibeshine apps
      this.lastHostId = host.host_id;
      let apps: import('./types').RelayApp[];
      try {
        apps = await this.apiClient.listApps(host.host_id);
      } catch (appErr) {
        const appMsg = appErr instanceof Error ? appErr.message : String(appErr);
        if (appMsg.includes('HTTP')) {
          this.output.appendLine(`[Connect] listApps failed (${appMsg}) — pairing may be stale. Re-pairing...`);
          this.setState('pairing', 'Re-pairing with Vibeshine...');
          host = await this.apiClient.pair(host.host_id, onNeedPairPin);
          apps = await this.apiClient.listApps(host.host_id);
        } else if (this.cachedVibeshineApps.length > 0) {
          this.output.appendLine(`[Connect] Relay listApps timed out — using ${this.cachedVibeshineApps.length} app(s) from Vibeshine REST API.`);
          apps = this.cachedVibeshineApps;
        } else {
          throw appErr;
        }
      }
      this.output.appendLine(`[Connect] Apps: ${apps.map(a => a.name).join(', ')}`);

      this.setState('streaming', 'Connected');
      return { port, hostId: host.host_id, apps };

    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.output.appendLine(`[Connect] Error: ${msg}`);
      this.setState('error', msg);
      // Reset to disconnected so user can retry
      this.setState('disconnected');
      throw err;
    }
  }

  // -------------------------------------------------------------------------
  // Headless virtual display setup
  // -------------------------------------------------------------------------

  private async setupHeadlessDisplay(_config: MooCaptureConfig): Promise<void> {
    this.setState('setting_up_display', 'Configuring Vibeshine virtual display...');

    this.sunshineConfig = new SunshineConfigManager(this.output);

    // Update Vibeshine apps via REST API to use the built-in virtual display.
    // No prep-cmd scripts needed — Vibeshine's display helper manages the
    // virtual display lifecycle when virtual-screen=true.
    if (this.vibeshineUsername && this.vibeshinePassword) {
      try {
        const { env, apps } = await this.sunshineConfig.getSunshineApps(
          this.vibeshineUsername,
          this.vibeshinePassword,
        );

        this.output.appendLine(`[Connect] Found ${apps.length} Vibeshine app(s). Configuring virtual display...`);

        const updatedApps = this.sunshineConfig.addPrepCommandsToApps(apps);

        await this.sunshineConfig.updateSunshineApps(
          this.vibeshineUsername,
          this.vibeshinePassword,
          env,
          updatedApps,
        );

        this.output.appendLine('[Connect] Vibeshine apps configured for virtual display.');

        // Cache the apps so we can use them if the relay's listApps times out
        this.cachedVibeshineApps = apps.map((a: any) => ({
          id: Number(a.id) || 0,
          name: a.name || 'Unknown',
        }));
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        this.output.appendLine(`[Connect] Failed to update Vibeshine apps: ${msg}`);
        if (msg.includes('401') || msg.includes('Unauthorized')) {
          // Clear stale credentials so user is prompted again next time
          this.vibeshineUsername = '';
          this.vibeshinePassword = '';
          this.output.appendLine('[Connect] Vibeshine credentials rejected — will prompt for new credentials on next connect.');
        }
      }
    } else {
      this.output.appendLine('[Connect] No Vibeshine credentials — scripts written but apps not auto-configured.');
    }
  }

  // -------------------------------------------------------------------------
  // Host setup: add if missing, pair if unpaired
  // -------------------------------------------------------------------------

  private async ensureHostPaired(
    config: MooCaptureConfig,
    onNeedPairPin: (pin: string) => void,
  ): Promise<RelayHost> {
    if (!this.apiClient) { throw new Error('Not logged in'); }

    // List existing hosts — deduplicate by host_id (the relay's SSE stream
    // can return the same host multiple times)
    const rawHosts = await this.apiClient.listHosts();
    const seen = new Set<number>();
    const hosts = rawHosts.filter(h => {
      if (seen.has(h.host_id)) { return false; }
      seen.add(h.host_id);
      return true;
    });
    this.output.appendLine(`[Connect] Found ${hosts.length} host(s): ${JSON.stringify(hosts.map(h => ({ id: h.host_id, name: h.name, paired: h.paired })))}`);

    let host = hosts.length > 0 ? hosts[0] : null;

    if (!host) {
      // No hosts at all — add one (retry up to 3 times; Vibeshine may drop
      // the first connection before the response is fully read)
      this.output.appendLine(`[Connect] Adding host: ${config.sunshineHost}:${config.sunshinePort}`);
      for (let attempt = 1; attempt <= 3; attempt++) {
        try {
          host = await this.apiClient.addHost(config.sunshineHost, config.sunshinePort);
          this.output.appendLine(`[Connect] Host added: ${host.name} (id=${host.host_id}, paired=${host.paired})`);
          break;
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          if (attempt < 3 && msg.includes('IncompleteMessage')) {
            this.output.appendLine(`[Connect] addHost attempt ${attempt} failed (IncompleteMessage), retrying in 1s...`);
            await new Promise(r => setTimeout(r, 1000));
          } else {
            throw err;
          }
        }
      }
      if (!host) { throw new Error('Failed to add host after 3 attempts'); }
    }

    // Pair if needed
    if (host.paired === 'NotPaired') {
      this.setState('pairing', 'Pairing with Vibeshine — check for PIN prompt...');
      this.output.appendLine(`[Connect] Host ${host.host_id} not paired, starting pairing...`);

      host = await this.apiClient.pair(host.host_id, (pin) => {
        this.output.appendLine(`[Connect] Pairing PIN: ${pin}`);
        onNeedPairPin(pin);
      });

      this.output.appendLine(`[Connect] Pairing complete: ${host.name} (id=${host.host_id})`);
    } else {
      this.output.appendLine(`[Connect] Host already paired: ${host.name} (id=${host.host_id})`);
    }

    return host;
  }

  disconnect(): void {
    // Cancel the active stream on the host so streamer.exe stops
    if (this.apiClient && this.lastHostId) {
      this.apiClient.cancelStream(this.lastHostId).catch(() => {});
      this.output.appendLine(`[Disconnect] Cancelled stream on host ${this.lastHostId}`);
    }

    this.sunshineConfig = null;

    this.setState('disconnected');
  }

  dispose(): void {
    this.disconnect();
    this.relay.stop();
  }

  get currentState(): ConnectionState {
    return this.state;
  }
}
