import { apiClient } from "@/application/api/api-client";

// Server-side pause state for the participant (the ingestion gate drops any
// frame that arrives while paused, mirroring the WiFi pipeline's defense in
// depth). The BLE control write to the camera is the primary pause mechanism.
export const pauseCaptureOnServer = () =>
  apiClient.post<{ ok: true }>("/api/pause");

export const resumeCaptureOnServer = () =>
  apiClient.post<{ ok: true }>("/api/resume");
