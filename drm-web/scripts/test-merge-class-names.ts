// Focused checks for mergeClassNames with the app's custom theme tokens.
// Run from drm-web/:  npx tsx scripts/test-merge-class-names.ts

import { mergeClassNames } from "@/lib/utils";

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

check(
  "tracking-label replaces an earlier tracking class",
  mergeClassNames("tracking-widest", "tracking-label"),
  "tracking-label",
);
check(
  "a later tracking class replaces tracking-label",
  mergeClassNames("tracking-label", "tracking-tight"),
  "tracking-tight",
);
check(
  "text-2xs replaces an earlier font size",
  mergeClassNames("text-sm", "text-2xs"),
  "text-2xs",
);
check(
  "text-3xs and text-4xs are font sizes",
  mergeClassNames("text-3xs", "text-4xs"),
  "text-4xs",
);
check(
  "custom font sizes do not replace text colors",
  mergeClassNames("text-muted-foreground", "text-3xs"),
  "text-muted-foreground text-3xs",
);
check(
  "text colors still replace each other",
  mergeClassNames("text-muted-foreground", "text-destructive"),
  "text-destructive",
);
check(
  "responsive variants stay separate",
  mergeClassNames("text-2xs", "sm:text-sm"),
  "text-2xs sm:text-sm",
);

if (failures > 0) {
  console.error(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log("\nAll mergeClassNames checks passed.");
