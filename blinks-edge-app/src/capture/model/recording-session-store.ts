import {
  fetchRecordingState,
  RecordingEventType,
  RecordingStateResponse,
} from "@/capture/api/capture-api";
import { CameraLink, CameraLinkStatus } from "@/capture/ble/camera-link";
import { AssembledFrame } from "@/capture/ble/frame-assembler";
import { rotateJpeg } from "@/capture/image/rotate-jpeg";
import { FrameUploader, UploaderStatus } from "@/capture/relay/frame-uploader";
import {
  startCaptureForegroundService,
  stopCaptureForegroundService,
} from "@/capture/service/foreground-service";
import {
  clearStoredActiveRecording,
  loadStoredActiveRecording,
  StoredActiveRecording,
  storeActiveRecording,
} from "@/capture/storage/active-recording-storage";
import {
  flushPendingRecordingEvents,
  getNextQueuedSequenceNumber,
  queueRecordingEvent,
} from "@/capture/storage/recording-event-queue";
import {
  getCurrentImageRotation,
  loadImageRotation,
} from "@/study-settings/storage/image-rotation-storage";

export type RecordingPhase = "idle" | "recording" | "paused";
export type RecordingSessionKind = "study" | "test";
export type RecordingRestorationStatus =
  | "notStarted"
  | "restoring"
  | "ready";

export interface RecordingSessionState {
  phase: RecordingPhase;
  kind: RecordingSessionKind | null;
  restorationStatus: RecordingRestorationStatus;
  hasKnownSession: boolean;
  sessionCompleted: boolean;
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
  kind: null,
  restorationStatus: "notStarted",
  hasKnownSession: false,
  sessionCompleted: false,
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

const ACTIVE_STATE_SAVE_INTERVAL_MS = 30_000;

type Listener = () => void;

// Singleton store for the active recording session. Runtime state lives outside
// React, while a compact per-user snapshot and the server's append-only event
// stream allow the same session to be reconstructed after process termination.
class RecordingSessionStore {
  private state: RecordingSessionState = idleState;
  private readonly listeners = new Set<Listener>();
  private cameraLink: CameraLink | null = null;
  private uploader: FrameUploader | null = null;
  private frameProcessingChain: Promise<void> = Promise.resolve();
  private nextEventSequence = 0;
  private sessionStartedAtMs: number | null = null;
  private persistenceTimer: ReturnType<typeof setInterval> | null = null;
  private restorePromise: Promise<void> | null = null;
  private restoreGeneration = 0;

  subscribe = (listener: Listener): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getSnapshot = (): RecordingSessionState => this.state;

  restore = (): Promise<void> => {
    if (this.restorePromise) return this.restorePromise;
    if (this.state.phase !== "idle") return Promise.resolve();

    const generation = ++this.restoreGeneration;
    this.setState({ restorationStatus: "restoring" });
    this.restorePromise = this.performRestore(generation)
      .catch((error) => console.warn("Recording restoration failed:", error))
      .finally(() => {
        if (generation !== this.restoreGeneration) return;
        this.restorePromise = null;
        if (this.state.restorationStatus === "restoring") {
          this.setState({ restorationStatus: "ready" });
        }
      });
    return this.restorePromise;
  };

  start = async (): Promise<void> => {
    await this.startNewSession("study");
  };

  startTest = async (): Promise<void> => {
    await this.startNewSession("test");
  };

  private startNewSession = async (
    kind: RecordingSessionKind,
  ): Promise<void> => {
    if (
      this.state.phase !== "idle" ||
      this.state.restorationStatus === "restoring" ||
      this.state.hasKnownSession
    ) {
      return;
    }
    const nowMs = Date.now();
    this.sessionStartedAtMs = nowMs;
    this.nextEventSequence = 0;
    this.setState({
      ...idleState,
      phase: "recording",
      kind,
      restorationStatus: "ready",
      hasKnownSession: kind === "study",
      sessionId: Math.floor(nowMs / 1000),
      activeSinceMs: nowMs,
    });
    if (kind === "study") {
      await this.persistSnapshot().catch((error) =>
        console.warn("Failed to persist active recording:", error),
      );
      await this.recordEvent("start", nowMs).catch((error) =>
        console.warn("Failed to persist recording start:", error),
      );
    }
    await this.startCaptureRuntime(false);
    this.updatePersistenceTimer();
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
    this.updatePersistenceTimer();
    await this.cameraLink?.setPaused(true);
    if (this.state.kind === "test") return;

    const snapshotPromise = this.persistSnapshot().catch((error) =>
      console.warn("Failed to persist recording pause state:", error),
    );
    const eventPromise = this.recordEvent("pause", nowMs).catch((error) =>
      console.warn("Failed to persist recording pause:", error),
    );
    await Promise.all([snapshotPromise, eventPromise]);
  };

