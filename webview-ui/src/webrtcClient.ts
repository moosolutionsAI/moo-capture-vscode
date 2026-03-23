import { ICE_SERVERS } from './constants';

// ---------------------------------------------------------------------------
// moonlight-web-stream signaling protocol types
// ---------------------------------------------------------------------------

/** Messages sent TO the relay server (via extension postMessage bridge) */
type ClientMessage =
  | { Init: { host_id: string; app_id: number; video_frame_queue_size: number; audio_sample_queue_size: number } }
  | { SetTransport: 'WebRTC' | 'WebSocket' }
  | { WebRtc: WebRtcSignal }
  | { StartStream: StartStreamConfig };

/** WebRTC signaling sub-messages */
type WebRtcSignal =
  | { Description: { ty: string; sdp: string } }
  | { AddIceCandidate: { candidate: string; sdp_mid: string | null; sdp_mline_index: number | null; username_fragment: string | null } };

/** Stream configuration sent to start streaming */
interface StartStreamConfig {
  bitrate: number;
  packet_size: number;
  fps: number;
  width: number;
  height: number;
  play_audio_local: boolean;
  video_supported_formats: number;
  video_colorspace: string;
  video_color_range_full: boolean;
  hdr: boolean;
}

/** Messages received FROM the relay server */
interface ServerSetup {
  Setup: { ice_servers: RTCIceServer[] };
}

interface ServerWebRtc {
  WebRtc: WebRtcSignal;
}

interface ServerConnectionComplete {
  ConnectionComplete: {
    capabilities: unknown;
    format: number;
    width: number;
    height: number;
    fps: number;
    audio_sample_rate: number;
    audio_channel_count: number;
    audio_streams: number;
    audio_coupled_streams: number;
    audio_samples_per_frame: number;
    audio_mapping: number[];
  };
}

// ---------------------------------------------------------------------------
// Video codec support bits (matches moonlight-web-stream's format)
// ---------------------------------------------------------------------------

/** H.264 support bit */
const VIDEO_FORMAT_H264 = 0x0001;

// ---------------------------------------------------------------------------
// VS Code API for message bridging
// ---------------------------------------------------------------------------

declare function acquireVsCodeApi(): {
  postMessage(msg: unknown): void;
  getState(): unknown;
  setState(state: unknown): void;
};

// ---------------------------------------------------------------------------
// WebRTC Client
// ---------------------------------------------------------------------------

export interface WebRTCClientEvents {
  onTrack: (track: MediaStreamTrack, receiver: RTCRtpReceiver) => void;
  onConnected: () => void;
  onDisconnected: () => void;
  onError: (error: string) => void;
  onStreamReady: (info: { width: number; height: number; fps: number }) => void;
}

export interface StreamParams {
  hostId: string;
  appId: number;
  width: number;
  height: number;
  fps: number;
  bitrate: number;
  codec: 'h264' | 'hevc';
}

export class WebRTCClient {
  private pc: RTCPeerConnection | null = null;
  private vscodeApi: ReturnType<typeof acquireVsCodeApi>;

  constructor(
    private readonly events: WebRTCClientEvents,
    vscodeApi: ReturnType<typeof acquireVsCodeApi>,
  ) {
    this.vscodeApi = vscodeApi;
  }

  /**
   * Handle a signaling message from the relay (received via extension postMessage bridge).
   * Called by main.ts when it receives a 'relayMessage' command.
   */
  async onRelayMessage(rawData: string): Promise<void> {
    const msg = JSON.parse(rawData);

    if ('Setup' in msg) {
      // Server provides ICE servers and signals ready for WebRTC
      const setup = msg as ServerSetup;
      const iceServers = setup.Setup.ice_servers.length > 0
        ? setup.Setup.ice_servers
        : ICE_SERVERS;

      console.log('[WebRTC] Received Setup, ICE servers:', iceServers);

      // Tell relay we want WebRTC transport
      this.sendToRelay({ SetTransport: 'WebRTC' });

      // Create peer connection
      await this.initPeerConnection(iceServers);

    } else if ('WebRtc' in msg) {
      // WebRTC signaling (SDP or ICE candidate)
      const webrtc = (msg as ServerWebRtc).WebRtc;
      await this.handleWebRtcSignal(webrtc);

    } else if ('ConnectionComplete' in msg) {
      // Stream is ready
      const cc = (msg as ServerConnectionComplete).ConnectionComplete;
      console.log(`[WebRTC] Stream ready: ${cc.width}x${cc.height} @ ${cc.fps}fps`);
      this.events.onStreamReady({ width: cc.width, height: cc.height, fps: cc.fps });

    } else if ('DebugLog' in msg) {
      console.log(`[Relay] ${msg.DebugLog.message}`);

    } else if ('ConnectionTerminated' in msg) {
      console.error('[WebRTC] Connection terminated:', msg.ConnectionTerminated);
      this.events.onError(`Connection terminated: error code ${msg.ConnectionTerminated.error_code}`);
    }
  }

