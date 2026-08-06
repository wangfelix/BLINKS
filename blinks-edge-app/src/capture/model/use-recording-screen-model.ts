import { useQueryClient } from "@tanstack/react-query";
import { useRouter } from "expo-router";
import { useEffect, useState } from "react";

import {
  formatDurationMs,
  formatTimeOfDay,
} from "@/application/utils/format-time";
import { CameraLinkStatus } from "@/capture/ble/camera-link";
import {
  getElapsedActiveMs,
  useRecordingSession,
} from "@/capture/model/use-recording-session";
import { UploaderStatus } from "@/capture/relay/frame-uploader";
import { isStudySessionEndAvailable } from "@/capture/utils/end-session-availability";
import { sessionKeys } from "@/sessions/query-options/session-queries";

const cameraStatusLabels: Record<CameraLinkStatus, string> = {
  idle: "Not connected",
  bluetoothOff: "Bluetooth is off",
  scanning: "Searching for camera…",
  connecting: "Connecting…",
  connected: "Connected",
};

const uploaderStatusLabels: Record<UploaderStatus, string> = {
  disconnected: "Offline (frames are queued)",
  connecting: "Connecting…",
  connected: "Connected",
};

export const useRecordingScreenModel = () => {
  const router = useRouter();
  const queryClient = useQueryClient();
  const { session, pauseSession, resumeSession, endSession } =
    useRecordingSession();

  // ---- STATE ----

  const isPaused = session.phase === "paused";
  const isIdle = session.phase === "idle";
  const isTestSession = session.kind === "test";
  const [isEndConfirmationVisible, setIsEndConfirmationVisible] =
    useState(false);
  const [isEnding, setIsEnding] = useState(false);

  // Re-render once per second so the elapsed time ticks.
  const [, setTick] = useState(0);
  useEffect(() => {
    if (isIdle) return;
    const interval = setInterval(() => setTick((value) => value + 1), 1000);
    return () => clearInterval(interval);
  }, [isIdle]);

  const elapsedLabel = formatDurationMs(getElapsedActiveMs(session));
  const cameraStatusLabel = cameraStatusLabels[session.cameraStatus];
  const serverStatusLabel = uploaderStatusLabels[session.uploaderStatus];
  const lastFrameLabel = session.lastFrameAtMs
    ? formatTimeOfDay(session.lastFrameAtMs)
    : "—";
  const framesLabel =
    session.queuedFrames > 0
      ? `${session.framesUploaded} sent · ${session.queuedFrames} queued`
      : `${session.framesUploaded} sent`;
  const isEndSessionAvailable =
    isTestSession ||
    isStudySessionEndAvailable(Date.now(), session.sessionId);

  // ---- ACTIONS ----

  const togglePause = () => {
    if (isPaused) {
      void resumeSession();
    } else {
      void pauseSession();
    }
  };

  const confirmEndSession = () => {
    if (!isEndSessionAvailable || isEnding) return;
    setIsEndConfirmationVisible(true);
  };

  const cancelEndSession = () => {
    if (isEnding) return;
    setIsEndConfirmationVisible(false);
  };

  const endSelectedSession = async () => {
    if (!isEndSessionAvailable || isEnding) return;

    setIsEnding(true);
    try {
      await endSession();
      if (!isTestSession) {
        await queryClient.invalidateQueries({
          queryKey: sessionKeys.all,
        });
      }
      setIsEndConfirmationVisible(false);
      router.back();
    } finally {
      setIsEnding(false);
    }
  };

  const closeScreen = () => router.back();

  // ---- RETURN ----

  return {
    isIdle,
    isPaused,
    isTestSession,
    elapsedLabel,
    cameraStatusLabel,
    serverStatusLabel,
    framesLabel,
    lastFrameLabel,
    framesReceived: session.framesReceived,
    isEndSessionAvailable,
    isEndConfirmationVisible,
    isEnding,
    togglePause,
    confirmEndSession,
    cancelEndSession,
    endSelectedSession,
    closeScreen,
  };
};
