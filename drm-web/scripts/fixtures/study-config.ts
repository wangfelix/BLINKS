// Study-config fixtures for the drm-web script tests.
//
// defaultStudyConfig() maps config/study.example.yaml to the
// GET /api/study-config payload (docs/study-config-documentation.md, 4.1).
// testStudyConfig() does the same for config/study.test.yaml.
// alternativeStudyConfig() is an independent study (5 labels, 2 categories,
// 3 items, 10-minute window).

import { readFileSync } from "node:fs";
import path from "node:path";
import { parse } from "yaml";

import type { StudyConfigResponse } from "../../src/lib/api-types";
import { installStudyConfig } from "../../src/lib/study-config-store";

/* eslint-disable @typescript-eslint/no-explicit-any -- raw YAML document */
const studyConfigFromYaml = (fileName: string): StudyConfigResponse => {
  const file = path.join(__dirname, "..", "..", "..", "config", fileName);
  const yaml = parse(readFileSync(file, "utf8")) as any;
  return {
    study: { timezone: yaml.study.timezone },
    ui: {
      locale: yaml.ui.locale,
      thumbnailsPerActivity: yaml.ui.thumbnailsPerActivity,
    },
    windowing: { windowMinutes: yaml.windowing.windowMinutes },
    schedule: { reconstructionOpensAt: yaml.schedule.reconstructionOpensAt },
    activities: yaml.activities.map((activity: any) => ({
      key: activity.key,
      displayLabel: activity.displayLabel,
    })),
    categories: yaml.categories.map((category: any) => ({
      key: category.key,
      displayLabel: category.displayLabel,
      icon: category.icon,
      description: category.description,
    })),
    experienceItems: yaml.experienceItems.map((item: any) => ({
      key: item.key,
      appliesTo: item.appliesTo,
      question: item.question,
      shortLabel: item.shortLabel,
      scale: item.scale,
      requiredOnSubmit: item.requiredOnSubmit,
    })),
    texts: { rounds: yaml.texts.rounds, progress: yaml.texts.progress },
    surveys: {
      onboarding: yaml.surveys.onboarding,
      final: yaml.surveys.final,
    },
  };
};
/* eslint-enable @typescript-eslint/no-explicit-any */

export const defaultStudyConfig = (): StudyConfigResponse =>
  studyConfigFromYaml("study.example.yaml");

export const testStudyConfig = (): StudyConfigResponse =>
  studyConfigFromYaml("study.test.yaml");

export const alternativeStudyConfig = (): StudyConfigResponse => ({
  ...defaultStudyConfig(),
  windowing: { windowMinutes: 10 },
  ui: { locale: "en-GB", thumbnailsPerActivity: 3 },
  activities: [
    { key: "lecture", displayLabel: "Attending a lecture" },
    { key: "self_study", displayLabel: "Self-study" },
    { key: "commuting", displayLabel: "Commuting" },
    { key: "socializing", displayLabel: "Socializing" },
    { key: "unclear", displayLabel: "Unclear" },
  ],
  categories: [
    {
      key: "study",
      displayLabel: "Study",
      icon: "book-open",
      description: "Anything you do for your degree.",
    },
    {
      key: "leisure",
      displayLabel: "Leisure",
      icon: "coffee",
      description: "Everything else.",
    },
  ],
  experienceItems: [
    {
      key: "focus",
      appliesTo: ["study"],
      question: "How focused were you?",
      shortLabel: "Focus",
      scale: { min: 1, max: 5, lowAnchor: "Not at all", highAnchor: "Fully" },
      requiredOnSubmit: true,
    },
    {
      key: "enjoyment",
      appliesTo: ["study", "leisure"],
      question: "How much did you enjoy it?",
      shortLabel: "Enjoyment",
      scale: { min: 0, max: 10, lowAnchor: "Not at all", highAnchor: "A lot" },
      requiredOnSubmit: false,
    },
    {
      key: "fatigue",
      appliesTo: ["leisure"],
      question: "How tired were you?",
      shortLabel: "Fatigue",
      scale: { min: 1, max: 7, lowAnchor: "Not at all", highAnchor: "Very" },
      requiredOnSubmit: true,
    },
  ],
});

export const installDefaultStudyConfig = (): StudyConfigResponse => {
  const config = defaultStudyConfig();
  installStudyConfig(config);
  return config;
};