  /** Start stream after WebRTC connects */
  startStream(params: StreamParams): void {
    this.sendToRelay({
      StartStream: {
        bitrate: params.bitrate,
        packet_size: 1024,
        fps: params.fps,
        width: params.width,
        height: params.height,
        play_audio_local: true,
        video_supported_formats: VIDEO_FORMAT_H264,
        video_colorspace: 'Rec709',
        video_color_range_full: false,
        hdr: false,
      },
    });
  }

  private async initPeerConnection(iceServers: RTCIceServer[]): Promise<void> {
    this.pc = new RTCPeerConnection({ iceServers });

    // Handle incoming video track
    this.pc.ontrack = (event: RTCTrackEvent) => {
      const track = event.track;
      const receiver = event.receiver;

      // Set jitter buffer to minimum for lowest latency
      if ('jitterBufferTarget' in receiver) {
        (receiver as unknown as { jitterBufferTarget: number }).jitterBufferTarget = 0;
      }
      if ('playoutDelayHint' in receiver) {
        (receiver as unknown as { playoutDelayHint: number }).playoutDelayHint = 0;
      }

      if (track.kind === 'video') {
        // Hint for motion-heavy content (games)
        if ('contentHint' in track) {
          track.contentHint = 'motion';
        }
        this.events.onTrack(track, receiver);
      }
    };

    // Handle remote data channels (input, RTT, etc.)
    this.pc.ondatachannel = (event: RTCDataChannelEvent) => {
      console.log(`[WebRTC] Remote data channel: ${event.channel.label}`);
    };

    // ICE candidates → relay (via extension bridge)
    this.pc.onicecandidate = (event: RTCPeerConnectionIceEvent) => {
      if (event.candidate) {
        const c = event.candidate.toJSON();
        this.sendToRelay({
          WebRtc: {
            AddIceCandidate: {
              candidate: c.candidate ?? '',
              sdp_mid: c.sdpMid ?? null,
              sdp_mline_index: c.sdpMLineIndex ?? null,
              username_fragment: c.usernameFragment ?? null,
            },
          },
        });
      }
    };

    // Connection state
    this.pc.onconnectionstatechange = () => {
      const state = this.pc?.connectionState;
      console.log(`[WebRTC] Connection state: ${state}`);
      if (state === 'connected') {
        this.events.onConnected();
      } else if (state === 'disconnected' || state === 'failed' || state === 'closed') {
        this.events.onDisconnected();
      }
    };

    // Don't create an offer — the relay is the offerer (it has media tracks).
    // We wait for the relay's offer, then respond with an answer.
    console.log('[WebRTC] Peer connection ready, waiting for relay offer');
  }

  private async handleWebRtcSignal(signal: WebRtcSignal): Promise<void> {
    if (!this.pc) return;

    if ('Description' in signal) {
      const desc = signal.Description;
      console.log(`[WebRTC] Remote description: ${desc.ty}`);
      await this.pc.setRemoteDescription(new RTCSessionDescription({
        type: desc.ty as RTCSdpType,
        sdp: desc.sdp,
      }));

      // If we received an offer, respond with explicit answer
      if (desc.ty === 'offer') {
        const answer = await this.pc.createAnswer();
        await this.pc.setLocalDescription(answer);
        console.log(`[WebRTC] Created answer, sending to relay`);
        this.sendToRelay({
          WebRtc: {
            Description: {
              ty: answer.type,
              sdp: answer.sdp ?? '',
            },
          },
        });
      }
    } else if ('AddIceCandidate' in signal) {
      const c = signal.AddIceCandidate;
      await this.pc.addIceCandidate(new RTCIceCandidate({
        candidate: c.candidate,
        sdpMid: c.sdp_mid ?? undefined,
        sdpMLineIndex: c.sdp_mline_index ?? undefined,
        usernameFragment: c.username_fragment ?? undefined,
      }));
    }
  }

  /**
   * Send a signaling message to the relay via the extension's postMessage bridge.
   * Extension forwards this over its authenticated WebSocket to moonlight-web-stream.
   */
  private sendToRelay(msg: ClientMessage): void {
    this.vscodeApi.postMessage({ type: 'relayMessage', data: JSON.stringify(msg) });
  }

  /** Get peer connection for stats */
  getPeerConnection(): RTCPeerConnection | null {
    return this.pc;
  }

  /** Disconnect and clean up */
  disconnect(): void {
    this.cleanup();
    this.events.onDisconnected();
  }

  private cleanup(): void {
    if (this.pc) {
      this.pc.close();
      this.pc = null;
    }
  }
}
