// Client-facing projections of the study config (contract sections 4.1, 4.3,
// 4.6). Only whitelisted fields leave the server: no VLM prompts or
// definitions, no overreliance values, no privacy settings. The PIN goes to
// participants only (app-config) and is never logged.

import { studyConfig as loadedStudyConfig } from "./index";
import type { StudyConfig } from "./schema";

export interface SurveyLink {
  url: string;
  participantParameter: string;
}

export const studyConfigResponse = (
  isParticipant: boolean,
  config: StudyConfig = loadedStudyConfig,
) => ({
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
        } satisfies SurveyLink,
        final: {
          url: config.surveys.final.url,
          participantParameter: config.surveys.final.participantParameter,
        } satisfies SurveyLink,
      }
    : null,
});

export const appConfigResponse = (config: StudyConfig = loadedStudyConfig) => ({
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

/** Contract 4.6 rule 1: every configured item key, null when unanswered. */
export const ratingsResponse = (
  stored: Record<string, number>,
  config: StudyConfig = loadedStudyConfig,
): Record<string, number | null> =>
  Object.fromEntries(
    config.experienceItems.map((item) => [
      item.key,
      Object.prototype.hasOwnProperty.call(stored, item.key)
        ? stored[item.key]
        : null,
    ]),
  );

/**
 * Contract 4.6 rules 2-4. submitCategory: undefined = draft save (no
 * required check); string|null = final category on submit. Errors are
 * returned WITHOUT the "activity <i>: " prefix.
 */
export const parseRatingsInput = (
  raw: unknown,
  submitCategory: string | null | undefined,
  config: StudyConfig = loadedStudyConfig,
): { ratings?: Record<string, number | null>; error?: string } => {
  const ratings: Record<string, number | null> = {};
  if (raw !== undefined && raw !== null) {
    if (typeof raw !== "object" || Array.isArray(raw)) {
      return { error: "ratings must be an object" };
    }
    const items = new Map(config.experienceItems.map((item) => [item.key, item]));
    for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
      const item = items.get(key);
      if (item === undefined) return { error: `unknown rating item "${key}"` };
      if (value === null) {
        ratings[key] = null;
        continue;
      }
      if (
        typeof value !== "number" ||
        !Number.isInteger(value) ||
        value < item.scale.min ||
        value > item.scale.max
      ) {
        return {
          error: `ratings.${key} must be an integer ${item.scale.min}-${item.scale.max} or null`,
        };
      }
      ratings[key] = value;
    }
  }
  if (submitCategory !== undefined && submitCategory !== null) {
    for (const item of config.experienceItems) {
      if (
        item.requiredOnSubmit &&
        item.appliesTo.includes(submitCategory) &&
        (ratings[item.key] === undefined || ratings[item.key] === null)
      ) {
        return {
          error: `ratings.${item.key} is required to submit a ${submitCategory} activity`,
        };
      }
    }
  }
  return { ratings };
};
