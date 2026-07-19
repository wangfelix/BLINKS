// Unit test for the experience-rating submit gate: a missing rating blocks
// readiness via hasAllExperienceRatings but adds NO row message (the scale
// highlights itself in place).
// Run from drm-web/:  ../server/node_modules/.bin/tsx scripts/test-experience-ratings.ts

import type { CategoryLabel, ExperienceRating } from "../src/lib/api-types";
import {
  computeRowIssues,
  hasAllExperienceRatings,
  type EditableActivity,
} from "../src/components/reconstruct/editor-types";

const makeRow = (
  localId: string,
  categoryLabel: CategoryLabel | null,
  workloadRating: ExperienceRating | null = null,
  recoveryRating: ExperienceRating | null = null,
): EditableActivity => ({
  localId,
  startMs: 0,
  endMs: 1000,
  rawLabel: "labelled",
  categoryLabel,
  source: "user",
  vlmRawLabel: null,
  vlmCategory: null,
  workloadRating,
  recoveryRating,
});

let failures = 0;
const check = (name: string, condition: boolean) => {
  if (condition) {
    console.log(`ok   ${name}`);
  } else {
    failures += 1;
    console.error(`FAIL ${name}`);
  }
};

check(
  "unrated work activity blocks readiness",
  !hasAllExperienceRatings([makeRow("a", "work")]),
);
check(
  "unrated break activity blocks readiness",
  !hasAllExperienceRatings([makeRow("a", "break")]),
);
check(
  "'other' needs no rating",
  hasAllExperienceRatings([makeRow("a", "other")]),
);
check(
  "rating on the matching field satisfies the gate (incl. the 7 end)",
  hasAllExperienceRatings([
    makeRow("a", "work", 7, null),
    makeRow("b", "break", null, 1),
  ]),
);
check(
  "rating on the WRONG field does not satisfy the gate",
  !hasAllExperienceRatings([makeRow("a", "work", null, 5)]),
);
check(
  "a missing rating produces no row message",
  computeRowIssues([makeRow("a", "work")], false).length === 0,
);
check(
  "other completeness issues still produce messages",
  computeRowIssues([makeRow("a", null)], false).some((issue) =>
    issue.message.includes("Choose a category."),
  ),
);

if (failures > 0) {
  console.error(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log("\nAll experience-rating checks passed.");
