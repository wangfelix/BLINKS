// ===========================================================================
// Local-time helpers for the DRM subproject.
//
// A "study day" is a local calendar date string YYYY-MM-DD in the study
// timezone (env DRM_TZ, default Europe/Berlin), derived from
// frames.capture_epoch_ms. Everything here goes through Intl.DateTimeFormat
// so DST is handled by the platform; no date libraries.
// ===========================================================================

const DRM_TZ = process.env.DRM_TZ ?? "Europe/Berlin";

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

// Conservative UTC epoch-ms range guaranteed to contain every instant whose
// local day is `day` (UTC offsets span -12..+14, so pad by 14h on both sides).
// Callers narrow SQL scans with this range, then filter exactly with
// dayKeyFromEpochMs.
export function dayUtcRange(day: string): { fromMs: number; toMs: number } {
  const utcMidnight = Date.parse(`${day}T00:00:00Z`);
  const padMs = 14 * 3_600_000;
  return { fromMs: utcMidnight - padMs, toMs: utcMidnight + 24 * 3_600_000 + padMs };
}
