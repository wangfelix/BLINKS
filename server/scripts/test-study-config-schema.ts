// WP0 tests for the study-config schema (BLINKS-tasks#4).
//   npx tsx scripts/test-study-config-schema.ts
//
// 1. config/study-config.schema.json is fresh (generated from the zod schema).
// 2. config/study.example.yaml validates (shape + cross-field checks).
// 3. The example equals today's hard-coded paper study wherever the value
//    lives in TypeScript (server constants, drm-web labels/texts, app texts).
//    The prompt golden test lives in server/vlm/test_study_example_prompts.py.
// 4. Representative invalid configs fail with `path: reason`.

import assert from "assert/strict";
import fs from "fs";
import path from "path";

import { parse as parseYaml } from "yaml";

import { ACTIVITY_LABELS } from "../src/activity-vocabulary";
import {
  INCORRECT_ANNOTATION_MIN_MEAN_CONFIDENCE,
  INCORRECT_ANNOTATION_RATE,
} from "../src/incorrect-annotation-injection";
import {
  StudyConfigSchema,
  studyConfigCrossCheckIssues,
  type StudyConfig,
} from "../src/study-config/schema";
import { ACTIVITY_ITEMS } from "../../drm-web/src/lib/activity-vocabulary";
import {
  renderStudyConfigJsonSchema,
  STUDY_CONFIG_SCHEMA_PATH,
} from "./generate-study-config-schema";

const REPO_ROOT = path.join(__dirname, "..", "..");
const EXAMPLE_PATH = path.join(REPO_ROOT, "config", "study.example.yaml");

const readRepoFile = (relativePath: string): string =>
  fs.readFileSync(path.join(REPO_ROOT, relativePath), "utf8");

/** Validation as the loader will do it: shape first, then cross-checks. */
const validate = (raw: unknown): string[] => {
  const parsed = StudyConfigSchema.safeParse(raw);
  if (!parsed.success) {
    return parsed.error.issues.map(
      (issue) => `${issue.path.join(".")}: ${issue.message}`,
    );
  }
  return studyConfigCrossCheckIssues(parsed.data).map(
    (issue) => `${issue.path}: ${issue.message}`,
  );
};

let passed = 0;
const test = (name: string, body: () => void): void => {
  body();
  passed += 1;
  console.log(`ok - ${name}`);
};

const exampleRaw = parseYaml(fs.readFileSync(EXAMPLE_PATH, "utf8")) as Record<
  string,
  any
>;
const clone = (): Record<string, any> => structuredClone(exampleRaw);

test("generated JSON Schema is up to date", () => {
  assert.equal(
    fs.readFileSync(STUDY_CONFIG_SCHEMA_PATH, "utf8"),
    renderStudyConfigJsonSchema(),
    "run: npm run generate-study-config-schema",
  );
});

test("study.example.yaml is valid", () => {
  assert.deepEqual(validate(exampleRaw), []);
});

const example: StudyConfig = StudyConfigSchema.parse(exampleRaw);

test("example = today's server constants", () => {
  assert.deepEqual(
    example.activities.map((a) => a.key),
    [...ACTIVITY_LABELS],
  );
  assert.deepEqual(
    example.categories.map((c) => c.key),
    ["work", "break", "other"],
  );
  assert.equal(example.overreliance.enabled, true);
  assert.equal(example.overreliance.rate, INCORRECT_ANNOTATION_RATE);
  assert.equal(
    example.overreliance.minConfidence,
    INCORRECT_ANNOTATION_MIN_MEAN_CONFIDENCE,
  );
  assert.equal(example.windowing.windowMinutes * 60 * 1000, 5 * 60 * 1000);
  assert.equal(example.windowing.idleCloseMinutes, 10);
  assert.deepEqual(
    example.devices.formFactors.map((f) => f.key),
    ["necklace", "glasses"],
  );
  assert.equal(example.schedule.reconstructionOpensAt, "19:00");
  assert.equal(example.schedule.dayOverrunHours, 4);
  assert.equal(example.study.timezone, "Europe/Berlin");
  assert.equal(example.privacy.faceBlur.enabled, true);

  // Paper-study values that used to be hardcoded in push.ts / blur_worker.py
  // (both read the config since WP1, so the values are frozen here).
  assert.deepEqual(example.reminders.bedtime, {
    enabled: true,
    leadMinutes: 30,
    defaultBedtime: "22:00",
    latestAt: "23:50",
    afterMidnightCutoff: "12:00",
  });

  assert.deepEqual(example.privacy.faceBlur, {
    enabled: true,
    threshold: 0.2,
    method: "mosaic",
    blocks: 8,
    blurKernel: 0,
    margin: 0.12,
  });

  assert.match(
    readRepoFile("camera-firmware/camera-firmware.ino"),
    new RegExp(
      `#define CAPTURE_INTERVAL_MS ${example.capture.intervalMsByFormFactor.necklace}\\b`,
    ),
  );
  assert.match(
    readRepoFile("glasses-camera-firmware/glasses-camera-firmware.ino"),
    new RegExp(
      `#define CAPTURE_INTERVAL_MS ${example.capture.intervalMsByFormFactor.glasses}\\b`,
    ),
  );
});

