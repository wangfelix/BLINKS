// Unit tests for the chunk-based initial day segmentation.
//
//   npx tsx scripts/test-segmentation.ts

import assert = require("assert");

import { SegmentationChunk, segmentDay } from "../src/segmentation";

const WINDOW = 5 * 60 * 1000;
const BASE = 1_800_000_000_000; // any 5-min-aligned epoch

const chunk = (
  index: number,
  label: string | null,
  category: string | null,
): SegmentationChunk => ({
  chunkStartMs: BASE + index * WINDOW,
  chunkEndMs: BASE + (index + 1) * WINDOW,
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
  "same activity and category merge on full chunk boundaries",
  spans([
    chunk(0, "computer_or_monitor_use", "work"),
    chunk(1, "computer_or_monitor_use", "work"),
    chunk(2, "computer_or_monitor_use", "work"),
  ]),
  [[0, 3 * WINDOW, "computer_or_monitor_use", "work"]],
);

check(
  "an activity change starts a new activity",
  spans([
    chunk(0, "computer_or_monitor_use", "work"),
    chunk(1, "eating_drinking", "break"),
  ]),
  [
    [0, WINDOW, "computer_or_monitor_use", "work"],
    [WINDOW, 2 * WINDOW, "eating_drinking", "break"],
  ],
);

check(
  "same activity with a different category stays separate",
  spans([
    chunk(0, "computer_or_monitor_use", "work"),
    chunk(1, "computer_or_monitor_use", "break"),
  ]),
  [
    [0, WINDOW, "computer_or_monitor_use", "work"],
    [WINDOW, 2 * WINDOW, "computer_or_monitor_use", "break"],
  ],
);

check(
  "defensive case and whitespace normalization still groups",
  spans([
    chunk(0, "Computer_Or_Monitor_Use", "work"),
    chunk(1, " computer_or_monitor_use ", "work"),
  ]),
  [[0, 2 * WINDOW, "Computer_Or_Monitor_Use", "work"]],
);

check(
  "a capture gap does not split matching classifications",
  spans([
    chunk(0, "computer_or_monitor_use", "work"),
    chunk(4, "computer_or_monitor_use", "work"),
  ]),
  [[0, 5 * WINDOW, "computer_or_monitor_use", "work"]],
);

check(
  "a failed chunk stays blank and prevents surrounding chunks from merging",
  spans([
    chunk(0, "computer_or_monitor_use", "work"),
    chunk(1, null, null),
    chunk(2, "computer_or_monitor_use", "work"),
  ]),
  [
    [0, WINDOW, "computer_or_monitor_use", "work"],
    [WINDOW, 2 * WINDOW, null, null],
    [2 * WINDOW, 3 * WINDOW, "computer_or_monitor_use", "work"],
  ],
);

check(
  "each consecutive failed chunk remains its own blank activity",
  spans([chunk(0, null, null), chunk(1, null, null)]),
  [
    [0, WINDOW, null, null],
    [WINDOW, 2 * WINDOW, null, null],
  ],
);

check(
  "a partial result is treated as an unlabelled failed activity",
  spans([chunk(0, "computer_or_monitor_use", null)]),
  [[0, WINDOW, null, null]],
);

if (failures > 0) {
  console.error(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log(`\nSEGMENTATION TESTS PASSED (9 cases)`);
