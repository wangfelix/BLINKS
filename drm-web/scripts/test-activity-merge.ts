// Focused checks for merging two adjacent assisted activities. The per-window
// segmentation splits a continuous stretch whenever the VLM's argmax wobbles,
// so rejoining rows is the most common assisted-round correction.
// Run from drm-web/:  npx tsx scripts/test-activity-merge.ts

import {
  activitiesInviteMerge,
  mergeWithNextActivity,
  type EditableActivity,
} from "../src/components/reconstruct/editor-types";
import { installDefaultStudyConfig } from "./fixtures/study-config";

installDefaultStudyConfig();

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

const MINUTE = 60_000;
const base = 1_786_000_000_000;

const row = (
  localId: string,
  startMinutes: number,
  endMinutes: number,
  overrides: Partial<EditableActivity> = {},
): EditableActivity => ({
  localId,
  startMs: base + startMinutes * MINUTE,
  endMs: base + endMinutes * MINUTE,
  rawLabel: "computer_or_monitor_use",
  categoryLabel: "work",
  source: "vlm",
  proposalActivityId: Number(localId.replace(/\D/g, "")) || 1,
  isIncorrectAnnotationInjected: false,
  ratings: { mental_demand: 4, mental_recovery: null },
  ...overrides,
});

const spans = (rows: EditableActivity[]) =>
  rows.map((r) => [
    r.localId,
    ((r.startMs as number) - base) / MINUTE,
    ((r.endMs as number) - base) / MINUTE,
  ]);

// --- Identical answers on both sides ----------------------------------------

const identical = [row("a1", 0, 30), row("a2", 30, 60), row("a3", 60, 90)];
const mergedIdentical = mergeWithNextActivity(identical, "a1");

check(
  "the merged activity spans both, and the second row is gone",
  spans(mergedIdentical.rows),
  [
    ["a1", 0, 60],
    ["a3", 60, 90],
  ],
);
check(
  "answers both activities agreed on survive",
  {
    rawLabel: mergedIdentical.rows[0].rawLabel,
    categoryLabel: mergedIdentical.rows[0].categoryLabel,
    workloadRating: mergedIdentical.rows[0].ratings.mental_demand,
  },
  {
    rawLabel: "computer_or_monitor_use",
    categoryLabel: "work",
    workloadRating: 4,
  },
);
check(
  "nothing is reported as cleared when the two agreed",
  [
    mergedIdentical.clearedLabel,
    mergedIdentical.clearedCategory,
    mergedIdentical.clearedRating,
  ],
  [false, false, false],
);
check(
  "the merged row keeps the first row's identity and proposal link",
  {
    localId: mergedIdentical.rows[0].localId,
    source: mergedIdentical.rows[0].source,
    proposalActivityId: mergedIdentical.rows[0].proposalActivityId,
  },
  { localId: "a1", source: "vlm", proposalActivityId: 1 },
);

// --- Disagreeing answers are cleared -----------------------------------------

const differingLabel = mergeWithNextActivity(
  [row("a1", 0, 30), row("a2", 30, 60, { rawLabel: "paper_reading_writing" })],
  "a1",
);
check(
  "a differing activity is cleared, the agreed category is kept",
  {
    rawLabel: differingLabel.rows[0].rawLabel,
    categoryLabel: differingLabel.rows[0].categoryLabel,
    clearedLabel: differingLabel.clearedLabel,
    clearedCategory: differingLabel.clearedCategory,
  },
  {
    rawLabel: null,
    categoryLabel: "work",
    clearedLabel: true,
    clearedCategory: false,
  },
);

