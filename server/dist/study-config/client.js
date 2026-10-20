"use strict";
// Client-facing projections of the study config (documentation sections 4.1, 4.3,
// 4.6). Only whitelisted fields leave the server: no VLM prompts or
// definitions, no overreliance values, no privacy settings. The PIN goes to
// participants only (app-config) and is never logged.
Object.defineProperty(exports, "__esModule", { value: true });
exports.parseRatingsInput = exports.ratingsResponse = exports.appConfigResponse = exports.studyConfigResponse = void 0;
const index_1 = require("./index");
const studyConfigResponse = (isParticipant, config = index_1.studyConfig) => ({
    study: { timezone: config.study.timezone },
    ui: {
        locale: config.ui.locale,
        thumbnailsPerActivity: config.ui.thumbnailsPerActivity,
    },
    windowing: { windowMinutes: config.windowing.windowMinutes },
    schedule: { reconstructionOpensAt: config.schedule.reconstructionOpensAt },
    activities: config.activities.map(({ key, displayLabel }) => ({
        key,
        displayLabel,
    })),
    categories: config.categories.map(({ key, displayLabel, icon, description }) => ({
        key,
        displayLabel,
        icon,
        description,
    })),
    experienceItems: config.experienceItems.map((item) => ({
        key: item.key,
        appliesTo: [...item.appliesTo],
        question: item.question,
        shortLabel: item.shortLabel,
        scale: {
            min: item.scale.min,
            max: item.scale.max,
            lowAnchor: item.scale.lowAnchor,
            highAnchor: item.scale.highAnchor,
        },
        requiredOnSubmit: item.requiredOnSubmit,
    })),
    texts: {
        rounds: { ...config.texts.rounds },
        progress: { ...config.texts.progress },
    },
    surveys: isParticipant
        ? {
            onboarding: {
                url: config.surveys.onboarding.url,
                participantParameter: config.surveys.onboarding.participantParameter,
            },
            final: {
                url: config.surveys.final.url,
                participantParameter: config.surveys.final.participantParameter,
            },
        }
        : null,
});
exports.studyConfigResponse = studyConfigResponse;
const appConfigResponse = (config = index_1.studyConfig) => ({
    timezone: config.study.timezone,
    schedule: { endSessionAvailableAt: config.schedule.endSessionAvailableAt },
    devices: {
        formFactors: config.devices.formFactors.map(({ key, displayLabel }) => ({
            key,
            displayLabel,
        })),
    },
    capture: {
        intervalMsByFormFactor: { ...config.capture.intervalMsByFormFactor },
    },
    texts: {
        app: {
            recordingNotificationTitle: config.texts.app.recordingNotificationTitle,
            recordingNotificationBody: config.texts.app.recordingNotificationBody,
            testRecordingNotificationTitle: config.texts.app.testRecordingNotificationTitle,
            testRecordingNotificationBody: config.texts.app.testRecordingNotificationBody,
            endSessionAvailableFrom: config.texts.app.endSessionAvailableFrom,
            onboarding: { ...config.texts.app.onboarding },
        },
    },
    studySettingsPin: config.app.studySettingsPin,
});
exports.appConfigResponse = appConfigResponse;
const ratingsResponse = (stored, config = index_1.studyConfig) => Object.fromEntries(config.experienceItems.map((item) => [
    item.key,
    Object.prototype.hasOwnProperty.call(stored, item.key)
        ? stored[item.key]
        : null,
]));
exports.ratingsResponse = ratingsResponse;
const parseRatingsInput = (raw, submitCategory, config = index_1.studyConfig) => {
    const ratings = {};
    if (raw !== undefined && raw !== null) {
        if (typeof raw !== "object" || Array.isArray(raw)) {
            return { error: "ratings must be an object" };
        }
        const items = new Map(config.experienceItems.map((item) => [item.key, item]));
        for (const [key, value] of Object.entries(raw)) {
            const item = items.get(key);
            if (item === undefined)
                return { error: `unknown rating item "${key}"` };
            if (value === null) {
                ratings[key] = null;
                continue;
            }
            if (typeof value !== "number" ||
                !Number.isInteger(value) ||
                value < item.scale.min ||
                value > item.scale.max) {
                return {
                    error: `ratings.${key} must be an integer ${item.scale.min}-${item.scale.max} or null`,
                };
            }
            ratings[key] = value;
        }
    }
    if (submitCategory !== undefined && submitCategory !== null) {
        for (const item of config.experienceItems) {
            if (item.requiredOnSubmit &&
                item.appliesTo.includes(submitCategory) &&
                (ratings[item.key] === undefined || ratings[item.key] === null)) {
                return {
                    error: `ratings.${item.key} is required to submit a ${submitCategory} activity`,
                };
            }
        }
    }
    return { ratings };
};
exports.parseRatingsInput = parseRatingsInput;
