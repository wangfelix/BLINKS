// Time helpers for the study timezone.
//
// A "study day" is a local calendar date (YYYY-MM-DD) in the study timezone
// (Europe/Berlin unless overridden). The server derives day keys with the same
// rule (DRM_TZ env); keep NEXT_PUBLIC_DRM_TZ in sync with the server's DRM_TZ.

export const STUDY_TIMEZONE = process.env.NEXT_PUBLIC_DRM_TZ ?? "Europe/Berlin";

const timeOfDayFormatter = new Intl.DateTimeFormat("en-GB", {
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
  timeZone: STUDY_TIMEZONE,
});

const dayLabelFormatter = new Intl.DateTimeFormat("en-GB", {
  weekday: "short",
  day: "numeric",
  month: "short",
  timeZone: STUDY_TIMEZONE,
});

/** Epoch ms -> "HH:MM" wall-clock time in the study timezone. */
export const formatTimeOfDay = (epochMs: number): string =>
  timeOfDayFormatter.format(new Date(epochMs));

/** "HH:MM–HH:MM" span label in the study timezone. */
export const formatTimeSpan = (startMs: number, endMs: number): string =>
  `${formatTimeOfDay(startMs)}–${formatTimeOfDay(endMs)}`;

/** Day key "YYYY-MM-DD" -> human label like "Mon, 29 Jun". */
export const formatDayLabel = (dayKey: string): string => {
  const [year, month, dayOfMonth] = dayKey.split("-").map(Number);
  // Noon UTC is the same calendar date in any European timezone.
  const noonUtc = new Date(Date.UTC(year, month - 1, dayOfMonth, 12));
  return dayLabelFormatter.format(noonUtc);
};

/** Format an availability gate hour, e.g. 19 -> "19:00". */
export const formatHour = (hour: number): string =>
  `${String(hour).padStart(2, "0")}:00`;

const wallClockPartsFormatter = new Intl.DateTimeFormat("en-US", {
  timeZone: STUDY_TIMEZONE,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hour12: false,
});

/** Offset (ms) of the study timezone from UTC at a given instant. */
const timezoneOffsetMsAt = (epochMs: number): number => {
  const parts = wallClockPartsFormatter.formatToParts(new Date(epochMs));
  const partValue = (type: Intl.DateTimeFormatPartTypes): number => {
    const part = parts.find((candidate) => candidate.type === type);
    return part ? Number(part.value) : 0;
  };
  let hour = partValue("hour");
  if (hour === 24) hour = 0; // some ICU versions render midnight as 24
  const wallClockAsUtc = Date.UTC(
    partValue("year"),
    partValue("month") - 1,
    partValue("day"),
    hour,
    partValue("minute"),
    partValue("second"),
  );
  return wallClockAsUtc - epochMs;
};

/**
 * Day key "YYYY-MM-DD" + wall-clock "HH:MM" in the study timezone -> epoch ms.
 * Two-pass conversion so DST transitions resolve correctly.
 */
export const dayTimeToEpochMs = (dayKey: string, timeOfDay: string): number => {
  const [year, month, dayOfMonth] = dayKey.split("-").map(Number);
  const [hour, minute] = timeOfDay.split(":").map(Number);
  const wallClockAsUtc = Date.UTC(year, month - 1, dayOfMonth, hour, minute);
  const firstGuess = wallClockAsUtc - timezoneOffsetMsAt(wallClockAsUtc);
  return wallClockAsUtc - timezoneOffsetMsAt(firstGuess);
};
