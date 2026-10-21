// The editor model with the default study config and an alternative study
// (5 labels, 2 categories, 3 items, 10-minute window).
// Run from drm-web/:  npx tsx scripts/test-study-config.ts

import type { Activity } from "@/lib/api-types";
import {
  fromServerActivity,
  hasAllExperienceRatings,
  mergeWithNextActivity,
  type EditableActivity,
} from "@/components/reconstruct/editor-types";
import { buildWindowSlots } from "@/components/reconstruct/time-slots";
import { experienceRatingSummaryLabel } from "@/components/reconstruct/experience-rating-scale";
import { activityDisplayLabel, activityItems } from "@/lib/activity-vocabulary";
import { categoryDisplayLabel, categoryItems } from "@/lib/category-vocabulary";
import {
  experienceItemsForCategory,
  installStudyConfig,
  thumbnailsPerActivity,
  windowMinuteAdjective,
  windowMs,
} from "@/lib/study-config-store";
import { surveyUrlForParticipant } from "@/lib/study-config";
import { dayTimeToEpochMs, formatTimeSpan } from "@/lib/time";
import {
  alternativeStudyConfig,
  defaultStudyConfig,
} from "@scripts/fixtures/study-config";

let failures = 0;
const check = (name: string, actual: unknown, expected: unknown) => {
  const actualJson = JSON.stringify(actual);
  const expectedJson = JSON.stringify(expected);
  if (actualJson === expectedJson) {
    console.log(`ok   ${name}`);
  } else {
    failures += 1;
    console.error(
      `FAIL ${name}\n  expected ${expectedJson}\n  actual   ${actualJson}`,
    );
  }
};

const DAY = "2026-08-06";
const at = (time: string) => dayTimeToEpochMs(DAY, time);

// --- Default config (study.example.yaml) ------------------------------------

installStudyConfig(defaultStudyConfig());

check("default window is 5 minutes", windowMs(), 5 * 60 * 1000);
check("default window adjective", windowMinuteAdjective(), "five-minute");
check("default thumbnails per activity", thumbnailsPerActivity(), 5);
check("default has the 17 activities", activityItems().length, 17);
check(
  "default activity order and labels",
  [activityItems()[0], activityItems()[16]],
  [
    { value: "computer_or_monitor_use", label: "Computer or monitor use" },
    { value: "unclear", label: "Unclear / cannot determine" },
  ],
);
check(
  "default categories, labels and icons",
  categoryItems().map((item) => [item.value, item.label, item.icon]),
  [
    ["work", "Work", "briefcase"],
    ["break", "Break", "pause"],
    ["other", "Other", "ellipsis"],
  ],
);
check(
  "default rating summaries",
  [
    experienceRatingSummaryLabel(experienceItemsForCategory("work")[0], 4),
    experienceRatingSummaryLabel(experienceItemsForCategory("break")[0], 2),
  ],
  ["Mental demand 4/7", "Recovery 2/7"],
);
check(
  "'other' has no experience item",
  experienceItemsForCategory("other").length,
  0,
);
check(
  "default time formatting (en-GB, Europe/Berlin)",
  formatTimeSpan(at("09:05"), at("17:30")),
  "09:05–17:30",
);
check(
  "survey links append the configured participant parameter",
  [
    surveyUrlForParticipant("onboarding", "p01"),
    surveyUrlForParticipant("final", "p01"),
  ],
  [
    "https://survey.example.org/index.php/000000?participant_id=p01",
    "https://survey.example.org/index.php/111111?participantId=p01",
  ],
);

// --- Alternative study -------------------------------------------------------

installStudyConfig(alternativeStudyConfig());

check("alternative window is 10 minutes", windowMs(), 10 * 60 * 1000);
check("alternative window adjective", windowMinuteAdjective(), "ten-minute");
check(
  "an hour on the alternative grid has six slots",
  buildWindowSlots({ startMs: at("09:00"), endMs: at("10:00") }, [], []).map(
    (slot) => (slot.endMs - slot.startMs) / 60_000,
  ),
  [10, 10, 10, 10, 10, 10],
);
check(
  "alternative labels",
  [
    activityDisplayLabel("self_study"),
    activityDisplayLabel("computer_or_monitor_use"),
  ],
  ["Self-study", null],
);
check("alternative category label", categoryDisplayLabel("leisure"), "Leisure");
check(
  "several items per category, in config order",
  [
    experienceItemsForCategory("study").map((item) => item.key),
    experienceItemsForCategory("leisure").map((item) => item.key),
  ],
  [
    ["focus", "enjoyment"],
    ["enjoyment", "fatigue"],
  ],
);

const serverActivity = (overrides: Partial<Activity>): Activity => ({
  id: 1,
  position: 0,
  startMs: at("09:00"),
  endMs: at("09:30"),
  rawLabel: "lecture",
  categoryLabel: "study",
  source: "vlm",
  proposalActivityId: 1,
  ratings: { focus: null, enjoyment: null, fatigue: null },
  ...overrides,
});
check(
  "server rows: unknown keys (an older study's labels) are not preselected",
  (() => {
    const row = fromServerActivity(
      serverActivity({ rawLabel: "phone_call", categoryLabel: "work" }),
    );
    return [row.rawLabel, row.categoryLabel];
  })(),
  [null, null],
);

const row = (
  localId: string,
  start: string,
  end: string,
  overrides: Partial<EditableActivity> = {},
): EditableActivity => ({
  ...fromServerActivity(serverActivity({ startMs: at(start), endMs: at(end) })),
  localId,
  ...overrides,
});

check(
  "required items of the final category gate submit; optional ones do not",
  [
    hasAllExperienceRatings([row("a", "09:00", "09:30")]),
    hasAllExperienceRatings([
      row("a", "09:00", "09:30", {
        ratings: { focus: 3, enjoyment: null, fatigue: null },
      }),
    ]),
    hasAllExperienceRatings([
      row("a", "09:00", "09:30", {
        categoryLabel: "leisure",
        ratings: { focus: 3, enjoyment: 8, fatigue: null },
      }),
    ]),
  ],
  [false, true, false],
);

const merged = mergeWithNextActivity(
  [
    row("a", "09:00", "09:30", {
      ratings: { focus: 4, enjoyment: 6, fatigue: 2 },
    }),
    row("b", "09:30", "10:00", {
      ratings: { focus: 4, enjoyment: 9, fatigue: 2 },
    }),
  ],
  "a",
);
check(
  "merge keeps agreeing items of the surviving category only",
  [merged.rows[0].ratings, merged.clearedRating],
  [{ focus: 4, enjoyment: null, fatigue: null }, true],
);

if (failures > 0) {
  console.error(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log("\nAll study-config checks passed.");
