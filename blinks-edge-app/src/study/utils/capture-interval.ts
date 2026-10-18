import type { CachedAppConfig } from "@/study/types/app-config";

/**
 * Capture interval for the participant's form factor, or null when the app
 * has never loaded the config or the form factor is unknown (then no 0x03 is
 * sent and the camera keeps its firmware default).
 */
export const desiredCaptureIntervalMs = (state: {
  config: CachedAppConfig | null;
  cameraFormFactor: string | null;
}): number | null => {
  if (!state.config || !state.cameraFormFactor) return null;
  const intervalMs =
    state.config.capture.intervalMsByFormFactor[state.cameraFormFactor];
  return typeof intervalMs === "number" && Number.isFinite(intervalMs)
    ? intervalMs
    : null;
};
