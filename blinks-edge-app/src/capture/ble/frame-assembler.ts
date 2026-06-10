import { toByteArray } from "base64-js";

import {
  FRAME_TAG_DATA,
  FRAME_TAG_HEADER,
  FRAME_TIMEOUT_MS,
  MAX_FRAME_BYTES,
} from "@/capture/ble/ble-constants";

export interface AssembledFrame {
  bytes: Uint8Array;
  // Stamped when the frame HEADER arrives. The firmware sends the header
  // immediately after capture, so header receipt is the closest observable to
  // the true capture time (the ESP32 has no clock); stamping at frame
  // completion would be off by the multi-second BLE transfer.
  captureEpochMs: number;
  // The camera's own frame counter (from the header); gaps = frames captured
  // but never delivered. Null with firmware that predates the 9-byte header.
  cameraFrameCounter: number | null;
}

const readUint32BE = (bytes: Uint8Array, offset: number): number =>
  ((bytes[offset] << 24) |
    (bytes[offset + 1] << 16) |
    (bytes[offset + 2] << 8) |
    bytes[offset + 3]) >>>
  0;

// Reassembles JPEG frames from the camera's tagged BLE notifications. The
// tagged framing is self-syncing: a dropped chunk loses at most one frame and
// the next header starts a clean frame (validated in the feasibility spike).
export class FrameAssembler {
  private chunks: Uint8Array[] = [];
  private expectedLength = 0;
  private receivedLength = 0;
  private collecting = false;
  private headerReceivedAtMs = 0;
  private cameraFrameCounter: number | null = null;
  private lastChunkAtMs = 0;

  // Feed one notification value (base64, as delivered by react-native-ble-plx).
  // Returns the completed frame when this chunk finishes one, else null.
  push(base64Value: string): AssembledFrame | null {
    const chunk = toByteArray(base64Value);
    if (chunk.length < 1) return null;

    const nowMs = Date.now();
    if (this.collecting && nowMs - this.lastChunkAtMs > FRAME_TIMEOUT_MS) {
      this.reset();
    }
    this.lastChunkAtMs = nowMs;

    if (chunk[0] === FRAME_TAG_HEADER) {
      if (chunk.length < 5) return null;
      const length = readUint32BE(chunk, 1);
      if (length <= 0 || length > MAX_FRAME_BYTES) {
        this.reset();
        return null;
      }
      this.reset();
      this.collecting = true;
      this.expectedLength = length;
      this.headerReceivedAtMs = nowMs;
      this.cameraFrameCounter =
        chunk.length >= 9 ? readUint32BE(chunk, 5) : null;
      return null;
    }

    if (chunk[0] === FRAME_TAG_DATA) {
      if (!this.collecting) return null; // stray data before a header
      const payload = chunk.subarray(1);
      this.chunks.push(payload);
      this.receivedLength += payload.length;
      if (this.receivedLength < this.expectedLength) return null;

      const frame: AssembledFrame = {
        bytes: this.concatChunks(),
        captureEpochMs: this.headerReceivedAtMs,
        cameraFrameCounter: this.cameraFrameCounter,
      };
      this.reset();
      return frame;
    }

    return null;
  }

  reset(): void {
    this.chunks = [];
    this.expectedLength = 0;
    this.receivedLength = 0;
    this.collecting = false;
    this.cameraFrameCounter = null;
  }

  private concatChunks(): Uint8Array {
    const combined = new Uint8Array(this.expectedLength);
    let offset = 0;
    for (const chunk of this.chunks) {
      const remaining = this.expectedLength - offset;
      if (remaining <= 0) break;
      combined.set(
        chunk.length <= remaining ? chunk : chunk.subarray(0, remaining),
        offset,
      );
      offset += Math.min(chunk.length, remaining);
    }
    return combined;
  }
}
