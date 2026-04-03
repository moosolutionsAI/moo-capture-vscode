import { WebRTCClient } from './webrtcClient';
import type { StreamParams } from './webrtcClient';
import { VideoRenderer } from './videoRenderer';
import { GamepadInput } from './gamepadInput';
import { LatencyStats } from './latencyStats';
import { STATS_REPORT_INTERVAL_MS } from './constants';

// ---------------------------------------------------------------------------
// VS Code API
// ---------------------------------------------------------------------------

declare function acquireVsCodeApi(): {
  postMessage(msg: unknown): void;
  getState(): unknown;
  setState(state: unknown): void;
};

const vscode = acquireVsCodeApi();

// ---------------------------------------------------------------------------
// Components
// ---------------------------------------------------------------------------

const renderer = new VideoRenderer('stream-canvas', 'stream-video');
const gamepad = new GamepadInput();
const stats = new LatencyStats();

let webrtc: WebRTCClient | null = null;
let streamParams: StreamParams | null = null;
let statsReportInterval: ReturnType<typeof setInterval> | null = null;
let hudVisible = false;

// ---------------------------------------------------------------------------
// UI Elements
// ---------------------------------------------------------------------------

const connectScreen = document.getElementById('connect-screen')!;
const btnConnect = document.getElementById('btn-connect') as HTMLButtonElement;
const connectStatus = document.getElementById('connect-status')!;
const hud = document.getElementById('hud')!;
const btnDisconnect = document.getElementById('btn-disconnect')!;
const hudGamepad = document.getElementById('hud-gamepad')!;
const btnMute = document.getElementById('btn-mute') as HTMLButtonElement;
const streamVideo = document.getElementById('stream-video') as HTMLVideoElement;

// ---------------------------------------------------------------------------
// UI State
// ---------------------------------------------------------------------------

function showConnectScreen(message = '', isError = false): void {
  connectScreen.classList.remove('hidden');
  btnConnect.disabled = false;
  connectStatus.textContent = message;
  connectStatus.classList.toggle('error', isError);
}

function showConnecting(message: string): void {
  btnConnect.disabled = true;
  connectStatus.textContent = message;
  connectStatus.classList.remove('error');
}

function showStreaming(): void {
  connectScreen.classList.add('hidden');
}

// ---------------------------------------------------------------------------
// WebRTC setup
// ---------------------------------------------------------------------------

function initWebRTC(): void {
  showConnecting('Connecting...');

  webrtc = new WebRTCClient({
    onTrack: (track: MediaStreamTrack, _receiver: RTCRtpReceiver) => {
      // Create a MediaStream from the track and start rendering
      const stream = new MediaStream([track]);
      renderer.start(stream);
      showStreaming();
    },

    onConnected: () => {
      vscode.postMessage({ type: 'status', state: 'streaming' });

      // Start stats monitoring
      const pc = webrtc?.getPeerConnection();
      if (pc) {
        stats.start(pc);
        startStatsReporting();
      }

      // Start stream with our params
      if (streamParams) {
        webrtc?.startStream(streamParams);
      }
    },

    onDisconnected: () => {
      vscode.postMessage({ type: 'status', state: 'disconnected' });
      cleanup();
      showConnectScreen('Disconnected');
    },

    onError: (error: string) => {
      vscode.postMessage({ type: 'status', state: 'error', message: error });
      cleanup();
      showConnectScreen(error, true);
    },

    onStreamReady: (info: { width: number; height: number; fps: number }) => {
      console.log(`[Stream] Ready: ${info.width}x${info.height} @ ${info.fps}fps`);
    },
  }, vscode);
}

function cleanup(): void {
  renderer.stop();
  gamepad.stop();
  stats.stop();
  stopStatsReporting();
  webrtc = null;
  streamParams = null;
}

function disconnect(): void {
  webrtc?.disconnect();
  cleanup();
  showConnectScreen();
}

// ---------------------------------------------------------------------------
// Stats reporting
// ---------------------------------------------------------------------------

function startStatsReporting(): void {
  statsReportInterval = setInterval(() => {
    stats.updateHUD();
    hudGamepad.textContent = gamepad.isConnected ? 'Connected' : 'None';

    const s = stats.stats;
    vscode.postMessage({
      type: 'stats',
      fps: s.fps,
      latencyMs: s.jitterBufferMs,
      decodeTimeMs: s.decodeTimeMs,
    });
  }, STATS_REPORT_INTERVAL_MS);
}

function stopStatsReporting(): void {
  if (statsReportInterval) {
    clearInterval(statsReportInterval);
    statsReportInterval = null;
  }
}

// ---------------------------------------------------------------------------
// HUD toggle (Tab key)
// ---------------------------------------------------------------------------

window.addEventListener('keydown', (e: KeyboardEvent) => {
  if (e.key === 'Tab') {
    e.preventDefault();
    hudVisible = !hudVisible;
    hud.classList.toggle('hidden', !hudVisible);
  }
});

// ---------------------------------------------------------------------------
// Button handlers
// ---------------------------------------------------------------------------

btnConnect.addEventListener('click', () => {
  vscode.postMessage({ type: 'requestConnect' });
});

btnDisconnect.addEventListener('click', () => {
  disconnect();
  vscode.postMessage({ type: 'requestDisconnect' });
});

btnMute.addEventListener('click', () => {
  streamVideo.muted = !streamVideo.muted;
  btnMute.textContent = streamVideo.muted ? 'Unmute' : 'Mute';
  btnMute.classList.toggle('active', !streamVideo.muted);
});

// ---------------------------------------------------------------------------
// Extension message handler
// ---------------------------------------------------------------------------

window.addEventListener('message', (event: MessageEvent) => {
  const msg = event.data;
  switch (msg.command) {
    case 'relayMessage':
      // Signaling message from relay (bridged through extension)
      if (!webrtc) {
        initWebRTC();
      }
      webrtc?.onRelayMessage(msg.data);
      break;
    case 'disconnect':
      disconnect();
      break;
    case 'error':
      showConnectScreen(msg.message, true);
      break;
  }
});

// ---------------------------------------------------------------------------
// Ready
// ---------------------------------------------------------------------------

vscode.postMessage({ type: 'ready' });