  resume = async (): Promise<void> => {
    if (this.state.phase !== "paused") return;
    const nowMs = Date.now();
    this.setState({ phase: "recording", activeSinceMs: nowMs });
    this.updatePersistenceTimer();
    await this.cameraLink?.setPaused(false);
    if (this.state.kind === "test") return;

    const snapshotPromise = this.persistSnapshot().catch((error) =>
      console.warn("Failed to persist recording resume state:", error),
    );
    const eventPromise = this.recordEvent("resume", nowMs).catch((error) =>
      console.warn("Failed to persist recording resume:", error),
    );
    await Promise.all([snapshotPromise, eventPromise]);
  };

  end = async (): Promise<void> => {
    if (this.state.phase === "idle") return;
    if (this.state.kind === "test") {
      await this.stopCaptureRuntime();
      this.sessionStartedAtMs = null;
      this.setState({ ...idleState, restorationStatus: "ready" });
      return;
    }

    await this.persistSnapshot("ending").catch((error) =>
      console.warn("Failed to persist ending recording state:", error),
    );

    let endEventQueued = true;
    const eventPromise = this.recordEvent("end", Date.now(), false, false).catch(
      (error) => {
        endEventQueued = false;
        console.warn("Failed to persist recording end:", error);
      },
    );
    await this.stopCaptureRuntime();
    await eventPromise;
    if (endEventQueued) {
      await clearStoredActiveRecording().catch(() => {});
    }
    await flushPendingRecordingEvents();
    this.nextEventSequence = 0;
    this.sessionStartedAtMs = null;
    this.setState({
      ...idleState,
      restorationStatus: "ready",
      hasKnownSession: true,
      sessionCompleted: true,
    });
  };

  // Signing out stops local capture without ending the research session. The
  // per-user snapshot remains available for the same participant's next login.
  suspend = async (): Promise<void> => {
    this.restoreGeneration += 1;
    this.restorePromise = null;
    if (this.state.phase !== "idle" && this.state.kind === "study") {
      await this.persistSnapshot().catch(() => {});
    }
    await this.stopCaptureRuntime();
    this.nextEventSequence = 0;
    this.sessionStartedAtMs = null;
    this.setState(idleState);
  };

  private async performRestore(generation: number): Promise<void> {
    const stored = await loadStoredActiveRecording().catch((error) => {
      console.warn("Stored recording state could not be loaded:", error);
      return null;
    });
    if (generation !== this.restoreGeneration) return;

    if (stored?.phase === "ending") {
      this.setState({
        ...idleState,
        restorationStatus: "restoring",
        hasKnownSession: true,
        sessionCompleted: true,
      });
    } else if (stored) {
      const queuedNextSequence = await getNextQueuedSequenceNumber(
        stored.sessionId,
      );
      if (generation !== this.restoreGeneration) return;
      await this.activateRestoredSession(
        {
          ...stored,
          nextSequenceNumber: Math.max(
            stored.nextSequenceNumber,
            queuedNextSequence,
          ),
        },
        generation,
      );
      if (generation !== this.restoreGeneration) return;
    }

    if (stored) {
      await queueRecordingEvent(
        {
          eventId: `${stored.sessionId}-0`,
          session: stored.sessionId,
          eventType: "start",
          clientEpochMs: stored.startedAtMs,
          sequenceNumber: 0,
        },
        { deliver: false },
      ).catch((error) =>
        console.warn("Failed to restore the recording start event:", error),
      );
    }
    if (generation !== this.restoreGeneration) return;
    await flushPendingRecordingEvents();
    if (generation !== this.restoreGeneration) return;

    let serverState: RecordingStateResponse;
    try {
      serverState = await fetchRecordingState();
    } catch (error) {
      console.warn("Server recording state unavailable; using local state:", error);
      return;
    }
    if (generation !== this.restoreGeneration) return;

    if (serverState.active && serverState.sessionId && serverState.startedAtMs) {
      if (stored?.phase === "ending") return;
      await this.reconcileActiveServerState(serverState, generation);
      return;
    }

    if (serverState.completed) {
      await this.stopCaptureRuntime();
      if (generation !== this.restoreGeneration) return;
      await clearStoredActiveRecording().catch(() => {});
      if (generation !== this.restoreGeneration) return;
      this.nextEventSequence = 0;
      this.sessionStartedAtMs = null;
      this.setState({
        ...idleState,
        restorationStatus: "restoring",
        hasKnownSession: true,
        sessionCompleted: true,
      });
      return;
    }

    if (!serverState.hasSession && !stored) {
      this.setState({ ...idleState, restorationStatus: "restoring" });
    }
  }

