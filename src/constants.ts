// ---------------------------------------------------------------------------
// Sunshine / NVHTTP
// ---------------------------------------------------------------------------

export const SUNSHINE_DEFAULT_HOST = 'localhost';
export const SUNSHINE_HTTPS_PORT = 47984;
export const SUNSHINE_WEB_PORT = 47990;
export const SUNSHINE_HTTP_PORT = 47989;
export const SUNSHINE_RTSP_PORT = 48010;
export const SUNSHINE_VIDEO_RTP_PORT = 47998;
export const SUNSHINE_CONTROL_PORT = 47999;
export const SUNSHINE_AUDIO_PORT = 48000;

/** Timeout for NVHTTP API requests (ms) */
export const SUNSHINE_REQUEST_TIMEOUT_MS = 5000;

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

export const EXTENSION_ID = 'moo-capture';
export const COMMANDS = {
  connect: 'moo-capture.connect',
  disconnect: 'moo-capture.disconnect',
} as const;

export const CONFIG_SECTION = 'mooCaptureVscode';

export const STATUS_BAR_PRIORITY = 50;
