import { appConfig } from "@/application/config/app-config";
import { sessionHolder } from "@/authentication/storage/session-holder";

export type UploaderStatus = "disconnected" | "connecting" | "connected";
export type RecordingType = "study" | "test";

export interface UploadFrame {
  captureEpochMs: number;
  cameraFrameCounter: number | null;
  bytes: Uint8Array;
}

interface FrameUploaderEvents {
  onStatusChange: (status: UploaderStatus) => void;
  onQueueChange: (queuedFrames: number) => void;
  onFrameUploaded: () => void;
}

const RECONNECT_DELAY_MS = 3_000;
const HEARTBEAT_INTERVAL_MS = 20_000;
// ~25 MB worst case at 50 KB/frame; protects memory if the server is
// unreachable for many hours. Oldest frames are dropped first (logged).
const MAX_QUEUED_FRAMES = 500;

// React Native's WebSocket accepts a third options argument with custom
// headers (how the bearer token rides on the upgrade request); the standard
// lib type does not know it.
type WebSocketWithHeaders = new (
  url: string,
  protocols: string | string[] | null,
  options: { headers: Record<string, string> },
) => WebSocket;

// Relays assembled frames to the ingestion server over an authenticated
// WebSocket. Each frame is a JSON metadata message ({t, n}, phone-stamped
// capture time) followed by the binary JPEG — the same two-message protocol
// the WiFi firmware used. Reconnects forever while running; frames queue in
// memory while the link is down (e.g. VPN drop) and flush on reconnect.
export class FrameUploader {
  private webSocket: WebSocket | null = null;
  private readonly queue: UploadFrame[] = [];
  private running = false;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly config: {
      sessionId: number;
      deviceId: string;
      recordingType: RecordingType;
    },
    private readonly events: FrameUploaderEvents,
  ) {}

  start(): void {
    if (this.running) return;
    this.running = true;
    this.connect();
    this.heartbeatTimer = setInterval(() => {
      if (this.webSocket?.readyState === WebSocket.OPEN) {
        this.webSocket.send("heartbeat");
      }
    }, HEARTBEAT_INTERVAL_MS);
  }

  stop(): void {
    this.running = false;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.flush(); // best effort for anything still queued
    this.webSocket?.close();
    this.webSocket = null;
    this.events.onStatusChange("disconnected");
  }

  enqueue(frame: UploadFrame): void {
    if (this.queue.length >= MAX_QUEUED_FRAMES) {
      this.queue.shift();
      console.warn("FrameUploader: queue full, dropped oldest frame");
    }
    this.queue.push(frame);
    this.events.onQueueChange(this.queue.length);
    this.flush();
  }

  private connect(): void {
    if (!this.running) return;
    const token = sessionHolder.getToken();
    if (!token) return;

    this.events.onStatusChange("connecting");
    const url = `${appConfig.webSocketUrl}/ingest?session=${this.config.sessionId}&device=${this.config.deviceId}&recordingType=${this.config.recordingType}`;
    const webSocket = new (WebSocket as unknown as WebSocketWithHeaders)(
      url,
      null,
      { headers: { Authorization: `Bearer ${token}` } },
    );
    this.webSocket = webSocket;

    webSocket.onopen = () => {
      this.events.onStatusChange("connected");
      this.flush();
    };
    webSocket.onerror = () => {};
    webSocket.onclose = () => {
      if (this.webSocket === webSocket) this.webSocket = null;
      this.events.onStatusChange("disconnected");
      this.scheduleReconnect();
    };
  }

  private scheduleReconnect(): void {
    if (!this.running || this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, RECONNECT_DELAY_MS);
  }

  private flush(): void {
    const webSocket = this.webSocket;
    if (!webSocket || webSocket.readyState !== WebSocket.OPEN) return;
    while (this.queue.length > 0) {
      const frame = this.queue[0];
      try {
        webSocket.send(
          JSON.stringify({ t: frame.captureEpochMs, n: frame.cameraFrameCounter }),
        );
        webSocket.send(frame.bytes.buffer as ArrayBuffer);
      } catch {
        // Send failed: keep the frame queued; onclose will trigger reconnect.
        break;
      }
      this.queue.shift();
      this.events.onFrameUploaded();
    }
    this.events.onQueueChange(this.queue.length);
  }
}
