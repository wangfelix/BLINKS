import assert = require("assert");

import {
  INCORRECT_ANNOTATION_MIN_MEAN_CONFIDENCE,
  INCORRECT_ANNOTATION_RATE,
  injectIncorrectAnnotations,
} from "../src/incorrect-annotation-injection";
import type { SegmentedActivity } from "../src/segmentation";

const activity = (
  index: number,
  confidence: number | null,
): SegmentedActivity => ({
  startMs: index * 300_000,
  endMs: (index + 1) * 300_000,
  rawLabel: "computer_or_monitor_use",
  categoryLabel: "work",
  vlmMeanActivityConfidence: confidence,
  vlmMeanActivityConfidences:
    confidence === null
      ? null
      : {
          computer_or_monitor_use: confidence,
          unclear: 1 - confidence,
        },
  vlmMeanCategoryConfidence: confidence,
  vlmMeanCategoryConfidences:
    confidence === null
      ? null
      : {
          work: confidence,
          break: (1 - confidence) / 2,
          other: (1 - confidence) / 2,
        },
});

assert.equal(INCORRECT_ANNOTATION_RATE, 0.1);
assert.equal(INCORRECT_ANNOTATION_MIN_MEAN_CONFIDENCE, 0.8);

const twentyActivities = Array.from({ length: 20 }, (_, index) =>
  activity(index, 0.99 - index * 0.01),
);
const injected = injectIncorrectAnnotations(twentyActivities, () => 0);
const affected = injected.filter(
  (entry) => entry.isIncorrectAnnotationInjected,
);
assert.equal(affected.length, 2, "ceil(10% of 20) selects two activities");
assert.deepStrictEqual(
  affected.map((entry) => entry.startMs),
  [0, 300_000],
  "selection takes the highest eligible mean confidences",
);
for (const entry of affected) {
  assert.notEqual(entry.presentedRawLabel, entry.rawLabel);
  assert.notEqual(entry.presentedCategoryLabel, entry.categoryLabel);
}

const onlyOneAboveThreshold = injectIncorrectAnnotations(
  Array.from({ length: 20 }, (_, index) =>
    activity(index, index === 7 ? 0.81 : 0.79 - index * 0.001),
  ),
  () => 0,
);
assert.equal(
  onlyOneAboveThreshold.filter((entry) => entry.isIncorrectAnnotationInjected)
    .length,
  1,
  "selection does not backfill below 0.8 when too few qualify",
);

const fallback = injectIncorrectAnnotations(
  [activity(0, 0.5), activity(1, 0.79), activity(2, null)],
  () => 0,
);
assert.deepStrictEqual(
  fallback.map((entry) => entry.isIncorrectAnnotationInjected),
  [false, true, false],
  "when none reaches 0.8, exactly the highest valid activity is selected",
);

const blank = activity(0, 0.99);
blank.rawLabel = null;
blank.categoryLabel = null;
assert.equal(
  injectIncorrectAnnotations([blank], () => 0)[0]
    .isIncorrectAnnotationInjected,
  false,
  "blank activities are excluded",
);

console.log("INCORRECT ANNOTATION INJECTION TESTS PASSED");
