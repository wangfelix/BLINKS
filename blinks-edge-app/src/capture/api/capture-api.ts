import { apiClient } from "@/application/api/api-client";

export type RecordingEventType = "start" | "pause" | "resume" | "end";

export interface RecordingEventPayload {
  eventId: string;
  session: number;
  eventType: RecordingEventType;
  clientEpochMs: number;
  sequenceNumber: number;
}

export interface RecordingStateResponse {
  hasSession: boolean;
  active: boolean;
  completed: boolean;
  sessionId: number | null;
  startedAtMs: number | null;
  phase: "idle" | "recording" | "paused";
  nextSequenceNumber: number;
  accumulatedActiveMs: number;
}

interface RecordingEventResponse {
  ok: true;
  eventId: string;
  serverReceivedEpochMs: number;
  paused: boolean;
  closedChunks?: number;
}

const eventPath: Record<RecordingEventType, string> = {
  start: "/api/recording/started",
  pause: "/api/pause",
  resume: "/api/resume",
  end: "/api/recording/ended",
};

export const submitRecordingEvent = ({
  eventType,
  ...payload
}: RecordingEventPayload) =>
  apiClient.post<RecordingEventResponse>(eventPath[eventType], payload);

export const fetchRecordingState = () =>
  apiClient.get<RecordingStateResponse>("/api/recording/state");
