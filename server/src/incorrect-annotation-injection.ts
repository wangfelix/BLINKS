import { randomInt } from "crypto";

import {
  ACTIVITY_LABELS,
  type ActivityLabel,
} from "./activity-vocabulary";
import type { SegmentedActivity } from "./segmentation";

export const INCORRECT_ANNOTATION_RATE = 0.1;
export const INCORRECT_ANNOTATION_MIN_MEAN_CONFIDENCE = 0.8;

const CATEGORIES = ["work", "break", "other"] as const;
type Category = (typeof CATEGORIES)[number];

export interface PreparedProposalActivity extends SegmentedActivity {
  presentedRawLabel: string | null;
  presentedCategoryLabel: string | null;
  isIncorrectAnnotationInjected: boolean;
}

export type RandomIndex = (upperExclusive: number) => number;

const defaultRandomIndex: RandomIndex = (upperExclusive) =>
  randomInt(upperExclusive);

const chooseAlternative = <T>(
  values: readonly T[],
  original: T,
  randomIndex: RandomIndex,
): T => {
  const alternatives = values.filter((value) => value !== original);
  return alternatives[randomIndex(alternatives.length)];
};

/**
 * Prepare the immutable proposal plus the annotations initially presented in
 * the assisted editor. The genuine VLM labels remain on rawLabel/categoryLabel;
 * only presented* is changed for the selected high-confidence activities.
 *
 * Eligible count = valid labelled activities with a finite mean activity
 * argmax probability. Up to ceil(10%) of all valid labelled activities are
 * selected from scores >= 0.8. If none reaches 0.8, the single highest-scoring
 * activity is selected. Blank/legacy activities without confidence are not
 * candidates.
 */
export const injectIncorrectAnnotations = (
  activities: SegmentedActivity[],
  randomIndex: RandomIndex = defaultRandomIndex,
): PreparedProposalActivity[] => {
  const prepared = activities.map((activity) => ({
    ...activity,
    presentedRawLabel: activity.rawLabel,
    presentedCategoryLabel: activity.categoryLabel,
    isIncorrectAnnotationInjected: false,
  }));
  const candidates = prepared
    .map((activity, index) => ({ activity, index }))
    .filter(
      ({ activity }) =>
        activity.rawLabel !== null &&
        ACTIVITY_LABELS.includes(activity.rawLabel as ActivityLabel) &&
        activity.categoryLabel !== null &&
        CATEGORIES.includes(activity.categoryLabel as Category) &&
        activity.vlmMeanActivityConfidence !== null &&
        Number.isFinite(activity.vlmMeanActivityConfidence),
    )
    .sort((first, second) => {
      const confidenceDifference =
        second.activity.vlmMeanActivityConfidence! -
        first.activity.vlmMeanActivityConfidence!;
      return confidenceDifference !== 0
        ? confidenceDifference
        : first.index - second.index;
    });

  if (candidates.length === 0) return prepared;

  const targetCount = Math.ceil(
    candidates.length * INCORRECT_ANNOTATION_RATE,
  );
  const aboveThreshold = candidates.filter(
    ({ activity }) =>
      activity.vlmMeanActivityConfidence! >=
      INCORRECT_ANNOTATION_MIN_MEAN_CONFIDENCE,
  );
  const selected =
    aboveThreshold.length > 0
      ? aboveThreshold.slice(0, targetCount)
      : candidates.slice(0, 1);

  for (const { activity } of selected) {
    activity.presentedRawLabel = chooseAlternative(
      ACTIVITY_LABELS,
      activity.rawLabel as ActivityLabel,
      randomIndex,
    );
    activity.presentedCategoryLabel = chooseAlternative(
      CATEGORIES,
      activity.categoryLabel as Category,
      randomIndex,
    );
    activity.isIncorrectAnnotationInjected = true;
  }

  return prepared;
};
