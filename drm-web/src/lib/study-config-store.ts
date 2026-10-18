// Runtime study configuration (GET /api/study-config).
//
// The server loads config/study.yaml at start-up and serves the participant-
// facing part; drm-web has NO defaults of its own. StudyConfigGate fetches the
// config once per sign-in and installs it here before any study page renders,
// so the pure helpers (vocabularies, time formatting, editor model) can read
// it synchronously. Tests install a fixture with installStudyConfig().

import type {
  StudyConfigCategory,
  StudyConfigExperienceItem,
  StudyConfigResponse,
} from "@/lib/api-types";

let currentConfig: StudyConfigResponse | null = null;
const listeners = new Set<() => void>();

export const installStudyConfig = (config: StudyConfigResponse): void => {
  if (currentConfig === config) return;
  currentConfig = config;
  listeners.forEach((listener) => listener());
};

export const hasStudyConfig = (): boolean => currentConfig !== null;

/** The installed config. Throws if a study page rendered before the gate. */
export const getStudyConfig = (): StudyConfigResponse => {
  if (currentConfig === null) {
    throw new Error("Study config not loaded (render inside StudyConfigGate)");
  }
  return currentConfig;
};

export const subscribeToStudyConfig = (listener: () => void): (() => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

/** Length of one clock-aligned window (VLM chunk + editor grid) in ms. */
export const windowMs = (): number =>
  getStudyConfig().windowing.windowMinutes * 60_000;

export const thumbnailsPerActivity = (): number =>
  getStudyConfig().ui.thumbnailsPerActivity;

export const studyCategories = (): StudyConfigCategory[] =>
  getStudyConfig().categories;

export const isCategoryLabel = (value: unknown): value is string =>
  typeof value === "string" &&
  getStudyConfig().categories.some((category) => category.key === value);

export const experienceItems = (): StudyConfigExperienceItem[] =>
  getStudyConfig().experienceItems;

/** Items asked for an activity of this category, in config order. */
export const experienceItemsForCategory = (
  category: string | null,
): StudyConfigExperienceItem[] =>
  category === null
    ? []
    : getStudyConfig().experienceItems.filter((item) =>
        item.appliesTo.includes(category),
      );

/** Ratings object with every configured item key, unanswered = null. */
export const emptyRatings = (): Record<string, number | null> =>
  Object.fromEntries(
    getStudyConfig().experienceItems.map((item) => [item.key, null]),
  );

const NUMBER_WORDS = [
  "zero",
  "one",
  "two",
  "three",
  "four",
  "five",
  "six",
  "seven",
  "eight",
  "nine",
  "ten",
  "eleven",
  "twelve",
];

/** Window length as an English compound adjective, e.g. 5 -> "five-minute". */
export const windowMinuteAdjective = (): string => {
  const minutes = getStudyConfig().windowing.windowMinutes;
  return `${NUMBER_WORDS[minutes] ?? String(minutes)}-minute`;
};
