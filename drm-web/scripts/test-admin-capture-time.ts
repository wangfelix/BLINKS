// Admin photo browser capture times in the study timezone.
// Run from drm-web/:  npx tsx scripts/test-admin-capture-time.ts

import {
  CAPTURE_TIME_PLACEHOLDER,
  captureTimeFormatter,
} from "@/lib/admin-capture-time";

let failures = 0;
const check = (name: string, actual: unknown, expected: unknown) => {
  if (JSON.stringify(actual) === JSON.stringify(expected)) {
    console.log(`ok   ${name}`);
  } else {
    failures += 1;
    console.error(
      `FAIL ${name}\n  expected ${JSON.stringify(expected)}\n  actual   ${JSON.stringify(actual)}`,
    );
  }
};

const capture = Date.UTC(2026, 9, 17, 7, 0, 0); // 09:00 in Berlin (CEST)

check(
  "Europe/Berlin",
  captureTimeFormatter("Europe/Berlin").format(capture),
  "17 Oct 2026, 09:00:00",
);
check(
  "America/New_York (independent of the machine zone)",
  captureTimeFormatter("America/New_York").format(capture),
  "17 Oct 2026, 03:00:00",
);
check(
  "config not loaded or failed: placeholder, no guessed zone",
  captureTimeFormatter(undefined).format(capture),
  CAPTURE_TIME_PLACEHOLDER,
);

if (failures > 0) {
  console.error(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log("\nAll admin capture-time checks passed.");
