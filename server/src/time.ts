// ===========================================================================
// Local-time helpers for the DRM subproject.
//
// A "study day" is a local calendar date string YYYY-MM-DD in the study
// timezone (env DRM_TZ, default Europe/Berlin), derived from
// frames.capture_epoch_ms. Everything here goes through Intl.DateTimeFormat
// so DST is handled by the platform; no date libraries.
// ===========================================================================

const DRM_TZ = process.env.DRM_TZ ?? "Europe/Berlin";

// A waking day does not end at midnight. Every study day therefore extends
// past its calendar date by this much, so a participant reconstructing from
// memory can report the activities that ran into the small hours (going to
// bed at 00:30 is an ordinary end to a field day, not a second day). This is
// the diary-study convention of a 04:00 day boundary.
export const DAY_OVERRUN_MS =
  Number(process.env.DRM_DAY_OVERRUN_HOURS ?? 4) * 3_600_000;

// en-CA formats as YYYY-MM-DD, exactly the day-key shape the contract fixes.
const dayKeyFormatter = new Intl.DateTimeFormat("en-CA", {
  timeZone: DRM_TZ,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

// h23 keeps midnight at "00" (hour12:false alone can yield "24" on some ICUs).
const hourFormatter = new Intl.DateTimeFormat("en-GB", {
  timeZone: DRM_TZ,
  hour: "2-digit",
  hourCycle: "h23",
});

const hourMinuteFormatter = new Intl.DateTimeFormat("en-GB", {
  timeZone: DRM_TZ,
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});

// Local calendar date (YYYY-MM-DD) of an epoch-ms instant in the study TZ.
export function dayKeyFromEpochMs(epochMs: number): string {
  return dayKeyFormatter.format(new Date(epochMs));
}

// The local date a RECORDING SESSION belongs to, from its id (the epoch
// SECONDS of the participant's Start tap). The study day is anchored on the
// session rather than on each frame's capture time, so a session that runs
// past local midnight stays one single study day — the one the participant
// actually lived and will reconstruct.
export function sessionDayKey(session: number): string {
  return dayKeyFromEpochMs(session * 1000);
}

// Current hour of day (0-23) in the study TZ; drives the evening gate.
export function currentLocalHour(): number {
  return Number(hourFormatter.format(new Date()));
}

// Current minutes since local midnight (0-1439) in the study TZ; drives the
// per-participant bedtime push reminder.
export function currentLocalMinutes(): number {
  const [hour, minute] = hourMinuteFormatter.format(new Date()).split(":");
  return Number(hour) * 60 + Number(minute);
}

// "HH:MM" -> minutes since midnight, or undefined for anything malformed.
// Participant-entered (app onboarding), so parse defensively.
export function timeOfDayToMinutes(value: string | null | undefined): number | undefined {
  if (!value || !/^([01]\d|2[0-3]):[0-5]\d$/.test(value)) return undefined;
  const [hour, minute] = value.split(":").map(Number);
  return hour * 60 + minute;
}

// Today's day key in the study TZ.
export function todayKey(): string {
  return dayKeyFromEpochMs(Date.now());
}

// Wall-clock parts of an instant in the study TZ, used to invert a local
// date back into an epoch. Intl is the only DST-aware primitive available
// without a date library.
const wallClockPartsFormatter = new Intl.DateTimeFormat("en-US", {
  timeZone: DRM_TZ,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hourCycle: "h23",
});

const timezoneOffsetMsAt = (epochMs: number): number => {
  const parts = wallClockPartsFormatter.formatToParts(new Date(epochMs));
  const partValue = (type: Intl.DateTimeFormatPartTypes): number => {
    const part = parts.find((candidate) => candidate.type === type);
    return part ? Number(part.value) : 0;
  };
  const wallClockAsUtc = Date.UTC(
    partValue("year"),
    partValue("month") - 1,
    partValue("day"),
    partValue("hour"),
    partValue("minute"),
    partValue("second"),
  );
  return wallClockAsUtc - epochMs;
};

// Local midnight (epoch ms) that starts day key `day`. Two-pass conversion so
// DST transitions resolve to the correct instant. Mirrors drm-web's
// dayTimeToEpochMs; the two must agree.
export function localDayStartMs(day: string): number {
  const [year, month, dayOfMonth] = day.split("-").map(Number);
  const wallClockAsUtc = Date.UTC(year, month - 1, dayOfMonth);
  const firstGuess = wallClockAsUtc - timezoneOffsetMsAt(wallClockAsUtc);
  return wallClockAsUtc - timezoneOffsetMsAt(firstGuess);
}

// Next calendar date key, as a date step rather than +24 hours. Pure calendar
// arithmetic in UTC: the key is a date string, never an instant, so the study
// timezone must not enter here.
export function nextDayKey(day: string): string {
  const [year, month, dayOfMonth] = day.split("-").map(Number);
  const next = new Date(Date.UTC(year, month - 1, dayOfMonth + 1));
  return [
    next.getUTCFullYear(),
    String(next.getUTCMonth() + 1).padStart(2, "0"),
    String(next.getUTCDate()).padStart(2, "0"),
  ].join("-");
}
