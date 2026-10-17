import type { CachedAppConfig } from "@/study/types/app-config";

interface WallClockParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

const formatterCache = new Map<string, Intl.DateTimeFormat>();

const wallClockFormatter = (timeZone: string): Intl.DateTimeFormat => {
  let formatter = formatterCache.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
    formatterCache.set(timeZone, formatter);
  }
  return formatter;
};

const wallClockParts = (ms: number, timeZone: string): WallClockParts => {
  const parts: Record<string, number> = {};
  for (const part of wallClockFormatter(timeZone).formatToParts(ms)) {
    if (part.type !== "literal") parts[part.type] = Number(part.value);
  }
  return {
    year: parts.year,
    month: parts.month,
    day: parts.day,
    hour: parts.hour === 24 ? 0 : parts.hour,
    minute: parts.minute,
    second: parts.second,
  };
};

const zoneOffsetMs = (ms: number, timeZone: string): number => {
  const parts = wallClockParts(ms, timeZone);
  const asUtc = Date.UTC(
    parts.year,
    parts.month - 1,
    parts.day,
    parts.hour,
    parts.minute,
    parts.second,
  );
  return asUtc - Math.floor(ms / 1_000) * 1_000;
};

/**
 * Epoch ms of `hour:minute` on the calendar day of `referenceMs`, both read
 * in `timeZone` (two-pass offset lookup, correct across DST switches).
 */
export const wallClockTimeOnDayMs = (
  referenceMs: number,
  hour: number,
  minute: number,
  timeZone: string,
): number => {
  const day = wallClockParts(referenceMs, timeZone);
  const naiveUtc = Date.UTC(day.year, day.month - 1, day.day, hour, minute);
  const firstGuess = naiveUtc - zoneOffsetMs(naiveUtc, timeZone);
  return naiveUtc - zoneOffsetMs(firstGuess, timeZone);
};

const parseTimeOfDay = (
  value: string,
): { hour: number; minute: number } | null => {
  const match = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(value);
  return match ? { hour: Number(match[1]), minute: Number(match[2]) } : null;
};

/**
 * Ending the main session becomes available at schedule.endSessionAvailableAt
 * on the study-timezone calendar day on which the session started. Comparing
 * timestamps, instead of only the current hour, keeps the action available
 * after midnight and during morning-after recovery. Without a loaded config
 * the action is available: the app must never trap a participant in a
 * recording because it could not reach the server.
 */
export const isStudySessionEndAvailable = (
  nowMs: number,
  sessionIdSeconds: number | null,
  config: CachedAppConfig | null,
): boolean => {
  if (sessionIdSeconds === null) return false;
  const time = config
    ? parseTimeOfDay(config.schedule.endSessionAvailableAt)
    : null;
  if (!config || !time) return true;
  const cutoffMs = wallClockTimeOnDayMs(
    sessionIdSeconds * 1_000,
    time.hour,
    time.minute,
    config.timezone,
  );
  return nowMs >= cutoffMs;
};

/** "Available from 19:00" from the configured template. */
export const endSessionAvailableFromLabel = (config: CachedAppConfig): string =>
  config.texts.app.endSessionAvailableFrom.replace(
    "{{time}}",
    config.schedule.endSessionAvailableAt,
  );
