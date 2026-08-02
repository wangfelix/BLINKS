// Unit test for resolveSpanOverlaps (the "Adjust times" neighbor rule).
// Run from drm-web/:  ../server/node_modules/.bin/tsx scripts/test-span-overlaps.ts

import {
  resolveSpanOverlaps,
  type EditableActivity,
} from "../src/components/reconstruct/editor-types";

const makeRow = (
  localId: string,
  startMs: number | null,
  endMs: number | null,
): EditableActivity => ({
  localId,
  startMs,
  endMs,
  rawLabel: "computer_or_monitor_use",
  categoryLabel: "work",
  source: "vlm",
  proposalActivityId: null,
  isIncorrectAnnotationInjected: false,
  workloadRating: null,
  recoveryRating: null,
});

const span = (row: EditableActivity) => `${row.startMs}-${row.endMs}`;

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

// Day layout: A 0-100, B 200-300, C 400-500, D 600-700, E 800-900.
const day = () => [
  makeRow("A", 0, 100),
  makeRow("B", 200, 300),
  makeRow("C", 400, 500),
  makeRow("D", 600, 700),
  makeRow("E", 800, 900),
];

// 1. Extend C far left and right: A keeps its head, B and D vanish
//    (fully covered), E keeps its tail.
check(
  "extend across several activities",
  resolveSpanOverlaps(day(), "C", 50, 850).map(span),
  ["0-49", "50-850", "851-900"],
);

// 2. Shrink C within itself: nothing else is touched.
check(
  "shrink without overlap",
  resolveSpanOverlaps(day(), "C", 410, 490).map(span),
  ["0-100", "200-300", "410-490", "600-700", "800-900"],
);

// 3. Exact adjacency: new span starts exactly at B's end -> B's end clamps
//    one ms before the new start (spans must stay disjoint).
check(
  "boundary touching the previous activity",
  resolveSpanOverlaps(day(), "C", 300, 500).map(span),
  ["0-100", "200-299", "300-500", "600-700", "800-900"],
);

// 4. A row that surrounds the whole new span keeps its head.
check(
  "surrounding row keeps its head",
  resolveSpanOverlaps(
    [makeRow("wide", 0, 1000), makeRow("target", 400, 500)],
    "target",
    300,
    600,
  ).map(span),
  ["0-299", "300-600"],
);

// 5. Rows without complete times are never touched.
check(
  "incomplete rows are kept as-is",
  resolveSpanOverlaps(
    [makeRow("draft", null, null), makeRow("target", 400, 500)],
    "target",
    0,
    1000,
  ).map(span),
  ["0-1000", "null-null"],
);

// 6. Unknown target id: the input is returned unchanged.
check(
  "unknown id is a no-op",
  resolveSpanOverlaps(day(), "nope", 0, 1000).map(span),
  ["0-100", "200-300", "400-500", "600-700", "800-900"],
);

// 7. Result stays sorted by start time even when the target moved.
check(
  "result re-sorted after the move",
  resolveSpanOverlaps(day(), "E", 150, 180).map((row) => row.localId),
  ["A", "E", "B", "C", "D"],
);

if (failures > 0) {
  console.error(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log("\nAll span-overlap checks passed.");
