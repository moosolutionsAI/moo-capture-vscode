import { STATS_UPDATE_INTERVAL_MS } from './constants';

export interface StreamStats {
  fps: number;
  decodeTimeMs: number;
  jitterBufferMs: number;
  framesDecoded: number;
  framesDropped: number;
  bytesReceived: number;
}

export class LatencyStats {
  private pc: RTCPeerConnection | null = null;
  private updateInterval: ReturnType<typeof setInterval> | null = null;
  private lastStats: StreamStats = {
    fps: 0,
    decodeTimeMs: 0,
    jitterBufferMs: 0,
    framesDecoded: 0,
    framesDropped: 0,
    bytesReceived: 0,
  };
  private prevFramesDecoded = 0;
  private prevTimestamp = 0;
  private prevTotalDecodeTime = 0;

  /** Start monitoring WebRTC stats */
  start(pc: RTCPeerConnection): void {
    this.pc = pc;
    this.prevTimestamp = performance.now();

    this.updateInterval = setInterval(() => {
      this.update().catch(console.error);
    }, STATS_UPDATE_INTERVAL_MS);
  }

  /** Stop monitoring */
  stop(): void {
    if (this.updateInterval) {
      clearInterval(this.updateInterval);
      this.updateInterval = null;
    }
    this.pc = null;
  }

  private async update(): Promise<void> {
    if (!this.pc) return;

    const stats = await this.pc.getStats();
    const now = performance.now();
    const elapsed = (now - this.prevTimestamp) / 1000; // seconds

    stats.forEach((report) => {
      if (report.type === 'inbound-rtp' && report.kind === 'video') {
        const framesDecoded = report.framesDecoded ?? 0;
        const totalDecodeTime = report.totalDecodeTime ?? 0;
        const jitterBufferDelay = report.jitterBufferDelay ?? 0;
        const jitterBufferEmittedCount = report.jitterBufferEmittedCount ?? 0;

        // FPS = frames decoded in this interval
        const framesDelta = framesDecoded - this.prevFramesDecoded;
        this.lastStats.fps = elapsed > 0 ? Math.round(framesDelta / elapsed) : 0;

        // Average decode time for this interval
        const decodeDelta = totalDecodeTime - this.prevTotalDecodeTime;
        this.lastStats.decodeTimeMs = framesDelta > 0
          ? (decodeDelta / framesDelta) * 1000
          : 0;

        // Jitter buffer delay
        this.lastStats.jitterBufferMs = jitterBufferEmittedCount > 0
          ? (jitterBufferDelay / jitterBufferEmittedCount) * 1000
          : 0;

        this.lastStats.framesDecoded = framesDecoded;
        this.lastStats.framesDropped = report.framesDropped ?? 0;
        this.lastStats.bytesReceived = report.bytesReceived ?? 0;

        this.prevFramesDecoded = framesDecoded;
        this.prevTotalDecodeTime = totalDecodeTime;
      }
    });

    this.prevTimestamp = now;
  }

  /** Update HUD elements */
  updateHUD(): void {
    const fpsEl = document.getElementById('hud-fps');
    const decodeEl = document.getElementById('hud-decode');
    const latencyEl = document.getElementById('hud-latency');

    if (fpsEl) fpsEl.textContent = `${this.lastStats.fps}`;
    if (decodeEl) decodeEl.textContent = `${this.lastStats.decodeTimeMs.toFixed(1)}ms`;
    if (latencyEl) latencyEl.textContent = `${this.lastStats.jitterBufferMs.toFixed(1)}ms`;
  }

  get stats(): StreamStats {
    return { ...this.lastStats };
  }
}
