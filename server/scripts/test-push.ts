import assert from "assert";

import {
  acceptedExpoPushTickets,
  BEDTIME_REMINDER_LEAD_MIN,
  reminderMinutesFor,
} from "../src/push";

assert.strictEqual(BEDTIME_REMINDER_LEAD_MIN, 30);
assert.strictEqual(reminderMinutesFor("22:00"), 21 * 60 + 30);
assert.strictEqual(reminderMinutesFor("12:00"), 11 * 60 + 30);
assert.strictEqual(reminderMinutesFor("23:59"), 23 * 60 + 29);

// After-midnight bedtimes retain the study-day last-chance behavior.
assert.strictEqual(reminderMinutesFor("11:59"), 23 * 60 + 50);
assert.strictEqual(reminderMinutesFor("00:30"), 23 * 60 + 50);

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
