// Time helpers for the study timezone.
//
// A "study day" is a local calendar date (YYYY-MM-DD) in the study timezone.
// Timezone and display locale come from the study config (`study.timezone`,
// `ui.locale`), the same values the server derives day keys with.

import { getStudyConfig } from "@/lib/study-config-store";

const formatterCache = new Map<string, Intl.DateTimeFormat>();

/** Memoized formatter for the current study timezone (+ locale). */
const studyFormatter = (
  name: string,
  locale: string | null,
  options: Intl.DateTimeFormatOptions,
): Intl.DateTimeFormat => {
  const config = getStudyConfig();
  const resolvedLocale = locale ?? config.ui.locale;
  const key = `${name}|${resolvedLocale}|${config.study.timezone}`;
  let formatter = formatterCache.get(key);
  if (formatter === undefined) {
    formatter = new Intl.DateTimeFormat(resolvedLocale, {
      ...options,
      timeZone: config.study.timezone,
    });
    formatterCache.set(key, formatter);
  }
  return formatter;
};

const timeOfDayFormatter = () =>
  studyFormatter("time-of-day", null, {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });

const dayLabelFormatter = () =>
  studyFormatter("day-label", null, {
    weekday: "short",
    day: "numeric",
    month: "short",
  });

/** Epoch ms -> "HH:MM" wall-clock time in the study timezone. */
export const formatTimeOfDay = (epochMs: number): string =>
  timeOfDayFormatter().format(new Date(epochMs));

/** "HH:MM–HH:MM" span label in the study timezone. */
export const formatTimeSpan = (startMs: number, endMs: number): string =>
  `${formatTimeOfDay(startMs)}–${formatTimeOfDay(endMs)}`;

/** Day key "YYYY-MM-DD" -> human label like "Mon, 29 Jun". */
export const formatDayLabel = (dayKey: string): string => {
  const [year, month, dayOfMonth] = dayKey.split("-").map(Number);
  // Noon UTC is the same calendar date in any European timezone.
  const noonUtc = new Date(Date.UTC(year, month - 1, dayOfMonth, 12));
  return dayLabelFormatter().format(noonUtc);
};

// Locale-independent parts parser (fixed "en-US"), only the zone varies.
const wallClockPartsFormatter = () =>
  studyFormatter("wall-clock-parts", "en-US", {
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
  const parts = wallClockPartsFormatter().formatToParts(new Date(epochMs));
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

/** Next YYYY-MM-DD key, calculated as a calendar date rather than +24 hours. */
export const nextDayKey = (dayKey: string): string => {
  const [year, month, dayOfMonth] = dayKey.split("-").map(Number);
  const next = new Date(Date.UTC(year, month - 1, dayOfMonth + 1, 12));
  return [
    next.getUTCFullYear(),
    String(next.getUTCMonth() + 1).padStart(2, "0"),
    String(next.getUTCDate()).padStart(2, "0"),
  ].join("-");
};

// The epoch extent of a study day is NOT derived here. The day is anchored on
// the recording session, so a recording that ran past local midnight makes the
// day longer than its calendar date; the server sends dayStartMs/dayEndMs.

/**
 * A wall-clock "HH:MM" typed into a chronological reconstruction -> epoch ms.
 *
 * The participant types times without a date, but a study day runs past local
 * midnight: going to bed at 00:30 ends the field day rather than starting a
 * new one. The reconstruction is entered in chronological order, so a time
 * that would land BEFORE the preceding entry belongs to the next calendar
 * date. The roll is taken only when the result still fits inside the day,
 * which confines it to the small hours: an out-of-order entry from the middle
 * of the day keeps its own date and surfaces as an ordinary overlap warning
 * instead of silently jumping a day.
 */
export const resolveTypedTimeOfDay = (
  dayKey: string,
  timeOfDay: string,
  anchorMs: number | null,
  dayEndMs: number,
): number => {
  const sameDay = dayTimeToEpochMs(dayKey, timeOfDay);
  if (anchorMs === null || sameDay >= anchorMs) return sameDay;
  const rolled = dayTimeToEpochMs(nextDayKey(dayKey), timeOfDay);
  return rolled <= dayEndMs ? rolled : sameDay;
};
