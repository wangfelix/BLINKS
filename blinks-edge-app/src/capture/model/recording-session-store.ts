import {
  notifyRecordingEnded,
  pauseCaptureOnServer,
  resumeCaptureOnServer,
} from "@/capture/api/capture-api";
import { CameraLink, CameraLinkStatus } from "@/capture/ble/camera-link";
import { AssembledFrame } from "@/capture/ble/frame-assembler";
import { FrameUploader, UploaderStatus } from "@/capture/relay/frame-uploader";
import {
  startCaptureForegroundService,
  stopCaptureForegroundService,
} from "@/capture/service/foreground-service";

export type RecordingPhase = "idle" | "recording" | "paused";

export interface RecordingSessionState {
  phase: RecordingPhase;
  // Epoch seconds of the moment the participant started the session; also the
  // session key under which the server stores this session's frames.
  sessionId: number | null;
  cameraStatus: CameraLinkStatus;
  uploaderStatus: UploaderStatus;
  framesReceived: number;
  framesUploaded: number;
  queuedFrames: number;
  lastFrameAtMs: number | null;
  // Active (non-paused) recording time = accumulatedActiveMs, plus the time
  // since activeSinceMs when currently recording.
  accumulatedActiveMs: number;
  activeSinceMs: number | null;
}

const idleState: RecordingSessionState = {
  phase: "idle",
  sessionId: null,
  cameraStatus: "idle",
  uploaderStatus: "disconnected",
  framesReceived: 0,
  framesUploaded: 0,
  queuedFrames: 0,
  lastFrameAtMs: null,
  accumulatedActiveMs: 0,
  activeSinceMs: null,
};

type Listener = () => void;

// Singleton store for the active recording session. It lives outside React so
// the session survives navigation and backgrounding (the notifee foreground
// service keeps the JS runtime alive); screens subscribe via
// useSyncExternalStore in use-recording-session.ts.
class RecordingSessionStore {
  private state: RecordingSessionState = idleState;
  private readonly listeners = new Set<Listener>();
  private cameraLink: CameraLink | null = null;
  private uploader: FrameUploader | null = null;

  subscribe = (listener: Listener): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getSnapshot = (): RecordingSessionState => this.state;

  start = async (): Promise<void> => {
    if (this.state.phase !== "idle") return;
    const nowMs = Date.now();
    this.setState({
      ...idleState,
      phase: "recording",
      sessionId: Math.floor(nowMs / 1000),
      activeSinceMs: nowMs,
    });

    await startCaptureForegroundService().catch((error) =>
      console.warn("Foreground service failed to start:", error),
    );

    this.cameraLink = new CameraLink({
      onStatusChange: (cameraStatus) => this.setState({ cameraStatus }),
      onDeviceIdentified: (deviceId) => this.ensureUploader(deviceId),
      onFrame: (frame) => this.handleFrame(frame),
    });
    this.cameraLink.start();
  };

  pause = async (): Promise<void> => {
    if (this.state.phase !== "recording") return;
    const nowMs = Date.now();
    this.setState({
      phase: "paused",
      accumulatedActiveMs:
        this.state.accumulatedActiveMs +
        (this.state.activeSinceMs ? nowMs - this.state.activeSinceMs : 0),
      activeSinceMs: null,
    });
    await this.cameraLink?.setPaused(true);
    pauseCaptureOnServer().catch((error) =>
      console.warn("Server pause failed:", error),
    );
  };

  resume = async (): Promise<void> => {
    if (this.state.phase !== "paused") return;
    this.setState({ phase: "recording", activeSinceMs: Date.now() });
    await this.cameraLink?.setPaused(false);
    resumeCaptureOnServer().catch((error) =>
      console.warn("Server resume failed:", error),
    );
  };

  end = async (): Promise<void> => {
    if (this.state.phase === "idle") return;
    const cameraLink = this.cameraLink;
    const uploader = this.uploader;
    this.cameraLink = null;
    this.uploader = null;

    await cameraLink?.stop().catch(() => {});
    // stop() flushes the remaining queue into the socket (best effort); after
    // it, no frame of this session can ever reach the server again.
    uploader?.stop();
    // Deliberate Stop (not Pause): tell the server the recording is over so
    // the last 5-minute chunk goes to the VLM now. Fire-and-forget — the
    // server's idle sweep covers the offline case.
    notifyRecordingEnded().catch((error) =>
      console.warn("End-of-recording signal failed:", error),
    );
    await stopCaptureForegroundService().catch(() => {});
    this.setState(idleState);
  };

  private ensureUploader(deviceId: string): void {
    if (this.uploader || this.state.sessionId === null) return;
    this.uploader = new FrameUploader(
      { sessionId: this.state.sessionId, deviceId },
      {
        onStatusChange: (uploaderStatus) => this.setState({ uploaderStatus }),
        onQueueChange: (queuedFrames) => this.setState({ queuedFrames }),
        onFrameUploaded: () =>
          this.setState({ framesUploaded: this.state.framesUploaded + 1 }),
      },
    );
    this.uploader.start();
  }

  private handleFrame(frame: AssembledFrame): void {
    // Defense in depth: the camera should not capture while paused, but a
    // frame can be in flight around the pause write. Never relay it.
    if (this.state.phase !== "recording") return;
    this.setState({
      framesReceived: this.state.framesReceived + 1,
      lastFrameAtMs: frame.captureEpochMs,
    });
    this.uploader?.enqueue({
      captureEpochMs: frame.captureEpochMs,
      cameraFrameCounter: frame.cameraFrameCounter,
      bytes: frame.bytes,
    });
  }

  private setState(partial: Partial<RecordingSessionState>): void {
    this.state = { ...this.state, ...partial };
    for (const listener of this.listeners) listener();
  }
}

export const recordingSessionStore = new RecordingSessionStore();
