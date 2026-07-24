import { apiClient } from "@/application/api/api-client";

// Server-side pause state for the participant (the ingestion gate drops any
// frame that arrives while paused, mirroring the WiFi pipeline's defense in
// depth). The BLE control write to the camera is the primary pause mechanism.
export const pauseCaptureOnServer = () =>
  apiClient.post<{ ok: true }>("/api/pause");

export const resumeCaptureOnServer = () =>
  apiClient.post<{ ok: true }>("/api/resume");

// End-of-session signal (Stop, not Pause): tells the server no more frames
// are coming, so the last 5-minute chunk closes for VLM inference immediately
// instead of waiting for the server's idle sweep (which remains the fallback
// when this call cannot get through).
export const notifyRecordingEnded = () =>
  apiClient.post<{ ok: true; closedChunks: number }>("/api/recording/ended");
