import * as fs from 'fs';
import * as path from 'path';
import type { OutputChannel } from 'vscode';
import { RelayManager } from './relayManager';
import { RelayDownloader } from './relayDownloader';
import { RelayApiClient } from './relayApiClient';
import { VirtualDisplayManager } from './virtualDisplayManager';
import { SunshineConfigManager } from './sunshineConfigManager';
import {
  generateSetupScript,
  generateTeardownScript,
  generateWatchdogScript,
} from './displayScripts';
import {
  RELAY_DEFAULT_PORT,
  RELAY_INTERNAL_USER,
  RELAY_INTERNAL_PASS,
  SUNSHINE_DXGI_INFO,
} from './constants';
import type { ConnectionState, MooCaptureConfig, RelayHost } from './types';

export class ConnectionManager {
  private state: ConnectionState = 'disconnected';
  private readonly relay: RelayManager;
  private readonly downloader: RelayDownloader;
  private apiClient: RelayApiClient | null = null;
  private lastHostId: number | null = null;
  private onStateChange?: (state: ConnectionState, message?: string) => void;

  private vdm: VirtualDisplayManager | null = null;
  private sunshineConfig: SunshineConfigManager | null = null;

  /** Sunshine REST API credentials (set externally before connect if headless). */
  sunshineUsername: string = '';
  sunshinePassword: string = '';

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
      const port = config.relayPort || RELAY_DEFAULT_PORT;

      // Step 1: Ensure relay binary exists
      if (!this.downloader.isInstalled()) {
        this.setState('downloading_relay', 'Downloading streaming relay...');
        await this.downloader.download((msg) => {
          this.setState('downloading_relay', msg);
        });
      }

      // Step 2: Start relay
      this.setState('starting_relay', 'Starting streaming relay...');
      if (!this.relay.isRunning) {
        await this.relay.start(
          this.downloader.binaryPath,
          port,
          this.globalStoragePath,
        );
      }

      // Step 3: Login
      this.apiClient = new RelayApiClient(port, this.output);
      await this.apiClient.login(RELAY_INTERNAL_USER, RELAY_INTERNAL_PASS);

      // Step 4: Ensure host is added AND paired
      const host = await this.ensureHostPaired(config, onNeedPairPin);

      // Step 4.5: Headless virtual display setup (non-blocking on failure)
      if (config.headlessMode) {
        try {
          await this.setupHeadlessDisplay(config);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          this.output.appendLine(`[Connect] Headless display setup failed (falling back to normal): ${msg}`);
        }
      }

      // Step 5: Get apps list
      this.lastHostId = host.host_id;
      const apps = await this.apiClient.listApps(host.host_id);
      this.output.appendLine(`[Connect] Apps: ${apps.map(a => a.name).join(', ')}`);

      this.setState('streaming', 'Connected');
      return { port, hostId: host.host_id, apps };

    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.output.appendLine(`[Connect] Error: ${msg}`);
      this.setState('error', msg);
      throw err;
    }
  }

  // -------------------------------------------------------------------------
  // Headless virtual display setup
  // -------------------------------------------------------------------------

  private async setupHeadlessDisplay(config: MooCaptureConfig): Promise<void> {
    this.setState('setting_up_display', 'Setting up virtual display...');

    this.vdm = new VirtualDisplayManager(this.output);
    this.sunshineConfig = new SunshineConfigManager(this.output);

    // Check if VDD is installed
    const installed = await this.vdm.isVddInstalled();
    if (!installed) {
      this.output.appendLine('[Connect] VDD not installed — skipping headless setup.');
      throw new Error('Virtual Display Driver is not installed. Run "Moo Capture: Setup Virtual Display" first.');
    }

    // Write scripts to globalStoragePath/scripts/
    const scriptsDir = path.join(this.globalStoragePath, 'scripts');
    fs.mkdirSync(scriptsDir, { recursive: true });

    const sentinelPath = path.join(this.globalStoragePath, 'headless-sentinel.json');
    const setupScriptPath = path.join(scriptsDir, 'setup.ps1');
    const teardownScriptPath = path.join(scriptsDir, 'teardown.ps1');
    const watchdogScriptPath = path.join(scriptsDir, 'watchdog.ps1');

    const setupScript = generateSetupScript({
      dxgiInfoPath: SUNSHINE_DXGI_INFO,
      sentinelPath,
      watchdogScriptPath,
      teardownScriptPath,
    });

    const teardownScript = generateTeardownScript({
      sentinelPath,
    });

    const watchdogScript = generateWatchdogScript({
      sentinelPath,
      teardownScriptPath,
    });

    fs.writeFileSync(setupScriptPath, setupScript, 'utf-8');
    fs.writeFileSync(teardownScriptPath, teardownScript, 'utf-8');
    fs.writeFileSync(watchdogScriptPath, watchdogScript, 'utf-8');

    this.output.appendLine(`[Connect] Display scripts written to ${scriptsDir}`);

    // Update Sunshine apps via REST API if credentials are available
    if (this.sunshineUsername && this.sunshinePassword) {
      try {
        const apps = await this.sunshineConfig.getSunshineApps(
          this.sunshineUsername,
          this.sunshinePassword,
        );

        this.output.appendLine(`[Connect] Found ${apps.length} Sunshine app(s). Adding prep commands...`);

        // Use the virtual display resolution from config, or a default name
        const virtualDisplayName = '';  // Will be determined at runtime by the setup script
        const updatedApps = this.sunshineConfig.addPrepCommandsToApps(
          apps,
          setupScriptPath,
          teardownScriptPath,
          virtualDisplayName,
        );

        await this.sunshineConfig.updateSunshineApps(
          this.sunshineUsername,
          this.sunshinePassword,
          updatedApps,
        );

        this.output.appendLine('[Connect] Sunshine apps updated with headless prep commands.');
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        this.output.appendLine(`[Connect] Failed to update Sunshine apps: ${msg}`);
        // Non-fatal — the scripts are written, user can configure manually
      }
    } else {
      this.output.appendLine('[Connect] No Sunshine credentials — scripts written but apps not auto-configured.');
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

    // List existing hosts
    const hosts = await this.apiClient.listHosts();
    this.output.appendLine(`[Connect] Found ${hosts.length} hosts: ${JSON.stringify(hosts.map(h => ({ id: h.host_id, name: h.name, paired: h.paired })))}`);

    let host = hosts.length > 0 ? hosts[0] : null;

    if (!host) {
      // No hosts at all — add one
      this.output.appendLine(`[Connect] Adding host: ${config.sunshineHost}:${config.sunshinePort}`);
      host = await this.apiClient.addHost(config.sunshineHost, config.sunshinePort);
      this.output.appendLine(`[Connect] Host added: ${host.name} (id=${host.host_id}, paired=${host.paired})`);
    }

    // Pair if needed
    if (host.paired === 'NotPaired') {
      this.setState('pairing', 'Pairing with Sunshine — check for PIN prompt...');
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

    // Verify displays were restored if headless was active
    if (this.vdm) {
      this.setState('tearing_down_display', 'Restoring displays...');
      const sentinelPath = path.join(this.globalStoragePath, 'headless-sentinel.json');
      if (fs.existsSync(sentinelPath)) {
        this.output.appendLine('[Disconnect] Sentinel file still exists — teardown script should handle cleanup.');
        // The teardown is handled by Sunshine's prep-cmd undo, but log for awareness
      }
      this.vdm = null;
      this.sunshineConfig = null;
    }

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
