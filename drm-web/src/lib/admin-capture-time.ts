// Capture-time formatting for the admin photo browser. Times are shown in the
// configured study timezone (study.timezone), the zone the server derives
// study days with. Without a loaded config the formatter returns a placeholder
// and the view shows the loading or error state.

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
