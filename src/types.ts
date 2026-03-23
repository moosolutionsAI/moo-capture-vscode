// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

export interface MooCaptureConfig {
  sunshineHost: string;
  sunshinePort: number;
  relayPort: number;
  resolution: string;
  fps: number;
  codec: 'h264' | 'hevc';
  bitrate: number;
}

// ---------------------------------------------------------------------------
// Sunshine server
// ---------------------------------------------------------------------------

export interface SunshineServerInfo {
  hostname: string;
  uniqueId: string;
  paired: boolean;
  currentClients: number;
  maxClients: number;
}

export interface SunshineApp {
  id: number;
  name: string;
  isRunning: boolean;
}

// ---------------------------------------------------------------------------
// Connection state
// ---------------------------------------------------------------------------

export type ConnectionState =
  | 'disconnected'
  | 'downloading_relay'
  | 'starting_relay'
  | 'pairing'
  | 'connecting_webrtc'
  | 'streaming'
  | 'error';

// ---------------------------------------------------------------------------
// Relay (moonlight-web-stream) types
// ---------------------------------------------------------------------------

export interface RelayHost {
  host_id: number;
  name: string;
  address: string;
  http_port: number;
  paired: string;
  owner: string;
}

export interface RelayApp {
  id: number;
  name: string;
}

// ---------------------------------------------------------------------------
// Extension ↔ Webview messages
// ---------------------------------------------------------------------------

export type ExtToWebviewMessage =
  | { command: 'startWebRtc'; iceServers: RTCIceServer[] }
  | { command: 'relayMessage'; data: string }
  | { command: 'disconnect' }
  | { command: 'error'; message: string };

export type WebviewToExtMessage =
  | { type: 'status'; state: 'connecting' | 'connected' | 'streaming' | 'disconnected' | 'error'; message?: string }
  | { type: 'stats'; fps: number; latencyMs: number; decodeTimeMs: number }
  | { type: 'relayMessage'; data: string }
  | { type: 'requestConnect' }
  | { type: 'requestDisconnect' }
  | { type: 'ready' };

export interface StreamConfig {
  resolution: string;
  fps: number;
  codec: 'h264' | 'hevc';
  bitrate: number;
}
