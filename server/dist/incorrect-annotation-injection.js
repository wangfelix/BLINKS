"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.injectIncorrectAnnotations = exports.INCORRECT_ANNOTATION_MIN_MEAN_CONFIDENCE = exports.INCORRECT_ANNOTATION_RATE = void 0;
const crypto_1 = require("crypto");
const activity_vocabulary_1 = require("./activity-vocabulary");
exports.INCORRECT_ANNOTATION_RATE = 0.1;
exports.INCORRECT_ANNOTATION_MIN_MEAN_CONFIDENCE = 0.8;
const CATEGORIES = ["work", "break", "other"];
const defaultRandomIndex = (upperExclusive) => (0, crypto_1.randomInt)(upperExclusive);
const chooseAlternative = (values, original, randomIndex) => {
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
const injectIncorrectAnnotations = (activities, randomIndex = defaultRandomIndex) => {
    const prepared = activities.map((activity) => ({
        ...activity,
        presentedRawLabel: activity.rawLabel,
        presentedCategoryLabel: activity.categoryLabel,
        isIncorrectAnnotationInjected: false,
    }));
    const candidates = prepared
        .map((activity, index) => ({ activity, index }))
        .filter(({ activity }) => activity.rawLabel !== null &&
        activity_vocabulary_1.ACTIVITY_LABELS.includes(activity.rawLabel) &&
        activity.categoryLabel !== null &&
        CATEGORIES.includes(activity.categoryLabel) &&
        activity.vlmMeanActivityConfidence !== null &&
        Number.isFinite(activity.vlmMeanActivityConfidence))
        .sort((first, second) => {
        const confidenceDifference = second.activity.vlmMeanActivityConfidence -
            first.activity.vlmMeanActivityConfidence;
        return confidenceDifference !== 0
            ? confidenceDifference
            : first.index - second.index;
    });
    if (candidates.length === 0)
        return prepared;
    const targetCount = Math.ceil(candidates.length * exports.INCORRECT_ANNOTATION_RATE);
    const aboveThreshold = candidates.filter(({ activity }) => activity.vlmMeanActivityConfidence >=
        exports.INCORRECT_ANNOTATION_MIN_MEAN_CONFIDENCE);
    const selected = aboveThreshold.length > 0
        ? aboveThreshold.slice(0, targetCount)
        : candidates.slice(0, 1);
    for (const { activity } of selected) {
        activity.presentedRawLabel = chooseAlternative(activity_vocabulary_1.ACTIVITY_LABELS, activity.rawLabel, randomIndex);
        activity.presentedCategoryLabel = chooseAlternative(CATEGORIES, activity.categoryLabel, randomIndex);
        activity.isIncorrectAnnotationInjected = true;
    }
    return prepared;
};
exports.injectIncorrectAnnotations = injectIncorrectAnnotations;