test("example = today's drm-web labels and texts", () => {
  assert.deepEqual(
    example.activities.map((a) => ({ value: a.key, label: a.displayLabel })),
    ACTIVITY_ITEMS,
  );

  const sources: Record<string, string> = {
    categories: readRepoFile(
      "drm-web/src/components/reconstruct/category-select.tsx",
    ),
    legend: readRepoFile(
      "drm-web/src/components/reconstruct/category-legend-card.tsx",
    ),
    rating: readRepoFile(
      "drm-web/src/components/reconstruct/experience-rating-scale.tsx",
    ),
    intro: readRepoFile(
      "drm-web/src/components/reconstruct/reconstruction-intro.tsx",
    ),
    reminder: readRepoFile(
      "drm-web/src/components/reconstruct/assisted-round-reminder.tsx",
    ),
    editor: readRepoFile("drm-web/src/components/reconstruct/round-editor.tsx"),
    progress: readRepoFile("drm-web/src/components/study-progress.tsx"),
    notification: readRepoFile(
      "blinks-edge-app/src/capture/service/foreground-service.ts",
    ),
    recording: readRepoFile("blinks-edge-app/src/app/recording.tsx"),
    onboarding: readRepoFile("blinks-edge-app/src/app/onboarding.tsx"),
    summary: readRepoFile(
      "drm-web/src/components/reconstruct/read-only-activity-list.tsx",
    ),
  };
  // JSX wraps long texts across lines; compare whitespace-collapsed.
  const collapse = (text: string): string => text.replace(/\s+/g, " ");
  const expectIn = (source: keyof typeof sources, text: string): void => {
    assert.ok(
      collapse(sources[source]).includes(collapse(text)),
      `"${text}" not found in ${source}`,
    );
  };

  for (const category of example.categories) {
    expectIn("categories", `label: "${category.displayLabel}", value: "${category.key}"`);
    expectIn("legend", category.description);
  }
  for (const item of example.experienceItems) {
    expectIn("rating", item.question);
    expectIn("rating", item.scale.lowAnchor);
    expectIn("rating", item.scale.highAnchor);
    expectIn("summary", `\`${item.shortLabel} \${`);
  }
  const { rounds, progress, push, app } = example.texts;
  expectIn("intro", rounds.selfIntroTitle);
  expectIn("intro", rounds.selfIntroDescription);
  expectIn("intro", rounds.assistedIntroTitle);
  expectIn("intro", rounds.assistedIntroDescription);
  expectIn("reminder", rounds.assistedReminderTitle);
  expectIn("reminder", rounds.assistedReminderBody);
  expectIn("reminder", rounds.assistedReminderIncorrectLabelsNotice!);
  expectIn("editor", rounds.selfEditorHint);
  expectIn("editor", rounds.assistedEditorHint);
  expectIn("editor", rounds.selfEmptyStateHint);
  expectIn("progress", progress.selfRound);
  expectIn("progress", progress.assistedRound);
  // push.ts reads texts.push since WP1; frozen paper-study wording:
  assert.equal(push.bedtimeTitle, "Before you go to bed");
  assert.equal(
    push.bedtimeBody,
    "Please open the study website and reconstruct today before going to sleep.",
  );
  expectIn("notification", app.recordingNotificationTitle);
  expectIn("notification", app.recordingNotificationBody);
  expectIn("notification", app.testRecordingNotificationTitle);
  expectIn("notification", app.testRecordingNotificationBody);
  for (const text of Object.values(app.onboarding)) expectIn("onboarding", text);
  expectIn(
    "recording",
    app.endSessionAvailableFrom.replace(
      "{{time}}",
      example.schedule.endSessionAvailableAt,
    ),
  );
});

test("privacy.faceBlur.enabled defaults to true", () => {
  const raw = clone();
  delete raw.privacy.faceBlur.enabled;
  assert.equal(StudyConfigSchema.parse(raw).privacy.faceBlur.enabled, true);
});

