import * as fs from 'fs';
import * as path from 'path';
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

  // Session-count guard (iteration 3). SSE-driven; defensive against
  // iteration 1's auto-detach=false fix not taking effect.
  private hostStreamAbort: AbortController | null = null;
  private guardCancelInFlight = false;

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

  // Status-bar mute renderer (iteration 6). The extension wires this so
  // changes coming back from the webview can update the mute status-bar
  // icon without ConnectionManager importing vscode UI types.
  private muteStateRenderer?: (muted: boolean | null) => void;
  setMuteStateRenderer(cb: (muted: boolean | null) => void): void {
    this.muteStateRenderer = cb;
  }
  notifyMuteState(muted: boolean | null): void {
    this.muteStateRenderer?.(muted);
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
      // Defensive teardown: if a prior session is still recorded (disconnect
      // was skipped, onDidDispose missed, or the prior cancelStream silently
      // failed), cancel it on the existing relay before we replace apiClient.
      // Fire-and-forget — never block the new connect on the old session's
      // cleanup, but make sure the request is dispatched before lastHostId
      // is cleared. Skip if the relay is already stopped (prior session is
      // orphaned at the Sunshine layer; new relay can't reach it).
      if (this.apiClient && this.lastHostId !== null && this.relay.isRunning) {
        const staleHostId = this.lastHostId;
        this.apiClient.cancelStream(staleHostId).catch(() => { /* expected on stale state */ });
        this.output.appendLine(`[Connect] Defensive teardown: cancelStream(${staleHostId})`);
      }

      // Reset per-connect cache so a prior failed attempt doesn't feed us stale
      // apps on retry.
      this.cachedVibeshineApps = [];
      this.lastHostId = null;

      // Remove zombie hosts from the relay's data.json before the relay reads
      // it. Hosts whose address resolves off-loopback (e.g. "localhost" via
      // DNS) trigger Moonlight's "remote IPv4 streaming" path. If two hosts
      // are stored (one good, one stale), the /api/hosts listing order is
      // non-deterministic and we may pick the wrong one.
      this.cleanZombieHosts(config.sunshineHost);

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

      // Start the session-count guard. SSE-driven, fires cancelStream once
      // if the relay reports more than one active session for our host —
      // belt-and-suspenders for the iteration 1 auto-detach fix. Lifecycle
      // is owned by this manager: stopped on disconnect/dispose.
      this.startSessionGuard(host.host_id);

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
  // Zombie host cleanup — removes stale "localhost" / wrong-address entries
  // from the relay's data.json so listHosts returns only our canonical host.
  // -------------------------------------------------------------------------

  private cleanZombieHosts(canonicalAddress: string): void {
    const dataJsonPath = path.join(this.globalStoragePath, 'server', 'data.json');
    if (!fs.existsSync(dataJsonPath)) { return; }

    try {
      const raw = fs.readFileSync(dataJsonPath, 'utf8');
      const data = JSON.parse(raw);
      if (!data.hosts || typeof data.hosts !== 'object') { return; }

      const beforeIds = Object.keys(data.hosts);
      const removed: string[] = [];
      for (const id of beforeIds) {
        const addr = data.hosts[id]?.address;
        if (addr !== canonicalAddress) {
          removed.push(`${id}(address=${addr})`);
          delete data.hosts[id];
        }
      }

      if (removed.length > 0) {
        fs.writeFileSync(dataJsonPath, JSON.stringify(data, null, 2));
        this.output.appendLine(`[Clean] Removed ${removed.length} zombie host(s): ${removed.join(', ')}`);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.output.appendLine(`[Clean] Failed to clean zombie hosts (non-fatal): ${msg}`);
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

        this.output.appendLine(`[Connect] Found ${apps.length} Vibeshine app(s). Checking virtual display config...`);

        // Skip the POST if apps already have the correct virtual display
        // config. Unnecessary POSTs trigger Windows display topology changes
        // that cause black screen flicker and can duplicate virtual displays.
        if (this.sunshineConfig.appsAlreadyConfigured(apps)) {
          this.output.appendLine('[Connect] Vibeshine apps already configured — skipping update to avoid display flicker.');
        } else {
          const updatedApps = this.sunshineConfig.addPrepCommandsToApps(apps);

          await this.sunshineConfig.updateSunshineApps(
            this.vibeshineUsername,
            this.vibeshinePassword,
            env,
            updatedApps,
          );

          this.output.appendLine('[Connect] Vibeshine apps configured for virtual display.');
        }

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

    // Always call addHost for our configured address. The relay derives
    // host_id from the address, so this is idempotent: a stale "localhost"
    // host from a previous run gets a different id than our "127.0.0.1"
    // entry, and we must use the id that matches our address — otherwise
    // Moonlight resolves "localhost" via DNS, lands on a non-loopback
    // interface, and applies the "remote IPv4 streaming" 1024-byte MTU cap
    // that makes the stream die 1s after the first video packet.
    let authoritativeHost: RelayHost | null = null;
    this.output.appendLine(`[Connect] Adding host: ${config.sunshineHost}:${config.sunshinePort}`);
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        authoritativeHost = await this.apiClient.addHost(config.sunshineHost, config.sunshinePort);
        this.output.appendLine(`[Connect] addHost returned id=${authoritativeHost.host_id} paired=${authoritativeHost.paired}`);
        break;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (attempt < 3 && msg.includes('IncompleteMessage')) {
          this.output.appendLine(`[Connect] addHost attempt ${attempt} failed (IncompleteMessage), retrying in 1s...`);
          await new Promise(r => setTimeout(r, 1000));
        } else {
          this.output.appendLine(`[Connect] addHost failed — falling back to listHosts: ${msg}`);
          break;
        }
      }
    }

    // List hosts to dedupe and get live pairing state — addHost's response
    // may not reflect current server_state.
    const rawHosts = await this.apiClient.listHosts();
    const seen = new Set<number>();
    const hosts = rawHosts.filter(h => {
      const id = Number(h.host_id);
      if (seen.has(id)) { return false; }
      seen.add(id);
      return true;
    });
    this.output.appendLine(`[Connect] Found ${hosts.length} host(s): ${JSON.stringify(hosts.map(h => ({ id: h.host_id, name: h.name, paired: h.paired })))}`);

    // Prefer the host id returned by addHost (matches our address exactly);
    // fall back to the first listed host only if addHost failed entirely.
    let host: RelayHost | null = null;
    if (authoritativeHost) {
      host = hosts.find(h => Number(h.host_id) === Number(authoritativeHost!.host_id)) ?? authoritativeHost;
    } else if (hosts.length > 0) {
      host = hosts[0];
    }

    if (!host) { throw new Error('Failed to add host after 3 attempts'); }

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
    // Stop the SSE session guard before cancelling: avoids the guard seeing
    // its own cancel as a state change and trying to fire again.
    this.stopSessionGuard();

    // Cancel the active stream on the host so streamer.exe stops
    if (this.apiClient && this.lastHostId) {
      this.apiClient.cancelStream(this.lastHostId).catch(() => {});
      this.output.appendLine(`[Disconnect] Cancelled stream on host ${this.lastHostId}`);
    }

    this.sunshineConfig = null;

    this.setState('disconnected');
  }

  // -------------------------------------------------------------------------
  // Session-count guard
  // -------------------------------------------------------------------------

  private startSessionGuard(hostId: number): void {
    this.stopSessionGuard();
    if (!this.apiClient) { return; }

    const abort = new AbortController();
    this.hostStreamAbort = abort;

    this.apiClient.streamHostUpdates(
      abort.signal,
      (host) => {
        if (Number(host.host_id) !== hostId) { return; }
        // Look for any of the known session-count indicators the relay may
        // forward from Sunshine's serverinfo. Field name varies across
        // relay/Sunshine versions; check several. If none are present, the
        // guard simply never fires — iteration 1 alone is the fix.
        const candidates: Array<unknown> = [
          host.currentClients,
          (host as Record<string, unknown>)['current_clients'],
          (host as Record<string, unknown>)['active_sessions'],
          (host as Record<string, unknown>)['sessions'],
        ];
        let count: number | null = null;
        for (const c of candidates) {
          if (typeof c === 'number') { count = c; break; }
        }
        if (count === null || count <= 1) { return; }
        if (this.guardCancelInFlight) { return; }
        if (abort.signal.aborted) { return; }

        this.guardCancelInFlight = true;
        this.output.appendLine(
          `[SessionGuard] active sessions=${count} on host ${hostId} — cancelling to prevent audio doubling`,
        );
        const client = this.apiClient;
        if (!client) { this.guardCancelInFlight = false; return; }

        client.cancelStream(hostId)
          .catch((err) => {
            const msg = err instanceof Error ? err.message : String(err);
            this.output.appendLine(`[SessionGuard] cancelStream failed: ${msg}`);
          })
          .finally(() => {
            // Reset so a fresh connect can re-arm the guard. The SSE handler
            // itself will see count drop and not re-fire because the gate
            // only fires once before the manager is disconnected.
            this.guardCancelInFlight = false;
          });
      },
      (err) => {
        // SSE errors are non-fatal; the iteration 1 fix is the primary defence.
        this.output.appendLine(`[SessionGuard] SSE error (non-fatal): ${err.message}`);
      },
    );
  }

  private stopSessionGuard(): void {
    if (this.hostStreamAbort) {
      this.hostStreamAbort.abort();
      this.hostStreamAbort = null;
    }
    this.guardCancelInFlight = false;
  }

  dispose(): void {
    this.disconnect();
    this.relay.stop();
  }

  get currentState(): ConnectionState {
    return this.state;
  }
}
