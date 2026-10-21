import { randomInt } from "crypto";

import type { SegmentedActivity } from "./segmentation";
import { ACTIVITY_KEYS, CATEGORY_KEYS, studyConfig } from "./study-config";

/** overreliance.* from the study config. */
export interface OverrelianceSettings {
  enabled: boolean;
  rate: number;
  minConfidence: number;
  fallbackToTopWhenNoneAboveThreshold: boolean;
  activityKeys: readonly string[];
  categoryKeys: readonly string[];
}

export const CONFIGURED_OVERRELIANCE: OverrelianceSettings = {
  ...studyConfig.overreliance,
  activityKeys: ACTIVITY_KEYS,
  categoryKeys: CATEGORY_KEYS,
};

export const INCORRECT_ANNOTATION_RATE = CONFIGURED_OVERRELIANCE.rate;
export const INCORRECT_ANNOTATION_MIN_MEAN_CONFIDENCE =
  CONFIGURED_OVERRELIANCE.minConfidence;

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
  // With fewer than 2 categories/activities the original label is kept.
  if (alternatives.length === 0) return original;
  return alternatives[randomIndex(alternatives.length)];
};

/**
 * Prepare the immutable proposal plus the annotations initially presented in
 * the assisted editor. The genuine VLM labels remain on rawLabel/categoryLabel;
 * only presented* is changed for the selected high-confidence activities.
 *
 * Eligible count = valid labelled activities with a finite mean activity
 * argmax probability. Up to ceil(rate) of all valid labelled activities are
 * selected from scores >= minConfidence. If none reaches
 * the threshold and fallbackToTopWhenNoneAboveThreshold is set, the single
 * highest-scoring activity is selected. Blank/legacy activities without
 * confidence are not candidates. enabled=false or rate=0 injects nothing
 * (rate=0 also skips the fallback).
 */
export const injectIncorrectAnnotations = (
  activities: SegmentedActivity[],
  randomIndex: RandomIndex = defaultRandomIndex,
  settings: OverrelianceSettings = CONFIGURED_OVERRELIANCE,
): PreparedProposalActivity[] => {
  const prepared = activities.map((activity) => ({
    ...activity,
    presentedRawLabel: activity.rawLabel,
    presentedCategoryLabel: activity.categoryLabel,
    isIncorrectAnnotationInjected: false,
  }));
  // rate 0 = never inject (no fallback label either).
  if (!settings.enabled || settings.rate === 0) return prepared;
  const candidates = prepared
    .map((activity, index) => ({ activity, index }))
    .filter(
      ({ activity }) =>
        activity.rawLabel !== null &&
        settings.activityKeys.includes(activity.rawLabel) &&
        activity.categoryLabel !== null &&
        settings.categoryKeys.includes(activity.categoryLabel) &&
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
    candidates.length * settings.rate,
  );
  const aboveThreshold = candidates.filter(
    ({ activity }) =>
      activity.vlmMeanActivityConfidence! >=
      settings.minConfidence,
  );
  const selected =
    aboveThreshold.length > 0
      ? aboveThreshold.slice(0, targetCount)
      : settings.fallbackToTopWhenNoneAboveThreshold
        ? candidates.slice(0, 1)
        : [];

  for (const { activity } of selected) {
    activity.presentedRawLabel = chooseAlternative(
      settings.activityKeys,
      activity.rawLabel as string,
      randomIndex,
    );
    activity.presentedCategoryLabel = chooseAlternative(
      settings.categoryKeys,
      activity.categoryLabel as string,
      randomIndex,
    );
    activity.isIncorrectAnnotationInjected = true;
  }

  return prepared;
};
