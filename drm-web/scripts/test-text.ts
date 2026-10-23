// Focused checks for the Text component: rendered element, role, tone and
// weight classes, and className overrides.
// Run from drm-web/:  npx tsx scripts/test-text.ts

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { Text } from "@/components/layout/text";

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

/** Tag name and sorted class list of the rendered root element. */
const render = (props: Parameters<typeof Text>[0]) => {
  const html = renderToStaticMarkup(createElement(Text, props, "x"));
  const tag = html.match(/^<([a-z0-9]+)/)?.[1];
  const classes = html.match(/class="([^"]*)"/)?.[1] ?? "";
  return { tag, classes: classes.split(" ").filter(Boolean).sort() };
};

check("body copy is the default role", render({}), {
  tag: "p",
  classes: ["text-foreground", "text-sm"],
});
check("muted tone", render({ tone: "muted" }), {
  tag: "p",
  classes: ["text-muted-foreground", "text-sm"],
});
check("destructive tone", render({ tone: "destructive" }), {
  tag: "p",
  classes: ["text-destructive", "text-sm"],
});
check("caption is muted by default", render({ variant: "caption" }), {
  tag: "p",
  classes: ["text-muted-foreground", "text-xs"],
});
check("eyebrow", render({ variant: "eyebrow" }), {
  tag: "p",
  classes: [
    "font-medium",
    "text-muted-foreground",
    "text-xs",
    "tracking-widest",
  ],
});
check("inherit adds no classes", render({ variant: "inherit" }), {
  tag: "p",
  classes: [],
});
check(
  "title renders as the given heading and keeps the parent color",
  render({ as: "h1", variant: "title" }),
  { tag: "h1", classes: ["font-semibold", "text-2xl", "tracking-tight"] },
);
check(
  "weight replaces the role's weight",
  render({ variant: "label", weight: "semibold" }),
  { tag: "p", classes: ["font-semibold", "text-sm"] },
);
check("inherit tone drops the role's color", render({ tone: "inherit" }), {
  tag: "p",
  classes: ["text-sm"],
});
check(
  "className overrides a custom font size",
  render({ variant: "caption", className: "text-3xs" }),
  { tag: "p", classes: ["text-3xs", "text-muted-foreground"] },
);
check(
  "className overrides the tracking with a custom token",
  render({ variant: "eyebrow", className: "tracking-label" }),
  {
    tag: "p",
    classes: [
      "font-medium",
      "text-muted-foreground",
      "text-xs",
      "tracking-label",
    ],
  },
);
check(
  "label element forwards htmlFor",
  renderToStaticMarkup(
    createElement(Text<"label">, { as: "label", htmlFor: "field" }, "x"),
  ).includes('for="field"'),
  true,
);

if (failures > 0) {
  console.error(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log("\nAll Text checks passed.");
