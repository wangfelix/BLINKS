// Focused checks for the five-minute picker model.
// Run from drm-web/:  ../server/node_modules/.bin/tsx scripts/test-time-slots.ts

import type { Frame } from "../src/lib/api-types";
import { dayTimeToEpochMs } from "../src/lib/time";
import type { EditableActivity } from "../src/components/reconstruct/editor-types";
import {
  buildFiveMinuteSlots,
  groupFiveMinuteSlots,
} from "../src/components/reconstruct/time-slots";

const DAY = "2026-08-06";

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
  workloadRating: 4,
  recoveryRating: null,
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
const slots = buildFiveMinuteSlots(
  DAY,
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
  groupFiveMinuteSlots(displaySlots, undefined).map((group) => [
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
  groupFiveMinuteSlots(displaySlots.slice(0, 3), "work").map((group) => [
    group.kind,
    group.owner?.localId,
    group.slots.length,
  ]),
  [["current", "work", 3]],
);
check(
  "selection-independent groups keep every slot in a stable container",
  groupFiveMinuteSlots(displaySlots, undefined).map((group) => [
    group.kind,
    group.slots.length,
  ]),
  [
    ["assigned", 3],
    ["unassigned", 1],
    ["empty", 1],
  ],
);

if (failures > 0) {
  console.error(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log("\nAll five-minute slot checks passed.");
