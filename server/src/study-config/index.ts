// Process-wide study config plus the derived values the server uses.
// Loaded once on first import; an invalid file exits the process with code 2
// (see load.ts). All study-relevant values come from here, never from env.

import { getStudyConfig } from "./load";
import type { StudyConfig } from "./schema";

export type { StudyConfig } from "./schema";

export const studyConfig: StudyConfig = getStudyConfig();

export const ACTIVITY_KEYS: readonly string[] = studyConfig.activities.map(
  (activity) => activity.key,
);
export const ACTIVITY_KEY_SET: ReadonlySet<string> = new Set(ACTIVITY_KEYS);

export const CATEGORY_KEYS: readonly string[] = studyConfig.categories.map(
  (category) => category.key,
);
export const CATEGORY_KEY_SET: ReadonlySet<string> = new Set(CATEGORY_KEYS);

export const FORM_FACTOR_KEYS: readonly string[] =
  studyConfig.devices.formFactors.map((formFactor) => formFactor.key);

export const EXPERIENCE_ITEMS = studyConfig.experienceItems;

export const WINDOW_MS = studyConfig.windowing.windowMinutes * 60_000;
export const IDLE_CLOSE_MS = studyConfig.windowing.idleCloseMinutes * 60_000;

/** "HH:MM" -> minutes since midnight (already validated by the schema). */
export const minutesOfTimeOfDay = (value: string): number => {
  const [hour, minute] = value.split(":").map(Number);
  return hour * 60 + minute;
};
