import type { OutputChannel } from 'vscode';
import { RelayManager } from './relayManager';
import { RelayDownloader } from './relayDownloader';
import { RelayApiClient } from './relayApiClient';
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
  private onStateChange?: (state: ConnectionState, message?: string) => void;

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
  ): Promise<string> {
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

      // Step 5: Return relay URL — show app selection (Desktop, Steam, etc.)
      this.setState('streaming', 'Connected');
      const relayUrl = `http://127.0.0.1:${port}`;
      this.output.appendLine(`[Connect] Relay URL: ${relayUrl}`);
      return relayUrl;

    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.output.appendLine(`[Connect] Error: ${msg}`);
      this.setState('error', msg);
      throw err;
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
    this.setState('disconnected');
  }

  dispose(): void {
    this.relay.stop();
  }

  get currentState(): ConnectionState {
    return this.state;
  }
}
