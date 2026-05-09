// ---------------------------------------------------------------------------
// Vibeshine (Sunshine-fork) / NVHTTP
// ---------------------------------------------------------------------------

export const VIBESHINE_DEFAULT_HOST = 'localhost';
export const VIBESHINE_HTTPS_PORT = 47984;
export const VIBESHINE_WEB_PORT = 47990;
export const VIBESHINE_HTTP_PORT = 47989;
export const VIBESHINE_RTSP_PORT = 48010;
export const VIBESHINE_VIDEO_RTP_PORT = 47998;
export const VIBESHINE_CONTROL_PORT = 47999;
export const VIBESHINE_AUDIO_PORT = 48000;

/** Timeout for NVHTTP API requests (ms) */
export const VIBESHINE_REQUEST_TIMEOUT_MS = 5000;

// ---------------------------------------------------------------------------
// Relay (moonlight-web-stream)
// ---------------------------------------------------------------------------

export const RELAY_DEFAULT_PORT = 48080;
export const RELAY_HEALTH_CHECK_INTERVAL_MS = 5000;
export const RELAY_RESTART_BACKOFF_MS = [1000, 5000, 10000] as const;
export const RELAY_MAX_RETRIES = 3;

/** Time to wait for relay to become healthy after spawn (ms) */
export const RELAY_STARTUP_TIMEOUT_MS = 15000;

/** GitHub release info for auto-download */
export const RELAY_GITHUB_REPO = 'MrCreativ3001/moonlight-web-stream';
export const RELAY_VERSION = 'v2.6-prerelease.2';
export const RELAY_BINARY_NAME_WIN = 'web-server.exe';
export const RELAY_ASSET_WIN = 'moonlight-web-x86_64-pc-windows-gnu.zip';

/** Internal credentials for the managed relay (never shown to user) */
export const RELAY_INTERNAL_USER = 'moo-capture';
export const RELAY_INTERNAL_PASS = 'moo-capture-internal';

// ---------------------------------------------------------------------------
// Extension
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Stream health watchdog + iframe heartbeat (PHASE THREE / FOUR)
// ---------------------------------------------------------------------------

/** How often the parent checks whether the iframe heartbeat is overdue. */
export const HEARTBEAT_CHECK_INTERVAL_MS = 1000;
/** Gap that triggers heartbeat-timeout reconnect (panel must be visible). */
export const HEARTBEAT_TIMEOUT_MS = 5000;
/**
 * The iframe-side heartbeat interval is hardcoded in MOO_MUTE_JS (browser
 * JS, not Node). Documented here for parity — if you change one, change
 * both. The 2000ms cadence keeps the parent's 5000ms timeout window
 * comfortably above 2x the heartbeat period.
 */
export const HEARTBEAT_INTERVAL_MS_DOCUMENTED = 2000;

/**
 * Circuit breaker against runaway reconnect loops. If fireReconnect is
 * called RECONNECT_LIMIT times within RECONNECT_WINDOW_MS, the breaker
 * trips and surfaces a warning instead of attempting a (likely-failing)
 * reconnect. Manual reconnect resets the counter naturally as old
 * timestamps age out of the window.
 */
export const RECONNECT_LIMIT = 3;
export const RECONNECT_WINDOW_MS = 60_000;

export const EXTENSION_ID = 'moo-capture';
export const COMMANDS = {
  connect: 'moo-capture.connect',
  disconnect: 'moo-capture.disconnect',
  shutdown: 'moo-capture.shutdown',
  setupVirtualDisplay: 'moo-capture.setupVirtualDisplay',
  toggleMute: 'moo-capture.toggleMute',
  showStats: 'moo-capture.showStats',
  openSettings: 'moo-capture.openSettings',
  tuneStream: 'moo-capture.tuneStream',
} as const;

export const CONFIG_SECTION = 'mooCaptureVscode';

export const STATUS_BAR_PRIORITY = 50;

// ---------------------------------------------------------------------------
// Virtual Display Driver (VDD)
// ---------------------------------------------------------------------------

export const VDD_GITHUB_REPO = 'VirtualDrivers/Virtual-Display-Driver';
export const VDD_DEVICE_NAME = 'Virtual Display Driver';
/** Vibeshine installs to the Sunshine directory for backward compatibility */
export const VIBESHINE_INSTALL_DIR = 'C:\\Program Files\\Sunshine';
export const VIBESHINE_DXGI_INFO = 'C:\\Program Files\\Sunshine\\tools\\dxgi-info.exe';
/** Where Sunshine writes its rolling debug logs (sunshine-YYYYMMDD-...log) */
export const SUNSHINE_LOG_DIR = 'C:\\Program Files\\Sunshine\\config\\logs';
export const VIBESHINE_API_PORT = 47990;
/** Process name that the watchdog monitors (Vibeshine keeps 'sunshine' for compat) */
export const STREAMER_PROCESS_NAME = 'sunshine';
export const EMERGENCY_HOTKEY = 'Ctrl+Alt+Shift+R';
