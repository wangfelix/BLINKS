// Unit tests for the CHUNK-BASED initial day segmentation (segmentation.ts,
// reworked 2026-07-19). Pure function, no DB.
//
//   npx tsx scripts/test-segmentation.ts

import assert = require("assert");

import {
  GAP_SPLIT_MS,
  SegmentationChunk,
  segmentDay,
} from "../src/segmentation";

const WINDOW = 5 * 60 * 1000;
const BASE = 1_800_000_000_000; // any 5-min-aligned epoch

// Chunk in window `index`, with real frames from `firstOffset` after the
// window start to `lastOffset` (defaults: frames spanning most of the window).
const chunk = (
  index: number,
  label: string | null,
  category: string | null,
  firstOffset = 0,
  lastOffset = WINDOW - 30_000,
): SegmentationChunk => ({
  firstFrameMs: BASE + index * WINDOW + firstOffset,
  lastFrameMs: BASE + index * WINDOW + lastOffset,
  vlmLabel: label,
  vlmCategory: category,
});

const spans = (chunks: SegmentationChunk[]) =>
  segmentDay(chunks).map((activity) => [
    activity.startMs - BASE,
    activity.endMs - BASE,
    activity.rawLabel,
    activity.categoryLabel,
  ]);

let failures = 0;
const check = (name: string, actual: unknown, expected: unknown): void => {
  try {
    assert.deepStrictEqual(actual, expected);
    console.log(`ok   ${name}`);
  } catch {
    failures += 1;
    console.error(
      `FAIL ${name}\n  expected ${JSON.stringify(expected)}\n  actual   ${JSON.stringify(actual)}`,
    );
  }
};

check("empty day yields no activities", spans([]), []);

check(
  "consecutive same-label chunks group into one activity with real frame bounds",
  spans([
    chunk(0, "computer work", "work", 90_000), // session starts mid-window
    chunk(1, "computer work", "work"),
    chunk(2, "computer work", "work", 0, 60_000), // session ends early
  ]),
  [[90_000, 2 * WINDOW + 60_000, "computer work", "work"]],
);

check(
  "a label change between chunks starts a new activity",
  spans([
    chunk(0, "computer work", "work"),
    chunk(1, "eating a meal", "break"),
  ]),
  [
    [0, WINDOW - 30_000, "computer work", "work"],
    [WINDOW, 2 * WINDOW - 30_000, "eating a meal", "break"],
  ],
);

check(
  "same label but different category stays two activities",
  spans([chunk(0, "cooking", "work"), chunk(1, "cooking", "other")]),
  [
    [0, WINDOW - 30_000, "cooking", "work"],
    [WINDOW, 2 * WINDOW - 30_000, "cooking", "other"],
  ],
);

check(
  "noisy labels normalize into one group (display keeps the first form)",
  spans([
    chunk(0, "Coffee  break", "break"),
    chunk(1, " coffee break ", "break"),
  ]),
  [[0, 2 * WINDOW - 30_000, "Coffee break", "break"]],
);

check(
  "a missing window with a short real gap does not split",
  spans([
    chunk(0, "computer work", "work"), // frames end 4:30 into window 0
    chunk(2, "computer work", "work"), // next frames 5:30 later (<= 10 min)
  ]),
  [[0, 2 * WINDOW + WINDOW - 30_000, "computer work", "work"]],
);

check(
  "a capture gap over 10 minutes splits even with the same label",
  spans([
    chunk(0, "computer work", "work", 0, 60_000),
    chunk(3, "computer work", "work", 60_000), // 14 min between real frames
  ]),
  [
    [0, 60_000, "computer work", "work"],
    [3 * WINDOW + 60_000, 4 * WINDOW - 30_000, "computer work", "work"],
  ],
);

check(
  "an unlabeled chunk inside one activity merges away (bounds joined)",
  spans([
    chunk(0, "computer work", "work"),
    chunk(1, null, null), // VLM failed
    chunk(2, "computer work", "work"),
  ]),
  [[0, 3 * WINDOW - 30_000, "computer work", "work"]],
);

check(
  "an unlabeled chunk between different activities joins the previous one",
  spans([
    chunk(0, "computer work", "work"),
    chunk(1, null, null),
    chunk(2, "eating a meal", "break"),
  ]),
  [
    [0, 2 * WINDOW - 30_000, "computer work", "work"],
    [2 * WINDOW, 3 * WINDOW - 30_000, "eating a meal", "break"],
  ],
);

check(
  "a leading unlabeled chunk merges into the following labeled one",
  spans([chunk(0, null, null), chunk(1, "computer work", "work")]),
  [[0, 2 * WINDOW - 30_000, "computer work", "work"]],
);

check(
  "an entirely unlabeled block stays one null-label activity",
  spans([chunk(0, null, null), chunk(1, null, null)]),
  [[0, 2 * WINDOW - 30_000, null, null]],
);

check(
  "a gap of exactly GAP_SPLIT_MS does not split (strictly-greater rule)",
  spans([
    chunk(0, "a", "work", 0, 0),
    {
      ...chunk(0, "a", "work"),
      firstFrameMs: BASE + GAP_SPLIT_MS,
      lastFrameMs: BASE + GAP_SPLIT_MS,
    },
  ]),
  [[0, GAP_SPLIT_MS, "a", "work"]],
);

if (failures > 0) {
  console.error(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log(`\nSEGMENTATION TESTS PASSED (12 cases)`);
