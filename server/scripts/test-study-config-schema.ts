// Tests for the study-config schema.
//   npx tsx scripts/test-study-config-schema.ts
//
// 1. config/study-config.schema.json is fresh (generated from the zod schema).
// 2. config/study.example.yaml validates (shape + cross-field checks).
// 3. The example matches the default study values kept as literals here
//    (server constants, push texts).
//    The prompt golden test lives in server/vlm/test_study_example_prompts.py.
// 4. Representative invalid configs fail with `path: reason`.

import assert from "assert/strict";
import fs from "fs";
import path from "path";

import { parse as parseYaml } from "yaml";

import {
  StudyConfigSchema,
  studyConfigCrossCheckIssues,
  type StudyConfig,
} from "@/study-config/schema";
import {
  renderStudyConfigJsonSchema,
  STUDY_CONFIG_SCHEMA_PATH,
} from "@scripts/generate-study-config-schema";

const REPO_ROOT = path.join(__dirname, "..", "..");
const EXAMPLE_PATH = path.join(REPO_ROOT, "config", "study.example.yaml");

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

// Default study values as literals. This file only reads study.example.yaml
// and does not import the runtime modules, so it runs under any
// BLINKS_STUDY_CONFIG.
const PAPER_ACTIVITY_KEYS = [
  "computer_or_monitor_use",
  "watching_video",
  "paper_reading_writing",
  "handheld_device_use",
  "remote_meeting",
  "phone_call",
  "in_person_interaction",
  "tools_or_materials",
  "eating_drinking",
  "food_preparation",
  "cleaning_household",
  "assisting_person_animal",
  "personal_care",
  "walking_or_movement",
  "no_task_engagement",
  "other",
  "unclear",
];
const PAPER_OVERRELIANCE_RATE = 0.1;
const PAPER_OVERRELIANCE_MIN_CONFIDENCE = 0.8;

test("example = today's server constants", () => {
  assert.deepEqual(
    example.activities.map((a) => a.key),
    PAPER_ACTIVITY_KEYS,
  );
  assert.deepEqual(
    example.categories.map((c) => c.key),
    ["work", "break", "other"],
  );
  assert.equal(example.overreliance.enabled, true);
  assert.equal(example.overreliance.rate, PAPER_OVERRELIANCE_RATE);
  assert.equal(
    example.overreliance.minConfidence,
    PAPER_OVERRELIANCE_MIN_CONFIDENCE,
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

  // Default bedtime reminder and face-blur values.
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
});

// drm-web and the app read the study config at runtime, so their texts are not
// compared here; the app's offline fallback texts are checked by
// blinks-edge-app/scripts/test-study-config.ts.
test("example = frozen paper push texts", () => {
  // Default push texts:
  assert.equal(example.texts.push.bedtimeTitle, "Before you go to bed");
  assert.equal(
    example.texts.push.bedtimeBody,
    "Please open the study website and reconstruct today before going to sleep.",
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
  "unknown top-level section",
  (raw) => (raw.extraSection = {}),
  ': Unrecognized key: "extraSection"',
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