const differingCategory = mergeWithNextActivity(
  [
    row("a1", 0, 30),
    row("a2", 30, 60, {
      categoryLabel: "break",
      ratings: { mental_demand: null, mental_recovery: 6 },
    }),
  ],
  "a1",
);
check(
  "a differing category clears the category and both ratings",
  {
    categoryLabel: differingCategory.rows[0].categoryLabel,
    ratings: differingCategory.rows[0].ratings,
    clearedCategory: differingCategory.clearedCategory,
    clearedRating: differingCategory.clearedRating,
  },
  {
    categoryLabel: null,
    ratings: { mental_demand: null, mental_recovery: null },
    clearedCategory: true,
    clearedRating: true,
  },
);

// The rating is subordinate to the category. Both rows may hold a stale answer
// in the field their category does not use (the server stores both fields as
// sent, so flipping a category mid-draft leaves one behind). Those must never
// survive into the merged row and become an answer nobody gave.
const staleRatings = mergeWithNextActivity(
  [
    row("a1", 0, 30, {
      categoryLabel: "work",
      ratings: { mental_demand: 5, mental_recovery: 3 },
    }),
    row("a2", 30, 60, {
      categoryLabel: "break",
      ratings: { mental_demand: 5, mental_recovery: 3 },
    }),
  ],
  "a1",
);
check(
  "a cleared category drops both ratings even when both rows matched on them",
  {
    categoryLabel: staleRatings.rows[0].categoryLabel,
    ratings: staleRatings.rows[0].ratings,
    clearedRating: staleRatings.clearedRating,
  },
  {
    categoryLabel: null,
    ratings: { mental_demand: null, mental_recovery: null },
    clearedRating: true,
  },
);

const staleOffCategory = mergeWithNextActivity(
  [
    row("a1", 0, 30, {
      categoryLabel: "work",
      ratings: { mental_demand: 5, mental_recovery: 3 },
    }),
    row("a2", 30, 60, {
      categoryLabel: "work",
      ratings: { mental_demand: 5, mental_recovery: 3 },
    }),
  ],
  "a1",
);
check(
  "a surviving category keeps only its own rating and drops the other field",
  {
    categoryLabel: staleOffCategory.rows[0].categoryLabel,
    ratings: staleOffCategory.rows[0].ratings,
    clearedRating: staleOffCategory.clearedRating,
  },
  {
    categoryLabel: "work",
    ratings: { mental_demand: 5, mental_recovery: null },
    // Nothing to re-answer: the work rating survived and nothing reads recovery.
    clearedRating: false,
  },
);

const otherCategory = mergeWithNextActivity(
  [
    row("a1", 0, 30, {
      categoryLabel: "other",
      ratings: { mental_demand: null, mental_recovery: null },
    }),
    row("a2", 30, 60, {
      categoryLabel: "other",
      ratings: { mental_demand: null, mental_recovery: null },
    }),
  ],
  "a1",
);
check(
  "an 'other' activity is never rated, so nothing is announced",
  {
    ratings: otherCategory.rows[0].ratings,
    clearedRating: otherCategory.clearedRating,
  },
  {
    ratings: { mental_demand: null, mental_recovery: null },
    clearedRating: false,
  },
);

const breakPair = mergeWithNextActivity(
  [
    row("a1", 0, 30, {
      categoryLabel: "break",
      ratings: { mental_demand: null, mental_recovery: 6 },
    }),
    row("a2", 30, 60, {
      categoryLabel: "break",
      ratings: { mental_demand: null, mental_recovery: 6 },
    }),
  ],
  "a1",
);
check(
  "two agreeing break activities keep their recovery rating",
  {
    categoryLabel: breakPair.rows[0].categoryLabel,
    recoveryRating: breakPair.rows[0].ratings.mental_recovery,
    clearedRating: breakPair.clearedRating,
  },
  { categoryLabel: "break", recoveryRating: 6, clearedRating: false },
);

