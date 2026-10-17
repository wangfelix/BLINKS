// Window alignment (review of PR #1, M3, decided: variant A). Windows are
// epoch-aligned (chunkStartOf), so the loader only accepts windowMinutes W
// that divide 60 and every UTC offset of the study time zone. Then every
// window starts on a local W-minute mark and none crosses local midnight,
// including the DST days.
//
//   npx tsx scripts/test-window-alignment.ts
// The DST part uses the active config's window (example: 5 min -> 276/300).

import assert = require("assert");
import fs = require("fs");
import path = require("path");

import { CHUNK_WINDOW_MS, chunkStartOf } from "../src/db";
import { parseStudyConfig, StudyConfigError } from "../src/study-config/load";
import { allowedWindowMinutes, timeZoneOffsetsMinutes } from "../src/study-config/schema";

const EXAMPLE = path.resolve(__dirname, "..", "..", "config", "study.example.yaml");
const exampleSource = fs.readFileSync(EXAMPLE, "utf8");

let passed = 0;
const test = (name: string, fn: () => void): void => {
  fn();
  passed++;
  console.log(`ok - ${name}`);
};

const withWindow = (windowMinutes: number, timeZone = "Europe/Berlin"): string =>
  exampleSource
    .replace(/^  timezone: .*$/m, `  timezone: "${timeZone}"`)
    .replace(/^  windowMinutes: .*$/m, `  windowMinutes: ${windowMinutes}`)
    .replace(/^  idleCloseMinutes: .*$/m, `  idleCloseMinutes: ${Math.max(10, windowMinutes)}`);

const windowIssue = (source: string): string | null => {
  try {
    parseStudyConfig(source, "inline.yaml");
    return null;
  } catch (error) {
    assert.ok(error instanceof StudyConfigError, String(error));
    const issue = error.issues.find((i) => i.path === "windowing.windowMinutes");
    return issue ? issue.message : null;
  }
};

const BERLIN_ALLOWED = "1, 2, 3, 4, 5, 6, 10, 12, 15, 20, 30, 60";

test("allowed values per time zone", () => {
  assert.deepStrictEqual(allowedWindowMinutes("Europe/Berlin").join(", "), BERLIN_ALLOWED);
  assert.deepStrictEqual(allowedWindowMinutes("UTC").join(", "), BERLIN_ALLOWED);
  assert.deepStrictEqual(allowedWindowMinutes("Asia/Kolkata"), [1, 2, 3, 5, 6, 10, 15, 30]);
  assert.deepStrictEqual(timeZoneOffsetsMinutes("Europe/Berlin"), [60, 120]);
  assert.deepStrictEqual(timeZoneOffsetsMinutes("Asia/Kolkata"), [330]);
});

test("Europe/Berlin: 7, 45, 90, 120 refused with the allowed list; 5, 30, 60 accepted", () => {
  for (const w of [7, 45, 90, 120]) {
    const message = windowIssue(withWindow(w));
    assert.ok(message, `${w} must be refused`);
    assert.match(message!, /must divide 60 and every UTC offset of Europe\/Berlin/);
    assert.ok(message!.endsWith(`allowed: ${BERLIN_ALLOWED}`), message!);
  }
  for (const w of [5, 30, 60]) assert.strictEqual(windowIssue(withWindow(w)), null, `${w} must be accepted`);
});

test("Asia/Kolkata (+05:30): 60 refused, 30 accepted", () => {
  const message = windowIssue(withWindow(60, "Asia/Kolkata"));
  assert.ok(message);
  assert.ok(message!.endsWith("allowed: 1, 2, 3, 5, 6, 10, 15, 30"), message!);
  assert.strictEqual(windowIssue(withWindow(30, "Asia/Kolkata")), null);
});

// --- chunkStartOf on the Berlin DST days (example config: 5 min) --------------

const berlin = new Intl.DateTimeFormat("en-CA", {
  timeZone: "Europe/Berlin",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});
const local = (epochMs: number) => {
  const parts = Object.fromEntries(berlin.formatToParts(new Date(epochMs)).map((p) => [p.type, p.value]));
  return { date: `${parts.year}-${parts.month}-${parts.day}`, minute: Number(parts.minute) };
};

const windowsOfLocalDay = (date: string, startUtc: string, endUtc: string): number[] => {
  const start = Date.parse(startUtc);
  const end = Date.parse(endUtc);
  assert.strictEqual(local(start).date, date);
  assert.notStrictEqual(local(start - 1).date, date, "start is local midnight");
  assert.notStrictEqual(local(end).date, date, "end is the next local midnight");
  const starts = new Set<number>();
  for (let t = start; t < end; t += 60_000) starts.add(chunkStartOf(t));
  return [...starts].sort((a, b) => a - b);
};

for (const [date, startUtc, endUtc, hours] of [
  ["2026-03-29", "2026-03-28T23:00:00Z", "2026-03-29T22:00:00Z", 23], // spring forward
  ["2026-10-25", "2026-10-24T22:00:00Z", "2026-10-25T23:00:00Z", 25], // fall back
  ["2026-07-14", "2026-07-13T22:00:00Z", "2026-07-14T22:00:00Z", 24], // normal day
] as const) {
  const W = CHUNK_WINDOW_MS / 60_000;
  const expected = (hours * 60) / W; // 5 min: 276 / 300 / 288
  test(`chunkStartOf on ${date} (${hours} h): ${expected} windows on local ${W}-minute marks, none across midnight`, () => {
    if (W === 5) assert.strictEqual(expected, { 23: 276, 25: 300, 24: 288 }[hours]);
    const starts = windowsOfLocalDay(date, startUtc, endUtc);
    assert.strictEqual(starts.length, expected);
    assert.strictEqual(starts[0], Date.parse(startUtc), "first window starts at local midnight");
    for (const s of starts) {
      assert.strictEqual(local(s).minute % W, 0, `window ${new Date(s).toISOString()} on a local mark`);
      assert.strictEqual(local(s).date, date);
      assert.strictEqual(local(s + CHUNK_WINDOW_MS - 1).date, date, "window ends on the same local day");
    }
  });
}

console.log(`\n${passed} window alignment tests passed`);
