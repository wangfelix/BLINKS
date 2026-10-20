// Runs under ANY active study config (BLINKS_STUDY_CONFIG): the behaviour
// tests pass explicit settings (paper values loaded from study.example.yaml),
// the CONFIGURED_* exports are compared against the active config.
import assert = require("assert");
import path = require("path");

import {
  CONFIGURED_OVERRELIANCE,
  INCORRECT_ANNOTATION_MIN_MEAN_CONFIDENCE,
  INCORRECT_ANNOTATION_RATE,
  injectIncorrectAnnotations,
} from "../src/incorrect-annotation-injection";
import type { SegmentedActivity } from "../src/segmentation";
import { ACTIVITY_KEYS, CATEGORY_KEYS, studyConfig } from "../src/study-config";
import { loadStudyConfigFile } from "../src/study-config/load";

const paperConfig = loadStudyConfigFile(path.resolve(__dirname, "..", "..", "config", "study.example.yaml"));
const PAPER = {
  ...paperConfig.overreliance,
  activityKeys: paperConfig.activities.map(({ key }) => key),
  categoryKeys: paperConfig.categories.map(({ key }) => key),
};

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

assert.equal(PAPER.rate, 0.1);
assert.equal(PAPER.minConfidence, 0.8);
// the module reads the ACTIVE config, whatever it is
assert.equal(INCORRECT_ANNOTATION_RATE, studyConfig.overreliance.rate);
assert.equal(INCORRECT_ANNOTATION_MIN_MEAN_CONFIDENCE, studyConfig.overreliance.minConfidence);
assert.deepStrictEqual(CONFIGURED_OVERRELIANCE, {
  ...studyConfig.overreliance,
  activityKeys: ACTIVITY_KEYS,
  categoryKeys: CATEGORY_KEYS,
});

const twentyActivities = Array.from({ length: 20 }, (_, index) =>
  activity(index, 0.99 - index * 0.01),
);
const injected = injectIncorrectAnnotations(twentyActivities, () => 0, PAPER);
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
  PAPER,
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
  PAPER,
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
  injectIncorrectAnnotations([blank], () => 0, PAPER)[0]
    .isIncorrectAnnotationInjected,
  false,
  "blank activities are excluded",
);

// Study config switches (overreliance.*).
const twenty = Array.from({ length: 20 }, (_, index) => activity(index, 0.95));
assert.ok(
  injectIncorrectAnnotations(twenty, () => 0, { ...PAPER, enabled: false }).every(
    (entry) =>
      !entry.isIncorrectAnnotationInjected &&
      entry.presentedRawLabel === entry.rawLabel &&
      entry.presentedCategoryLabel === entry.categoryLabel,
  ),
  "enabled=false never injects",
);
assert.equal(
  injectIncorrectAnnotations(
    [activity(0, 0.5), activity(1, 0.79)],
    () => 0,
    { ...PAPER, fallbackToTopWhenNoneAboveThreshold: false },
  ).filter((entry) => entry.isIncorrectAnnotationInjected).length,
  0,
  "fallback off: nothing injected when none reaches minConfidence",
);
assert.equal(
  injectIncorrectAnnotations(twenty, () => 0, { ...PAPER, rate: 0.25 }).filter(
    (entry) => entry.isIncorrectAnnotationInjected,
  ).length,
  5,
  "rate is configurable (ceil(20 * 0.25))",
);
const twoKeys = { ...PAPER, activityKeys: ["computer_or_monitor_use", "eating_drinking"], categoryKeys: ["work", "break"] };
const swapped = injectIncorrectAnnotations([activity(0, 0.95)], () => 0, twoKeys)[0];
assert.ok(
  twoKeys.activityKeys.includes(swapped.presentedRawLabel!) && twoKeys.categoryKeys.includes(swapped.presentedCategoryLabel!),
  "replacement labels come from the configured vocabulary",
);

// A single category must not crash (crypto.randomInt(0) threw).
// The loader refuses enabled + 1 category; the module keeps the original.
const oneCategory = { ...PAPER, categoryKeys: ["work"] };
const single = injectIncorrectAnnotations([activity(0, 0.95)], undefined, oneCategory)[0];
assert.equal(single.isIncorrectAnnotationInjected, true);
assert.equal(single.presentedCategoryLabel, "work", "no alternative category: unchanged");
assert.notEqual(single.presentedRawLabel, single.rawLabel, "activity still swapped");

// rate 0 = never inject: no rate-based selection AND no
// fallback, for many activities and for the smallest possible input.
const allBelow = Array.from({ length: 200 }, (_, index) => activity(index, 0.5 - index * 0.001));
const allAbove = Array.from({ length: 200 }, (_, index) => activity(index, 0.99));
for (const [name, input] of [
  ["200 above the threshold", allAbove],
  ["200 below the threshold", allBelow],
  ["one activity above", [activity(0, 0.95)]],
  ["one activity below", [activity(0, 0.5)]],
  ["no activities", []],
] as [string, SegmentedActivity[]][]) {
  for (const fallbackToTopWhenNoneAboveThreshold of [true, false]) {
    const out = injectIncorrectAnnotations(input, () => 0, { ...PAPER, rate: 0, fallbackToTopWhenNoneAboveThreshold });
    assert.ok(
      out.every((e) => !e.isIncorrectAnnotationInjected && e.presentedRawLabel === e.rawLabel && e.presentedCategoryLabel === e.categoryLabel),
      `rate 0, ${name}, fallback ${fallbackToTopWhenNoneAboveThreshold}: nothing injected`,
    );
  }
}
// rate > 0 unchanged: the smallest rate still selects ceil(...) = 1, and the
// fallback still applies when none reaches the threshold
assert.equal(
  injectIncorrectAnnotations(allAbove, () => 0, { ...PAPER, rate: 0.001 }).filter((e) => e.isIncorrectAnnotationInjected).length,
  1,
);
assert.equal(
  injectIncorrectAnnotations([activity(0, 0.5)], () => 0, PAPER).filter((e) => e.isIncorrectAnnotationInjected).length,
  1,
  "paper: fallback when none reaches 0.8",
);

// non-paper threshold/rate: 0.5 / 0.5 over 6 activities -> ceil(3) of those >= 0.6
const custom = { ...PAPER, rate: 0.5, minConfidence: 0.6 };
const mixed = [0.9, 0.55, 0.7, 0.65, 0.3, 0.61].map((c, index) => activity(index, c));
assert.deepStrictEqual(
  injectIncorrectAnnotations(mixed, () => 0, custom).map((e) => e.isIncorrectAnnotationInjected),
  [true, false, true, true, false, false],
  "highest three of those >= 0.6",
);

console.log("INCORRECT ANNOTATION INJECTION TESTS PASSED");
