"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.injectIncorrectAnnotations = exports.INCORRECT_ANNOTATION_MIN_MEAN_CONFIDENCE = exports.INCORRECT_ANNOTATION_RATE = exports.CONFIGURED_OVERRELIANCE = void 0;
const crypto_1 = require("crypto");
const study_config_1 = require("./study-config");
exports.CONFIGURED_OVERRELIANCE = {
    ...study_config_1.studyConfig.overreliance,
    activityKeys: study_config_1.ACTIVITY_KEYS,
    categoryKeys: study_config_1.CATEGORY_KEYS,
};
exports.INCORRECT_ANNOTATION_RATE = exports.CONFIGURED_OVERRELIANCE.rate;
exports.INCORRECT_ANNOTATION_MIN_MEAN_CONFIDENCE = exports.CONFIGURED_OVERRELIANCE.minConfidence;
const defaultRandomIndex = (upperExclusive) => (0, crypto_1.randomInt)(upperExclusive);
const chooseAlternative = (values, original, randomIndex) => {
    const alternatives = values.filter((value) => value !== original);
    // The loader requires >= 2 categories/activities when injection is on; keep
    // the original rather than calling randomIndex(0) (crypto.randomInt throws).
    if (alternatives.length === 0)
        return original;
    return alternatives[randomIndex(alternatives.length)];
};
/**
 * Prepare the immutable proposal plus the annotations initially presented in
 * the assisted editor. The genuine VLM labels remain on rawLabel/categoryLabel;
 * only presented* is changed for the selected high-confidence activities.
 *
 * Eligible count = valid labelled activities with a finite mean activity
 * argmax probability. Up to ceil(rate) of all valid labelled activities are
 * selected from scores >= minConfidence (paper: 10%, 0.8). If none reaches
 * the threshold and fallbackToTopWhenNoneAboveThreshold is set, the single
 * highest-scoring activity is selected. Blank/legacy activities without
 * confidence are not candidates. enabled=false or rate=0 injects nothing
 * (rate=0 also skips the fallback).
 */
const injectIncorrectAnnotations = (activities, randomIndex = defaultRandomIndex, settings = exports.CONFIGURED_OVERRELIANCE) => {
    const prepared = activities.map((activity) => ({
        ...activity,
        presentedRawLabel: activity.rawLabel,
        presentedCategoryLabel: activity.categoryLabel,
        isIncorrectAnnotationInjected: false,
    }));
    // rate 0 = never inject (no fallback label either).
    if (!settings.enabled || settings.rate === 0)
        return prepared;
    const candidates = prepared
        .map((activity, index) => ({ activity, index }))
        .filter(({ activity }) => activity.rawLabel !== null &&
        settings.activityKeys.includes(activity.rawLabel) &&
        activity.categoryLabel !== null &&
        settings.categoryKeys.includes(activity.categoryLabel) &&
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
    const targetCount = Math.ceil(candidates.length * settings.rate);
    const aboveThreshold = candidates.filter(({ activity }) => activity.vlmMeanActivityConfidence >=
        settings.minConfidence);
    const selected = aboveThreshold.length > 0
        ? aboveThreshold.slice(0, targetCount)
        : settings.fallbackToTopWhenNoneAboveThreshold
            ? candidates.slice(0, 1)
            : [];
    for (const { activity } of selected) {
        activity.presentedRawLabel = chooseAlternative(settings.activityKeys, activity.rawLabel, randomIndex);
        activity.presentedCategoryLabel = chooseAlternative(settings.categoryKeys, activity.categoryLabel, randomIndex);
        activity.isIncorrectAnnotationInjected = true;
    }
    return prepared;
};
exports.injectIncorrectAnnotations = injectIncorrectAnnotations;