  private async activateRestoredSession(
    stored: StoredActiveRecording,
    generation?: number,
  ): Promise<void> {
    if (
      generation !== undefined &&
      generation !== this.restoreGeneration
    ) {
      return;
    }
    const phase = stored.phase === "paused" ? "paused" : "recording";
    this.nextEventSequence = stored.nextSequenceNumber;
    this.sessionStartedAtMs = stored.startedAtMs;
    this.setState({
      ...idleState,
      phase,
      kind: "study",
      restorationStatus: "restoring",
      hasKnownSession: true,
      sessionId: stored.sessionId,
      accumulatedActiveMs: stored.accumulatedActiveMs,
      activeSinceMs: phase === "recording" ? Date.now() : null,
    });
    await this.startCaptureRuntime(phase === "paused");
    if (
      generation !== undefined &&
      generation !== this.restoreGeneration
    ) {
      await this.stopCaptureRuntime();
      return;
    }
    this.updatePersistenceTimer();
  }

  private async reconcileActiveServerState(
    serverState: RecordingStateResponse,
    generation: number,
  ): Promise<void> {
    if (generation !== this.restoreGeneration) return;
    const phase = serverState.phase === "paused" ? "paused" : "recording";
    if (
      this.state.phase === "idle" ||
      this.state.sessionId !== serverState.sessionId
    ) {
      await this.stopCaptureRuntime();
      await this.activateRestoredSession(
        {
          version: 1,
          sessionId: serverState.sessionId!,
          startedAtMs: serverState.startedAtMs!,
          phase,
          accumulatedActiveMs: serverState.accumulatedActiveMs,
          nextSequenceNumber: serverState.nextSequenceNumber,
          savedAtMs: Date.now(),
        },
        generation,
      );
      return;
    }

    this.nextEventSequence = Math.max(
      this.nextEventSequence,
      serverState.nextSequenceNumber,
    );
    this.sessionStartedAtMs = serverState.startedAtMs;
    this.setState({
      phase,
      kind: "study",
      accumulatedActiveMs: serverState.accumulatedActiveMs,
      activeSinceMs: phase === "recording" ? Date.now() : null,
      hasKnownSession: true,
      sessionCompleted: false,
    });
    await this.cameraLink?.setPaused(phase === "paused");
    if (generation !== this.restoreGeneration) return;
    this.updatePersistenceTimer();
    await this.persistSnapshot().catch(() => {});
  }

  private async startCaptureRuntime(paused: boolean): Promise<void> {
    if (this.cameraLink) return;
    // Initialize the device-local cache before frames arrive. handleFrame reads
    // that cache for every frame so changes take effect during a recording.
    await loadImageRotation();
    this.frameProcessingChain = Promise.resolve();
    await startCaptureForegroundService(this.state.kind === "test").catch(
      (error) => console.warn("Foreground service failed to start:", error),
    );
    this.cameraLink = new CameraLink({
      onStatusChange: (cameraStatus) => this.setState({ cameraStatus }),
      onDeviceIdentified: (deviceId) => this.ensureUploader(deviceId),
      onFrame: (frame) => this.handleFrame(frame),
    });
    await this.cameraLink.setPaused(paused);
    this.cameraLink.start();
  }

