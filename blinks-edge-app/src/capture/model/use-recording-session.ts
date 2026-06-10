import { useSyncExternalStore } from "react";

import {
  recordingSessionStore,
  RecordingSessionState,
} from "@/capture/model/recording-session-store";

export interface RecordingSessionHandle {
  session: RecordingSessionState;
  startSession: () => Promise<void>;
  pauseSession: () => Promise<void>;
  resumeSession: () => Promise<void>;
  endSession: () => Promise<void>;
}

export const useRecordingSession = (): RecordingSessionHandle => {
  const session = useSyncExternalStore(
    recordingSessionStore.subscribe,
    recordingSessionStore.getSnapshot,
  );

  return {
    session,
    startSession: recordingSessionStore.start,
    pauseSession: recordingSessionStore.pause,
    resumeSession: recordingSessionStore.resume,
    endSession: recordingSessionStore.end,
  };
};

export const getElapsedActiveMs = (session: RecordingSessionState): number =>
  session.accumulatedActiveMs +
  (session.activeSinceMs ? Date.now() - session.activeSinceMs : 0);
