import assert from "assert";

import {
  acceptedExpoPushTickets,
  BEDTIME_REMINDER_LEAD_MIN,
  reminderMinutesFor,
} from "../src/push";

import { studyConfig } from "../src/study-config";

// Runs under any study config (BLINKS_STUDY_CONFIG). Concrete expectations for
// the two tracked configs, the general rule for everything else.
const bedtime = studyConfig.reminders.bedtime;
const hm = (time: string): number => Number(time.slice(0, 2)) * 60 + Number(time.slice(3, 5));
assert.strictEqual(BEDTIME_REMINDER_LEAD_MIN, bedtime.leadMinutes);

const isPaper =
  bedtime.leadMinutes === 30 && bedtime.latestAt === "23:50" && bedtime.afterMidnightCutoff === "12:00";
const isTestStudy =
  bedtime.leadMinutes === 45 && bedtime.latestAt === "23:30" &&
  bedtime.afterMidnightCutoff === "10:00" && bedtime.defaultBedtime === "23:00";
if (isPaper) {
  assert.strictEqual(reminderMinutesFor("22:00"), 21 * 60 + 30);
  assert.strictEqual(reminderMinutesFor("12:00"), 11 * 60 + 30);
  assert.strictEqual(reminderMinutesFor("23:59"), 23 * 60 + 29);
  // After-midnight bedtimes retain the study-day last-chance behavior.
  assert.strictEqual(reminderMinutesFor("11:59"), 23 * 60 + 50);
  assert.strictEqual(reminderMinutesFor("00:30"), 23 * 60 + 50);
}
if (isTestStudy) {
  // config/study.test.yaml: lead 45, latest 23:30, cutoff 10:00, default 23:00
  assert.strictEqual(reminderMinutesFor("22:00"), 21 * 60 + 15);
  assert.strictEqual(reminderMinutesFor("23:59"), 23 * 60 + 14);
  assert.strictEqual(reminderMinutesFor("10:00"), 9 * 60 + 15);
  assert.strictEqual(reminderMinutesFor("09:59"), 23 * 60 + 30);
  assert.strictEqual(reminderMinutesFor(null), 22 * 60 + 15);
}
// general rule for any config
for (const time of ["00:30", "09:00", "11:59", "12:00", "18:00", "22:00", "23:59"]) {
  const expected =
    hm(time) < hm(bedtime.afterMidnightCutoff)
      ? hm(bedtime.latestAt)
      : Math.min(hm(time) - bedtime.leadMinutes, hm(bedtime.latestAt));
  assert.strictEqual(reminderMinutesFor(time), expected, time);
}
console.log(`push expectations: ${isPaper ? "paper" : isTestStudy ? "study.test.yaml" : "generic"} config`);

assert.deepStrictEqual(
  acceptedExpoPushTickets(
    {
      data: [
        { status: "ok", id: "ticket-1" },
        {
          status: "error",
          message: "Device is not registered",
          details: { error: "DeviceNotRegistered" },
        },
      ],
    },
    2,
  ),
  [true, false],
);
assert.deepStrictEqual(acceptedExpoPushTickets({ data: [] }, 1), [false]);
assert.deepStrictEqual(acceptedExpoPushTickets(null, 2), [false, false]);

console.log("Push reminder tests passed.");
