import { GAMEPAD_POLL_INTERVAL_MS, ANALOG_DEADZONE } from './constants';

export interface GamepadState {
  /** Button pressed states (true/false for each button) */
  buttons: boolean[];
  /** Button analog values (0.0-1.0 for triggers) */
  buttonValues: number[];
  /** Axis values (-1.0 to 1.0) */
  axes: number[];
  /** Timestamp */
  timestamp: number;
}

type InputSender = (data: ArrayBuffer) => void;

export class GamepadInput {
  private pollInterval: ReturnType<typeof setInterval> | null = null;
  private lastState: GamepadState | null = null;
  private sender: InputSender | null = null;
  private connected = false;

  constructor() {
    window.addEventListener('gamepadconnected', (e) => {
      console.log(`[Gamepad] Connected: ${(e as GamepadEvent).gamepad.id}`);
      this.connected = true;
    });
    window.addEventListener('gamepaddisconnected', () => {
      console.log('[Gamepad] Disconnected');
      this.connected = false;
      this.lastState = null;
    });
  }

  /** Start capturing gamepad input and sending via the provided callback */
  start(sender: InputSender): void {
    this.sender = sender;

    // Check for rawgamepadinputchange (sub-1ms event-driven, Chromium 142+)
    if ('onrawgamepadinputchange' in window) {
      console.log('[Gamepad] Using rawgamepadinputchange (event-driven)');
      (window as EventTarget).addEventListener('rawgamepadinputchange', () => {
        this.poll();
      });
    } else {
      // Fallback: 250Hz polling (4ms interval)
      console.log(`[Gamepad] Using polling at ${1000 / GAMEPAD_POLL_INTERVAL_MS}Hz`);
      this.pollInterval = setInterval(() => this.poll(), GAMEPAD_POLL_INTERVAL_MS);
    }
  }

  /** Stop capturing */
  stop(): void {
    if (this.pollInterval) {
      clearInterval(this.pollInterval);
      this.pollInterval = null;
    }
    this.sender = null;
  }

  private poll(): void {
    const gamepads = navigator.getGamepads();
    const gp = gamepads[0]; // Primary gamepad
    if (!gp) return;

    const state: GamepadState = {
      buttons: gp.buttons.map((b) => b.pressed),
      buttonValues: gp.buttons.map((b) => b.value),
      axes: gp.axes.map((a) => Math.abs(a) < ANALOG_DEADZONE ? 0 : a),
      timestamp: performance.now(),
    };

    // Only send if state changed (delta compression)
    if (this.stateChanged(state)) {
      this.lastState = state;
      this.send(state);
    }
  }

  private stateChanged(state: GamepadState): boolean {
    if (!this.lastState) return true;

    // Check buttons
    for (let i = 0; i < state.buttons.length; i++) {
      if (state.buttons[i] !== this.lastState.buttons[i]) return true;
      if (Math.abs(state.buttonValues[i] - this.lastState.buttonValues[i]) > 0.01) return true;
    }

    // Check axes
    for (let i = 0; i < state.axes.length; i++) {
      if (Math.abs(state.axes[i] - this.lastState.axes[i]) > 0.01) return true;
    }

    return false;
  }

  /** Serialize and send gamepad state as binary */
  private send(state: GamepadState): void {
    if (!this.sender) return;

    // Binary format: [buttonCount:u8, ...buttonBitmask, ...buttonValues:f32, axisCount:u8, ...axes:f32]
    const buttonCount = state.buttons.length;
    const axisCount = state.axes.length;
    const bitmaskBytes = Math.ceil(buttonCount / 8);

    const bufferSize = 1 + bitmaskBytes + (buttonCount * 4) + 1 + (axisCount * 4);
    const buffer = new ArrayBuffer(bufferSize);
    const view = new DataView(buffer);
    let offset = 0;

    // Button count
    view.setUint8(offset++, buttonCount);

    // Button bitmask (packed bits)
    for (let i = 0; i < bitmaskBytes; i++) {
      let byte = 0;
      for (let bit = 0; bit < 8; bit++) {
        const idx = i * 8 + bit;
        if (idx < buttonCount && state.buttons[idx]) {
          byte |= (1 << bit);
        }
      }
      view.setUint8(offset++, byte);
    }

    // Button analog values
    for (let i = 0; i < buttonCount; i++) {
      view.setFloat32(offset, state.buttonValues[i], true);
      offset += 4;
    }

    // Axis count
    view.setUint8(offset++, axisCount);

    // Axis values
    for (let i = 0; i < axisCount; i++) {
      view.setFloat32(offset, state.axes[i], true);
      offset += 4;
    }

    this.sender(buffer);
  }

  get isConnected(): boolean {
    return this.connected;
  }
}
