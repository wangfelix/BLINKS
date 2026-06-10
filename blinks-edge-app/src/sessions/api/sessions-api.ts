import { apiClient } from "@/application/api/api-client";
import { SessionFrame, SessionSummary } from "@/sessions/types/session-types";

export const fetchSessions = () =>
  apiClient.get<{ sessions: SessionSummary[] }>("/api/sessions");

export const fetchSessionFrames = (device: string, session: number) =>
  apiClient.get<{ frames: SessionFrame[] }>(
    `/api/sessions/${device}/${session}/frames`,
  );

export const deleteSessionFrame = (
  device: string,
  session: number,
  frameIndex: number,
) =>
  apiClient.delete<{ ok: true }>(
    `/api/sessions/${device}/${session}/frames/${frameIndex}`,
  );
