// Focused checks for the window picker model with the default (paper) config,
// i.e. five-minute slots; other window sizes: test-alternative-configs.ts.
// Run from drm-web/:  npx tsx scripts/test-time-slots.ts

import type { Frame } from "../src/lib/api-types";
import { dayTimeToEpochMs, nextDayKey } from "../src/lib/time";
import type { EditableActivity } from "../src/components/reconstruct/editor-types";
import {
  buildWindowSlots,
  groupWindowSlots,
} from "../src/components/reconstruct/time-slots";
import { installDefaultStudyConfig } from "./fixtures/study-config";

installDefaultStudyConfig();

const DAY = "2026-08-06";
// The server sends the day's epoch extent; an ordinary day is its calendar day.
const DAY_BOUNDS = {
  startMs: dayTimeToEpochMs(DAY, "00:00"),
  endMs: dayTimeToEpochMs(nextDayKey(DAY), "00:00"),
};

const activity = (
  localId: string,
  start: string,
  end: string,
): EditableActivity => ({
  localId,
  startMs: dayTimeToEpochMs(DAY, start),
  endMs: dayTimeToEpochMs(DAY, end),
  rawLabel: "computer_or_monitor_use",
  categoryLabel: "work",
  source: "vlm",
  proposalActivityId: 1,
  isIncorrectAnnotationInjected: false,
  ratings: { mental_demand: 4, mental_recovery: null },
});

const frame = (
  time: string,
  frameIndex: number,
  deletedAt: number | null = null,
): Frame => ({
  device: "camera",
  session: 1,
  frameIndex,
  captureEpochMs: dayTimeToEpochMs(DAY, time),
  imageUrl: deletedAt === null ? `/frames/${frameIndex}.jpg` : null,
  deletedAt,
});

let failures = 0;
const check = (name: string, actual: unknown, expected: unknown) => {
  const actualJson = JSON.stringify(actual);
  const expectedJson = JSON.stringify(expected);
  if (actualJson === expectedJson) {
    console.log(`ok   ${name}`);
  } else {
    failures += 1;
    console.error(
      `FAIL ${name}\n  expected ${expectedJson}\n  actual   ${actualJson}`,
    );
  }
};

const rows = [activity("work", "09:00", "09:15")];
const slots = buildWindowSlots(
  DAY_BOUNDS,
  [
    frame("09:01", 1),
    frame("09:02", 2),
    frame("09:06", 3, 1234),
    frame("09:15", 4),
  ],
  rows,
);
const slotAt = (time: string) => {
  const startMs = dayTimeToEpochMs(DAY, time);
  const slot = slots.find((candidate) => candidate.startMs === startMs);
  if (slot === undefined) throw new Error(`missing slot ${time}`);
  return slot;
};

check("ordinary summer day has 288 five-minute slots", slots.length, 288);
check(
  "multiple images stay grouped in one five-minute slot",
  slotAt("09:00").frames.map((candidate) => candidate.frameIndex),
  [1, 2],
);
check(
  "assigned image-free chunks remain visible and keep their owner",
  ["09:05", "09:10"].map((time) => ({
    frames: slotAt(time).frames.length,
    owner: slotAt(time).owner?.localId ?? null,
  })),
  [
    { frames: 0, owner: "work" },
    { frames: 0, owner: "work" },
  ],
);
check(
  "an image exactly at the half-open end belongs to the next slot",
  {
    activityOwner: slotAt("09:15").owner?.localId ?? null,
    frameIndexes: slotAt("09:15").frames.map(
      (candidate) => candidate.frameIndex,
    ),
  },
  { activityOwner: null, frameIndexes: [4] },
);

const displaySlots = ["09:00", "09:05", "09:10", "09:15", "09:20"].map(slotAt);
check(
  "add mode never mistakes ownerless slots for a current activity",
  groupWindowSlots(displaySlots, undefined).map((group) => [
    group.kind,
    group.slots.length,
  ]),
  [
    ["assigned", 3],
    ["unassigned", 1],
    ["empty", 1],
  ],
);
check(
  "one activity receives one shared visual group",
  groupWindowSlots(displaySlots.slice(0, 3), "work").map((group) => [
    group.kind,
    group.owner?.localId,
    group.slots.length,
  ]),
  [["current", "work", 3]],
);
check(
  "selection-independent groups keep every slot in a stable container",
  groupWindowSlots(displaySlots, undefined).map((group) => [
    group.kind,
    group.slots.length,
  ]),
  [
    ["assigned", 3],
    ["unassigned", 1],
    ["empty", 1],
  ],
);

// A recording that ran past local midnight makes the study day longer than
// its calendar date: the grid must extend to cover the overrun instead of
// clipping the frames captured after midnight.
const overnightBounds = {
  startMs: dayTimeToEpochMs(DAY, "00:00"),
  endMs: dayTimeToEpochMs(nextDayKey(DAY), "00:55"),
};
const overnightFrame: Frame = {
  device: "camera",
  session: 1,
  frameIndex: 99,
  captureEpochMs: dayTimeToEpochMs(nextDayKey(DAY), "00:51"),
  imageUrl: "/frames/99.jpg",
  deletedAt: null,
};
const overnightSlots = buildWindowSlots(overnightBounds, [overnightFrame], []);
check(
  "a past-midnight recording extends the grid instead of clipping",
  overnightSlots.length,
  288 + 11,
);
check(
  "a frame captured after midnight lands in its own slot",
  overnightSlots
    .filter((slot) => slot.frames.length > 0)
    .map((slot) => slot.frames.map((candidate) => candidate.frameIndex)),
  [[99]],
);

if (failures > 0) {
  console.error(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log("\nAll five-minute slot checks passed.");
