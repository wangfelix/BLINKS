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

// POST /api/recording/device-info (docs/study-config-documentation.md, 4.8).
export interface DeviceInfoReportRequest {
  eventId: string;
  session: number;
  device: string;
  clientEpochMs: number;
  requestedIntervalMs: number | null;
  settingsFormFactor: string | null;
  info: Record<string, unknown> | null;
}

// 201 stored, 200 duplicate or (stored: false) above the server's
// per-participant cap: all final, the queue drops the report.
export const submitDeviceInfoReport = (report: DeviceInfoReportRequest) =>
  apiClient.post<{ ok: true; duplicate: boolean; stored?: boolean }>(
    "/api/recording/device-info",
    report,
  );