const differingRating = mergeWithNextActivity(
  [
    row("a1", 0, 30),
    row("a2", 30, 60, { ratings: { mental_demand: 7, mental_recovery: null } }),
  ],
  "a1",
);
check(
  "the same activity with different ratings keeps the answers but re-asks the rating",
  {
    rawLabel: differingRating.rows[0].rawLabel,
    categoryLabel: differingRating.rows[0].categoryLabel,
    workloadRating: differingRating.rows[0].ratings.mental_demand,
    clearedRating: differingRating.clearedRating,
  },
  {
    rawLabel: "computer_or_monitor_use",
    categoryLabel: "work",
    workloadRating: null,
    clearedRating: true,
  },
);

const bothBlank = mergeWithNextActivity(
  [
    row("a1", 0, 30, {
      rawLabel: null,
      categoryLabel: null,
      ratings: { mental_demand: null, mental_recovery: null },
    }),
    row("a2", 30, 60, {
      rawLabel: null,
      categoryLabel: null,
      ratings: { mental_demand: null, mental_recovery: null },
    }),
  ],
  "a1",
);
check(
  "merging two unlabelled chunks loses nothing, so nothing is announced",
  [bothBlank.clearedLabel, bothBlank.clearedCategory, bothBlank.clearedRating],
  [false, false, false],
);

const oneBlank = mergeWithNextActivity(
  [row("a1", 0, 30, { rawLabel: null }), row("a2", 30, 60)],
  "a1",
);
check(
  "an answer only the second row had is still reported as cleared",
  { rawLabel: oneBlank.rows[0].rawLabel, clearedLabel: oneBlank.clearedLabel },
  { rawLabel: null, clearedLabel: true },
);

// --- Edges -------------------------------------------------------------------

const rowsForEdges = [row("a1", 0, 30), row("a2", 30, 60)];
check(
  "merging the last activity is a no-op",
  mergeWithNextActivity(rowsForEdges, "a2").rows === rowsForEdges,
  true,
);
check(
  "an unknown row is a no-op",
  mergeWithNextActivity(rowsForEdges, "nope").rows === rowsForEdges,
  true,
);
check(
  "an incomplete span is a no-op",
  mergeWithNextActivity(
    [row("a1", 0, 30), { ...row("a2", 30, 60), endMs: null }],
    "a1",
  ).rows.length,
  2,
);

const withGap = mergeWithNextActivity(
  [row("a1", 0, 30), row("a2", 45, 60)],
  "a1",
);
check(
  "a gap left by an earlier deletion is absorbed, keeping the span contiguous",
  spans(withGap.rows),
  [["a1", 0, 60]],
);

const outOfOrder = mergeWithNextActivity(
  [row("a2", 30, 60), row("a1", 0, 30)],
  "a1",
);
check(
  "neighbours are decided by chronology, not array order",
  spans(outOfOrder.rows),
  [["a1", 0, 60]],
);

// --- activitiesInviteMerge ---------------------------------------------------

check(
  "identical activity and type invite a merge",
  activitiesInviteMerge(row("a1", 0, 30), row("a2", 30, 60)),
  true,
);
check(
  "a differing activity does not",
  activitiesInviteMerge(
    row("a1", 0, 30),
    row("a2", 30, 60, { rawLabel: "paper_reading_writing" }),
  ),
  false,
);
check(
  "a differing type does not",
  activitiesInviteMerge(
    row("a1", 0, 30),
    row("a2", 30, 60, { categoryLabel: "break" }),
  ),
  false,
);
check(
  "two unanswered rows do not invite a merge",
  activitiesInviteMerge(
    row("a1", 0, 30, { rawLabel: null, categoryLabel: null }),
    row("a2", 30, 60, { rawLabel: null, categoryLabel: null }),
  ),
  false,
);
check(
  "differing ratings still invite a merge — only activity and type decide",
  activitiesInviteMerge(
    row("a1", 0, 30),
    row("a2", 30, 60, { ratings: { mental_demand: 7, mental_recovery: null } }),
  ),
  true,
);

if (failures > 0) {
  console.error(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log("\nAll activity merge checks passed.");
