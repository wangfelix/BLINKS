import { CONTROL_OPCODE_SET_INTERVAL } from "@/capture/ble/ble-constants";

// Contents of the device-info characteristic 0004 (docs/ble-capture-config.md).
export interface CameraDeviceInfo {
  v: number;
  fw: string;
  formFactor: string;
  intervalMs: number;
  defaultMs: number;
  minMs: number;
  maxMs: number;
}

const isFiniteNumber = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value);

/** Parses the 0004 payload; null for invalid JSON (treated as unsupported). */
export const parseCameraDeviceInfo = (
  bytes: Uint8Array,
): CameraDeviceInfo | null => {
  try {
    // Compact ASCII JSON; avoids depending on TextDecoder in Hermes.
    const text = String.fromCharCode(...bytes);
    const value = JSON.parse(text) as Record<string, unknown>;
    if (
      !value ||
      typeof value !== "object" ||
      !isFiniteNumber(value.v) ||
      typeof value.fw !== "string" ||
      typeof value.formFactor !== "string" ||
      !isFiniteNumber(value.intervalMs) ||
      !isFiniteNumber(value.defaultMs) ||
      !isFiniteNumber(value.minMs) ||
      !isFiniteNumber(value.maxMs)
    ) {
      return null;
    }
    return {
      v: value.v,
      fw: value.fw,
      formFactor: value.formFactor,
      intervalMs: value.intervalMs,
      defaultMs: value.defaultMs,
      minMs: value.minMs,
      maxMs: value.maxMs,
    };
  } catch {
    return null;
  }
};

/** [0x03][uint32 BE intervalMs], exactly 5 bytes. */
export const encodeSetIntervalCommand = (intervalMs: number): Uint8Array => {
  const value = Math.max(0, Math.min(0xffffffff, Math.round(intervalMs)));
  const bytes = new Uint8Array(5);
  bytes[0] = CONTROL_OPCODE_SET_INTERVAL;
  new DataView(bytes.buffer).setUint32(1, value, false);
  return bytes;
};

/**
 * Human-readable warning for Study Settings, or null when the camera applied
 * exactly what the app asked for. Study Settings always wins on mismatch.
 */
export const cameraIntervalWarning = (
  info: CameraDeviceInfo,
  requestedMs: number,
  appFormFactor: string,
  formFactorLabel: (key: string) => string = (key) => key,
): string | null => {
  const warnings: string[] = [];
  if (info.formFactor !== appFormFactor) {
    warnings.push(
      `The camera reports “${formFactorLabel(info.formFactor)}”, Study Settings say “${formFactorLabel(appFormFactor)}”. The Study Settings interval is used.`,
    );
  }
  if (info.intervalMs !== requestedMs) {
    warnings.push(
      `The camera uses ${formatSeconds(info.intervalMs)} instead of the configured ${formatSeconds(requestedMs)} (allowed ${formatSeconds(info.minMs)}–${formatSeconds(info.maxMs)}).`,
    );
  }
  return warnings.length > 0 ? warnings.join(" ") : null;
};

const formatSeconds = (ms: number): string =>
  `${Number.isInteger(ms / 1_000) ? ms / 1_000 : (ms / 1_000).toFixed(1)} s`;

// Latest result of the connect sequence, shown in Study Settings.
export interface CameraCaptureConfigState {
  deviceInfo: CameraDeviceInfo | null;
  /** null = no camera connected yet in this recording. */
  supportsInterval: boolean | null;
  warning: string | null;
}

let state: CameraCaptureConfigState = {
  deviceInfo: null,
  supportsInterval: null,
  warning: null,
};
const listeners = new Set<() => void>();

export const cameraCaptureConfigStore = {
  getState: (): CameraCaptureConfigState => state,
  subscribe: (listener: () => void): (() => void) => {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
  set: (next: CameraCaptureConfigState): void => {
    state = next;
    listeners.forEach((listener) => listener());
  },
};
