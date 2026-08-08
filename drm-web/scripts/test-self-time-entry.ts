// Focused checks for dating the wall-clock times typed into the Self editor.
// The participant types "HH:MM" with no date, but a study day runs past local
// midnight, so the chronology decides which calendar date a time belongs to.
// Run from drm-web/:  ../server/node_modules/.bin/tsx scripts/test-self-time-entry.ts

import {
  dayTimeToEpochMs,
  formatTimeOfDay,
  nextDayKey,
  resolveTypedTimeOfDay,
} from "../src/lib/time";
import {
  selfTimeAnchor,
  type EditableActivity,
} from "../src/components/reconstruct/editor-types";

const DAY = "2026-08-07";
const NEXT = nextDayKey(DAY);
// Mirrors the server: the calendar day plus a four-hour overrun.
const DAY_END_MS = dayTimeToEpochMs(NEXT, "04:00");

const at = (time: string) => dayTimeToEpochMs(DAY, time);
const atNext = (time: string) => dayTimeToEpochMs(NEXT, time);

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

const row = (
  localId: string,
  startMs: number | null,
  endMs: number | null,
): EditableActivity => ({
  localId,
  startMs,
  endMs,
  rawLabel: "computer_or_monitor_use",
  categoryLabel: "work",
  source: "user",
  proposalActivityId: null,
  isIncorrectAnnotationInjected: false,
  workloadRating: 4,
  recoveryRating: null,
});

// --- resolveTypedTimeOfDay ---------------------------------------------------

check(
  "the first entry of the day never rolls, even at 00:30",
  resolveTypedTimeOfDay(DAY, "00:30", null, DAY_END_MS),
  at("00:30"),
);

check(
  "a time after the anchor stays on the study day",
  resolveTypedTimeOfDay(DAY, "17:00", at("16:00"), DAY_END_MS),
  at("17:00"),
);

check(
  "a time equal to the anchor stays on the study day",
  resolveTypedTimeOfDay(DAY, "16:00", at("16:00"), DAY_END_MS),
  at("16:00"),
);

check(
  "00:30 after a 23:00 anchor is dated to the next day",
  resolveTypedTimeOfDay(DAY, "00:30", at("23:00"), DAY_END_MS),
  atNext("00:30"),
);

check(
  "an out-of-order daytime entry keeps its own date instead of jumping a day",
  resolveTypedTimeOfDay(DAY, "20:00", atNext("00:30"), DAY_END_MS),
  at("20:00"),
);

check(
  "a roll that would leave the day is refused",
  resolveTypedTimeOfDay(DAY, "05:00", at("23:00"), DAY_END_MS),
  at("05:00"),
);

check(
  "the roll may land exactly on the day's upper bound",
  resolveTypedTimeOfDay(DAY, "04:00", at("23:00"), DAY_END_MS),
  atNext("04:00"),
);

check(
  "a recording that ran late widens what may be rolled into",
  resolveTypedTimeOfDay(DAY, "05:00", at("23:00"), atNext("06:00")),
  atNext("05:00"),
);

// --- selfTimeAnchor ----------------------------------------------------------

const filled = [
  row("a", at("09:00"), at("12:00")),
  row("b", at("13:00"), at("23:00")),
  row("c", null, null),
];

check(
  "a new trailing row anchors on the latest boundary entered so far",
  selfTimeAnchor(filled, 2, "startMs"),
  at("23:00"),
);

check(
  "an end time anchors on its own row's start",
  selfTimeAnchor(filled, 1, "endMs"),
  at("13:00"),
);

check(
  "an end time falls back to preceding rows while its start is empty",
  selfTimeAnchor(filled, 2, "endMs"),
  at("23:00"),
);

check(
  "the very first row has no anchor",
  selfTimeAnchor(filled, 0, "startMs"),
  null,
);

check(
  "correcting a middle row anchors only on what precedes it",
  selfTimeAnchor(filled, 1, "startMs"),
  at("12:00"),
);

check("an unknown row index has no anchor", selfTimeAnchor(filled, -1, "startMs"), null);

// --- The two together: typing one evening in order ---------------------------

const typed: { time: string; field: "startMs" | "endMs" }[] = [
  { time: "21:00", field: "startMs" },
  { time: "23:00", field: "endMs" },
  { time: "23:00", field: "startMs" },
  { time: "00:30", field: "endMs" },
];
const evening = [row("x", null, null)];
let cursor = 0;
for (const entry of typed) {
  if (entry.field === "startMs" && evening[cursor].startMs !== null) {
    evening.push(row(`x${cursor}`, null, null));
    cursor += 1;
  }
  const resolved = resolveTypedTimeOfDay(
    DAY,
    entry.time,
    selfTimeAnchor(evening, cursor, entry.field),
    DAY_END_MS,
  );
  evening[cursor] = { ...evening[cursor], [entry.field]: resolved };
}

check(
  "an evening typed in order ends after midnight, in order",
  evening.map((activity) => [
    formatTimeOfDay(activity.startMs as number),
    formatTimeOfDay(activity.endMs as number),
  ]),
  [
    ["21:00", "23:00"],
    ["23:00", "00:30"],
  ],
);
check(
  "the last activity is stored on the next calendar date",
  evening[1].endMs,
  atNext("00:30"),
);
check(
  "every span stays strictly ordered once dated",
  evening.every(
    (activity) => (activity.endMs as number) > (activity.startMs as number),
  ),
  true,
);

if (failures > 0) {
  console.error(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log("\nAll self time-entry checks passed.");
