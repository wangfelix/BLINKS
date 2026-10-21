// The web model with alternative study configs:
//   1. config/study.test.yaml as served (5 labels, 2 categories, items on 0-4
//      and 1-5 scales with an optional one, 10-minute window, other surveys);
//   2. another timezone/locale with a 15-minute window (DST day lengths,
//      wall-clock conversion, typed times after midnight);
//   3. the admin payload (surveys: null).
// Run from drm-web/:  npx tsx scripts/test-alternative-configs.ts

import type { EditableActivity } from "@/components/reconstruct/editor-types";
import {
  hasAllExperienceRatings,
  mergeWithNextActivity,
} from "@/components/reconstruct/editor-types";
import { experienceRatingSummaryLabel } from "@/components/reconstruct/experience-rating-scale";
import {
  buildWindowSlots,
  slotStartOf,
} from "@/components/reconstruct/time-slots";
import type { Frame } from "@/lib/api-types";
import { activityDisplayLabel, activityItems } from "@/lib/activity-vocabulary";
import { categoryItems } from "@/lib/category-vocabulary";
import { surveyUrlForParticipant } from "@/lib/study-config";
import {
  emptyRatings,
  experienceItemsForCategory,
  getStudyConfig,
  installStudyConfig,
  thumbnailsPerActivity,
  windowMinuteAdjective,
  windowMs,
} from "@/lib/study-config-store";
import {
  dayTimeToEpochMs,
  formatTimeOfDay,
  nextDayKey,
  resolveTypedTimeOfDay,
} from "@/lib/time";
import { testStudyConfig } from "@scripts/fixtures/study-config";

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

const daySlotCount = (day: string) =>
  buildWindowSlots(
    {
      startMs: dayTimeToEpochMs(day, "00:00"),
      endMs: dayTimeToEpochMs(nextDayKey(day), "00:00"),
    },
    [],
    [],
  ).length;

// --- 1. config/study.test.yaml ----------------------------------------------

installStudyConfig(testStudyConfig());
const DAY = "2026-08-06";
const at = (time: string) => dayTimeToEpochMs(DAY, time);

check("test study: 10-minute window", windowMs(), 10 * 60_000);
check("test study: window adjective", windowMinuteAdjective(), "ten-minute");
check("test study: 3 thumbnails per activity", thumbnailsPerActivity(), 3);
check(
  "test study: 5 labels, all from the config ([TEST])",
  activityItems().map((item) => item.label.startsWith("[TEST] ")),
  [true, true, true, true, true],
);
check(
  "test study: paper labels are unknown",
  activityDisplayLabel("computer_or_monitor_use"),
  null,
);
check(
  "test study: 2 categories with config icons",
  categoryItems().map((item) => [item.value, item.icon]),
  [
    ["work", "briefcase"],
    ["break", "coffee"],
  ],
);
check(
  "test study: items per category",
  [
    experienceItemsForCategory("work").map((item) => item.key),
    experienceItemsForCategory("break").map((item) => item.key),
  ],
  [["focus", "stress"], ["enjoyment"]],
);
check("test study: empty ratings cover every item", emptyRatings(), {
  focus: null,
  stress: null,
  enjoyment: null,
});
check(
  "test study: a 0-4 scale summarises 0 as 0/4",
  experienceRatingSummaryLabel(experienceItemsForCategory("work")[0], 0),
  "Focus 0/4",
);

const row = (
  localId: string,
  start: string,
  end: string,
  categoryLabel: string,
  ratings: Record<string, number | null>,
): EditableActivity => ({
  localId,
  startMs: at(start),
  endMs: at(end),
  rawLabel: "screen_work",
  categoryLabel,
  source: "vlm",
  proposalActivityId: null,
  isIncorrectAnnotationInjected: false,
  ratings: { focus: null, stress: null, enjoyment: null, ...ratings },
});
check(
  "test study: submit gate (0 is a valid answer, optional item not required)",
  [
    hasAllExperienceRatings([
      row("a", "09:00", "09:30", "work", { focus: 0, stress: 1 }),
    ]),
    hasAllExperienceRatings([row("a", "09:00", "09:30", "work", { focus: 0 })]),
    hasAllExperienceRatings([row("a", "09:00", "09:30", "break", {})]),
  ],
  [true, false, true],
);
check(
  "test study: merge keeps agreeing items of the final category only",
  mergeWithNextActivity(
    [
      // focus is a leftover from before the row became a break
      row("a", "09:00", "09:30", "break", { enjoyment: 3, focus: 2 }),
      row("b", "09:30", "10:00", "break", { enjoyment: 3 }),
    ],
    "a",
  ).rows[0].ratings,
  { focus: null, stress: null, enjoyment: 3 },
);

