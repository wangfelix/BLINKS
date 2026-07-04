import assert = require("assert");

import {
  SegmentationFrame,
  SegmentedActivity,
  segmentDay,
} from "../src/segmentation";

// Table-driven tests for the pure initial-segmentation generator.
// Run via: npx tsx scripts/test-segmentation.ts

const BASE_MS = 1_700_000_000_000;

// Frame at `seconds` after the base instant.
const frame = (
  seconds: number,
  vlmLabel: string | null,
  vlmCategory: string | null,
): SegmentationFrame => ({
  captureEpochMs: BASE_MS + seconds * 1000,
  vlmLabel,
  vlmCategory,
});

// Expected activity spanning [startSeconds, endSeconds] after the base.
const activity = (
  startSeconds: number,
  endSeconds: number,
  rawLabel: string | null,
  categoryLabel: string | null,
): SegmentedActivity => ({
  startMs: BASE_MS + startSeconds * 1000,
  endMs: BASE_MS + endSeconds * 1000,
  rawLabel,
  categoryLabel,
});

interface TestCase {
  name: string;
  frames: SegmentationFrame[];
  expected: SegmentedActivity[];
}

const cases: TestCase[] = [
  {
    name: "no frames -> no activities",
    frames: [],
    expected: [],
  },
  {
    name: "single frame -> single zero-length activity",
    frames: [frame(0, "Writing report", "work")],
    expected: [activity(0, 0, "Writing report", "work")],
  },
  {
    name: "noisy labels normalize into one group (case + whitespace)",
    frames: [
      frame(0, "Desk  Work", "work"),
      frame(60, "desk work", "work"),
      frame(120, " DESK   WORK ", "work"),
      frame(180, "desk work", "work"),
    ],
    expected: [activity(0, 180, "Desk Work", "work")],
  },
  {
    name: "short middle segment merges into previous; longer constituent labels",
    frames: [
      frame(0, "writing", "work"),
      frame(60, "writing", "work"),
      frame(120, "writing", "work"),
      frame(180, "writing", "work"),
      frame(210, "coffee", "break"),
      frame(240, "coffee", "break"),
      frame(300, "reading", "work"),
      frame(360, "reading", "work"),
      frame(420, "reading", "work"),
      frame(480, "reading", "work"),
    ],
    expected: [
      activity(0, 240, "writing", "work"),
      activity(300, 480, "reading", "work"),
    ],
  },
  {
    name: "short first segment merges into next (no previous neighbor)",
    frames: [
      frame(0, "standup", "work"),
      frame(60, "coding", "work"),
      frame(120, "coding", "work"),
      frame(240, "coding", "work"),
      frame(360, "coding", "work"),
    ],
    expected: [activity(0, 360, "coding", "work")],
  },
  {
    name: "capture gap > 10 min splits; short lone segment survives in its block",
    frames: [
      frame(0, "writing", "work"),
      frame(60, "writing", "work"),
      frame(120, "writing", "work"),
      // 20 min gap: camera off / paused
      frame(1320, "cooking", "other"),
      frame(1380, "cooking", "other"),
    ],
    expected: [
      activity(0, 120, "writing", "work"),
      activity(1320, 1380, "cooking", "other"),
    ],
  },
  {
    name: "unlabeled run is absorbed by its labeled neighbor",
    frames: [
      frame(0, "writing", "work"),
      frame(60, "writing", "work"),
      frame(180, "writing", "work"),
      frame(240, null, null),
      frame(300, null, null),
      frame(360, "writing", "work"),
      frame(420, "writing", "work"),
      frame(540, "writing", "work"),
    ],
    expected: [
      activity(0, 300, "writing", "work"),
      activity(360, 540, "writing", "work"),
    ],
  },
  {
    name: "fully unlabeled block collapses to one unknown activity",
    frames: [
      frame(0, null, null),
      frame(120, null, null),
      frame(240, null, null),
      frame(360, null, null),
      frame(600, null, null),
    ],
    expected: [activity(0, 600, null, null)],
  },
  {
    name: "equal-length merge tie prefers the previous constituent",
    frames: [
      frame(0, "alpha", "work"),
      frame(60, "alpha", "work"),
      frame(120, "beta", "work"),
      frame(180, "beta", "work"),
    ],
    expected: [activity(0, 180, "alpha", "work")],
  },
  {
    name: "same label but different category stays two groups",
    frames: [
      frame(0, "eating", "break"),
      frame(60, "eating", "break"),
      frame(120, "eating", "break"),
      frame(180, "eating", "other"),
      frame(240, "eating", "other"),
      frame(300, "eating", "other"),
    ],
    expected: [
      activity(0, 120, "eating", "break"),
      activity(180, 300, "eating", "other"),
    ],
  },
];

let failures = 0;
for (const testCase of cases) {
  try {
    assert.deepStrictEqual(segmentDay(testCase.frames), testCase.expected);
    console.log(`ok   ${testCase.name}`);
  } catch (error) {
    failures += 1;
    console.error(`FAIL ${testCase.name}`);
    console.error(error instanceof Error ? error.message : error);
  }
}

if (failures > 0) {
  console.error(`${failures} of ${cases.length} segmentation tests failed`);
  process.exit(1);
}
console.log(`SEGMENTATION TESTS PASSED (${cases.length} cases)`);