  private async stopCaptureRuntime(): Promise<void> {
    this.clearPersistenceTimer();
    const cameraLink = this.cameraLink;
    const uploader = this.uploader;
    this.cameraLink = null;
    await cameraLink?.stop().catch(() => {});
    // Frames are transformed serially to preserve BLE order. Wait for the last
    // received frame before closing the uploader.
    await this.frameProcessingChain;
    this.uploader = null;
    uploader?.stop();
    await stopCaptureForegroundService().catch(() => {});
  }

  private ensureUploader(deviceId: string): void {
    if (this.uploader || this.state.sessionId === null) return;
    this.uploader = new FrameUploader(
      {
        sessionId: this.state.sessionId,
        deviceId,
        recordingType: this.state.kind ?? "study",
      },
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
    const uploader = this.uploader;
    // Capture the angle when this frame arrives. A settings change therefore
    // affects the next frame without changing already-received frames.
    const rotation = getCurrentImageRotation();
    this.frameProcessingChain = this.frameProcessingChain.then(async () => {
      let bytes = frame.bytes;
      if (rotation !== 0) {
        try {
          bytes = await rotateJpeg(frame.bytes, rotation);
        } catch (error) {
          // Preserve the frame if the native transform fails rather than
          // silently creating a gap in the research day.
          console.warn("Failed to rotate frame before upload:", error);
        }
      }
      uploader?.enqueue({
        captureEpochMs: frame.captureEpochMs,
        cameraFrameCounter: frame.cameraFrameCounter,
        bytes,
      });
    });
  }

  private async recordEvent(
    eventType: RecordingEventType,
    clientEpochMs: number,
    deliver = true,
    persistAfterQueue = true,
  ): Promise<void> {
    if (this.state.sessionId === null) {
      throw new Error("recording session has no session ID");
    }
    const sequenceNumber = this.nextEventSequence;
    await queueRecordingEvent(
      {
        eventId: `${this.state.sessionId}-${sequenceNumber}`,
        session: this.state.sessionId,
        eventType,
        clientEpochMs,
        sequenceNumber,
      },
      { deliver },
    );
    this.nextEventSequence = sequenceNumber + 1;
    if (persistAfterQueue) await this.persistSnapshot();
  }

  private async persistSnapshot(
    phaseOverride?: StoredActiveRecording["phase"],
  ): Promise<void> {
    if (
      this.state.sessionId === null ||
      this.sessionStartedAtMs === null ||
      this.state.phase === "idle" ||
      this.state.kind !== "study"
    ) {
      return;
    }
    const nowMs = Date.now();
    const accumulatedActiveMs =
      this.state.accumulatedActiveMs +
      (this.state.activeSinceMs ? nowMs - this.state.activeSinceMs : 0);
    await storeActiveRecording({
      version: 1,
      sessionId: this.state.sessionId,
      startedAtMs: this.sessionStartedAtMs,
      phase: phaseOverride ?? this.state.phase,
      accumulatedActiveMs,
      nextSequenceNumber: this.nextEventSequence,
      savedAtMs: nowMs,
    });
  }

  private updatePersistenceTimer(): void {
    this.clearPersistenceTimer();
    if (this.state.phase !== "recording" || this.state.kind !== "study") return;
    this.persistenceTimer = setInterval(() => {
      void this.persistSnapshot().catch((error) =>
        console.warn("Failed to refresh active recording state:", error),
      );
    }, ACTIVE_STATE_SAVE_INTERVAL_MS);
  }

  private clearPersistenceTimer(): void {
    if (!this.persistenceTimer) return;
    clearInterval(this.persistenceTimer);
    this.persistenceTimer = null;
  }

  private setState(partial: Partial<RecordingSessionState>): void {
    this.state = { ...this.state, ...partial };
    for (const listener of this.listeners) listener();
  }
}

export const recordingSessionStore = new RecordingSessionStore();