check("test study: ordinary day has 144 slots", daySlotCount(DAY), 144);
check(
  "test study: DST end (25 h) has 150 slots",
  daySlotCount("2026-10-25"),
  150,
);
check(
  "test study: DST start (23 h) has 138 slots",
  daySlotCount("2027-03-28"),
  138,
);
const frame = (time: string, frameIndex: number): Frame =>
  ({
    participant: "p01",
    device: "CAM",
    session: 1,
    frameIndex,
    captureEpochMs: at(time),
    imageUrl: `/frames/${frameIndex}`,
    deletedAt: null,
  }) as unknown as Frame;
check(
  "test study: frames group into their 10-minute slot",
  buildWindowSlots(
    { startMs: at("09:00"), endMs: at("09:30") },
    [frame("09:01", 1), frame("09:09", 2), frame("09:10", 3)],
    [],
  ).map((slot) => slot.frames.length),
  [2, 1, 0],
);
check(
  "test study: survey links use its parameter name",
  [
    surveyUrlForParticipant("onboarding", "p01"),
    surveyUrlForParticipant("final", "p01"),
  ],
  [
    "https://survey.example.org/test/onboarding?pid=p01",
    "https://survey.example.org/test/final?pid=p01",
  ],
);
check(
  "test study: no incorrect-labels notice",
  getStudyConfig().texts.rounds.assistedReminderIncorrectLabelsNotice,
  null,
);

// --- 2. Other timezone and locale, 15-minute window --------------------------

installStudyConfig({
  ...testStudyConfig(),
  study: { timezone: "America/New_York" },
  ui: { locale: "en-US", thumbnailsPerActivity: 4 },
  windowing: { windowMinutes: 15 },
});
check(
  "New York: 09:00 local is 13:00 UTC in summer",
  dayTimeToEpochMs(DAY, "09:00"),
  Date.UTC(2026, 7, 6, 13, 0),
);
check(
  "New York: formatted in the study zone, not the machine zone",
  formatTimeOfDay(Date.UTC(2026, 7, 6, 13, 5)),
  "09:05",
);
check("New York: 15-minute window", windowMs(), 15 * 60_000);
check(
  "New York: window adjective above twelve uses digits",
  windowMinuteAdjective(),
  "15-minute",
);
check("New York: ordinary day has 96 slots", daySlotCount(DAY), 96);
check(
  "New York: US DST end (2026-11-01, 25 h) has 100 slots",
  daySlotCount("2026-11-01"),
  100,
);
check(
  "New York: slots start on the local quarter hour",
  slotStartOf(dayTimeToEpochMs(DAY, "09:07")),
  dayTimeToEpochMs(DAY, "09:00"),
);
check(
  "New York: a typed 00:30 after 23:00 rolls to the next date",
  resolveTypedTimeOfDay(
    DAY,
    "00:30",
    dayTimeToEpochMs(DAY, "23:00"),
    dayTimeToEpochMs(nextDayKey(DAY), "04:00"),
  ),
  dayTimeToEpochMs(nextDayKey(DAY), "00:30"),
);

// --- 3. Admin payload ---------------------------------------------------------

installStudyConfig({ ...testStudyConfig(), surveys: null });
check(
  "admin payload (surveys null): no survey link",
  surveyUrlForParticipant("final", "p01"),
  null,
);

if (failures > 0) {
  console.error(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log("\nAll alternative-config checks passed.");
