// Capture-time formatting for the admin photo browser. Times are shown in the
// configured study timezone (study.timezone), the zone the server derives
// study days with. Without a loaded config there is no guessed zone: the
// formatter returns a placeholder and the view shows why (loading or error).

export const CAPTURE_TIME_PLACEHOLDER = "…";

export interface CaptureTimeFormatter {
  format: (epochMs: number) => string;
}

export const captureTimeFormatter = (
  timeZone: string | undefined,
): CaptureTimeFormatter => {
  if (timeZone === undefined) {
    return { format: () => CAPTURE_TIME_PLACEHOLDER };
  }
  const formatter = new Intl.DateTimeFormat("en-GB", {
    dateStyle: "medium",
    timeStyle: "medium",
    timeZone,
  });
  return { format: (epochMs) => formatter.format(epochMs) };
};
