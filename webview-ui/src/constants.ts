// ---------------------------------------------------------------------------
// WebRTC
// ---------------------------------------------------------------------------

/** ICE servers — empty for local-only connections */
export const ICE_SERVERS: RTCIceServer[] = [];

/** RTCDataChannel config for gamepad input (unreliable, unordered = lowest latency) */
export const INPUT_CHANNEL_CONFIG: RTCDataChannelInit = {
  ordered: false,
  maxRetransmits: 0,
};

export const INPUT_CHANNEL_NAME = 'input';

// ---------------------------------------------------------------------------
// Video rendering
// ---------------------------------------------------------------------------

/** Use desynchronized canvas for lowest display latency */
export const CANVAS_DESYNCHRONIZED = true;

// ---------------------------------------------------------------------------
// Gamepad
// ---------------------------------------------------------------------------

/** Fallback polling interval in ms (250Hz) when rawgamepadinputchange is unavailable */
export const GAMEPAD_POLL_INTERVAL_MS = 4;

/** Dead zone for analog sticks (ignore tiny movements) */
export const ANALOG_DEADZONE = 0.05;

// ---------------------------------------------------------------------------
// Stats
// ---------------------------------------------------------------------------

/** How often to update the HUD stats (ms) */
export const STATS_UPDATE_INTERVAL_MS = 1000;

/** How often to send stats to extension host (ms) */
export const STATS_REPORT_INTERVAL_MS = 2000;
