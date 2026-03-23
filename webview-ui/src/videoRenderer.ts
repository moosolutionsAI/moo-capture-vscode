import { CANVAS_DESYNCHRONIZED } from './constants';

export class VideoRenderer {
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private video: HTMLVideoElement;
  private animationId: number | null = null;
  private frameCount = 0;
  private lastFpsTime = 0;
  private currentFps = 0;

  constructor(canvasId: string, videoId: string) {
    this.canvas = document.getElementById(canvasId) as HTMLCanvasElement;
    this.video = document.getElementById(videoId) as HTMLVideoElement;

    // Desynchronized canvas bypasses the compositor for lowest display latency
    const ctx = this.canvas.getContext('2d', {
      desynchronized: CANVAS_DESYNCHRONIZED,
      alpha: false,
    });
    if (!ctx) {
      throw new Error('Failed to create 2D canvas context');
    }
    this.ctx = ctx;

    // Log whether desynchronized mode is actually active
    const attrs = this.ctx.getContextAttributes?.();
    console.log(`[Renderer] desynchronized: ${attrs?.desynchronized ?? 'unknown'}`);

    // Handle resize
    this.resize();
    window.addEventListener('resize', () => this.resize());
  }

  private resize(): void {
    const dpr = window.devicePixelRatio || 1;
    const w = window.innerWidth;
    const h = window.innerHeight;
    this.canvas.width = w * dpr;
    this.canvas.height = h * dpr;
    this.canvas.style.width = `${w}px`;
    this.canvas.style.height = `${h}px`;
  }

  /** Attach a MediaStream and start rendering frames to canvas */
  start(stream: MediaStream): void {
    this.video.srcObject = stream;
    this.video.play().catch(console.error);

    this.canvas.classList.add('active');
    this.lastFpsTime = performance.now();
    this.frameCount = 0;

    // Use requestVideoFrameCallback for frame-accurate rendering
    if ('requestVideoFrameCallback' in this.video) {
      this.renderWithRVFC();
    } else {
      // Fallback to requestAnimationFrame
      this.renderWithRAF();
    }
  }

  /** Frame-accurate rendering — fires exactly when a new video frame is available */
  private renderWithRVFC(): void {
    const callback = (_now: DOMHighResTimeStamp, _metadata: VideoFrameCallbackMetadata) => {
      this.drawFrame();
      // Continue requesting frames
      this.video.requestVideoFrameCallback(callback);
    };
    this.video.requestVideoFrameCallback(callback);
  }

  /** Fallback: render at display refresh rate */
  private renderWithRAF(): void {
    const loop = () => {
      this.drawFrame();
      this.animationId = requestAnimationFrame(loop);
    };
    this.animationId = requestAnimationFrame(loop);
  }

  private drawFrame(): void {
    if (this.video.readyState < 2) return; // HAVE_CURRENT_DATA

    const cw = this.canvas.width;
    const ch = this.canvas.height;

    // Draw video frame filling the entire canvas
    this.ctx.drawImage(this.video, 0, 0, cw, ch);

    // FPS tracking
    this.frameCount++;
    const now = performance.now();
    const elapsed = now - this.lastFpsTime;
    if (elapsed >= 1000) {
      this.currentFps = Math.round((this.frameCount * 1000) / elapsed);
      this.frameCount = 0;
      this.lastFpsTime = now;
    }
  }

  /** Stop rendering */
  stop(): void {
    if (this.animationId !== null) {
      cancelAnimationFrame(this.animationId);
      this.animationId = null;
    }
    this.video.srcObject = null;
    this.canvas.classList.remove('active');
    this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
  }

  get fps(): number {
    return this.currentFps;
  }
}

// Type augmentation for requestVideoFrameCallback
interface VideoFrameCallbackMetadata {
  presentationTime: DOMHighResTimeStamp;
  expectedDisplayTime: DOMHighResTimeStamp;
  width: number;
  height: number;
  mediaTime: number;
  presentedFrames: number;
  processingDuration?: number;
  captureTime?: DOMHighResTimeStamp;
  receiveTime?: DOMHighResTimeStamp;
  rtpTimestamp?: number;
}

declare global {
  interface HTMLVideoElement {
    requestVideoFrameCallback(callback: (now: DOMHighResTimeStamp, metadata: VideoFrameCallbackMetadata) => void): number;
    cancelVideoFrameCallback(handle: number): void;
  }
}