test("overreliance can be disabled (notice null)", () => {
  const raw = clone();
  raw.overreliance.enabled = false;
  raw.texts.rounds.assistedReminderIncorrectLabelsNotice = null;
  assert.deepEqual(validate(raw), []);
});

const expectInvalid = (
  name: string,
  mutate: (raw: Record<string, any>) => void,
  expectedPrefix: string,
): void => {
  test(`invalid: ${name}`, () => {
    const raw = clone();
    mutate(raw);
    const issues = validate(raw);
    assert.ok(
      issues.some((issue) => issue.startsWith(expectedPrefix)),
      `expected an issue starting with "${expectedPrefix}", got ${JSON.stringify(issues)}`,
    );
  });
};

expectInvalid(
  "duplicate activity key",
  (raw) => (raw.activities[1].key = raw.activities[0].key),
  "activities.1.key: duplicate key",
);
expectInvalid(
  "appliesTo unknown category",
  (raw) => (raw.experienceItems[0].appliesTo = ["leisure"]),
  'experienceItems.0.appliesTo.0: unknown category "leisure"',
);
expectInvalid(
  "7-minute window",
  (raw) => (raw.windowing.windowMinutes = 7),
  "windowing.windowMinutes: must divide 60 and every UTC offset",
);
expectInvalid(
  "idle close shorter than window",
  (raw) => (raw.windowing.idleCloseMinutes = 3),
  "windowing.idleCloseMinutes:",
);
expectInvalid(
  "interval not shorter than window",
  (raw) => (raw.capture.intervalMsByFormFactor.glasses = 300_000),
  "capture.intervalMsByFormFactor.glasses: must be shorter",
);
expectInvalid(
  "interval below firmware minimum",
  (raw) => (raw.capture.intervalMsByFormFactor.necklace = 500),
  "capture.intervalMsByFormFactor.necklace:",
);
expectInvalid(
  "interval below 5 s",
  (raw) => (raw.capture.intervalMsByFormFactor.necklace = 4_999),
  "capture.intervalMsByFormFactor.necklace:",
);
expectInvalid(
  "incorrect-labels notice while overreliance disabled",
  (raw) => (raw.overreliance.enabled = false),
  "texts.rounds.assistedReminderIncorrectLabelsNotice: must be null",
);
expectInvalid(
  "unsupported icon",
  (raw) => (raw.categories[0].icon = "rocket"),
  "categories.0.icon:",
);
expectInvalid(
  "scale too wide",
  (raw) => (raw.experienceItems[0].scale = { ...raw.experienceItems[0].scale, min: 0, max: 11 }),
  "experienceItems.0.scale: max - min must be <= 10",
);
expectInvalid(
  "negative scale minimum",
  (raw) => (raw.experienceItems[0].scale.min = -1),
  "experienceItems.0.scale.min:",
);
expectInvalid(
  "missing shortLabel",
  (raw) => delete raw.experienceItems[1].shortLabel,
  "experienceItems.1.shortLabel:",
);
expectInvalid(
  "interval for unknown form factor",
  (raw) => (raw.capture.intervalMsByFormFactor.wristband = 15_000),
  "capture.intervalMsByFormFactor.wristband: unknown form factor",
);
expectInvalid(
  "unknown prompt placeholder",
  (raw) => (raw.vlm.prompts.user += " {{participant_id}}"),
  'vlm.prompts.user: unknown placeholder "{{participant_id}}"',
);
expectInvalid(
  "missing required field",
  (raw) => delete raw.vlm.model,
  "vlm.model:",
);
expectInvalid(
  "unknown field (typo)",
  (raw) => (raw.overreliance.rat = 0.2),
  "overreliance:",
);
expectInvalid(
  "rate out of range",
  (raw) => (raw.overreliance.rate = 1.5),
  "overreliance.rate:",
);
expectInvalid(
  "bad time of day",
  (raw) => (raw.schedule.reconstructionOpensAt = "7pm"),
  "schedule.reconstructionOpensAt: must be HH:MM",
);
expectInvalid(
  "unknown timezone",
  (raw) => (raw.study.timezone = "Mars/Olympus"),
  "study.timezone: unknown IANA timezone",
);
expectInvalid(
  "non-https survey url",
  (raw) => (raw.surveys.final.url = "http://survey.example.org"),
  "surveys.final.url:",
);

console.log(`\n${passed} study-config schema tests passed`);
