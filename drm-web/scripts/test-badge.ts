// Focused checks for the Badge pill variant: fixed height and border are
// dropped, and className sets the border, colors and radius.
// Run from drm-web/:  npx tsx scripts/test-badge.ts

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { Badge } from "@/components/ui/badge";

let failures = 0;
const check = (name: string, actual: boolean) => {
  if (actual) {
    console.log(`ok   ${name}`);
  } else {
    failures += 1;
    console.error(`FAIL ${name}`);
  }
};

/** Class list of the rendered root element. */
const classesOf = (props: Parameters<typeof Badge>[0]) => {
  const html = renderToStaticMarkup(createElement(Badge, props, "x"));
  return (html.match(/class="([^"]*)"/)?.[1] ?? "").split(" ");
};

const pill = classesOf({ variant: "pill" });
check(
  "pill drops the fixed height",
  pill.includes("h-auto") && !pill.includes("h-5"),
);
check(
  "pill drops the border",
  pill.includes("border-0") && !pill.includes("border"),
);

const bordered = classesOf({
  variant: "pill",
  className: "border border-amber-300 rounded-lg px-3 py-1 text-3xs",
});
check(
  "className restores a colored border",
  bordered.includes("border") &&
    bordered.includes("border-amber-300") &&
    !bordered.includes("border-0") &&
    !bordered.includes("border-transparent"),
);
check(
  "className replaces radius, padding and font size",
  ["rounded-lg", "px-3", "py-1", "text-3xs"].every((c) =>
    bordered.includes(c),
  ) &&
    !["rounded-4xl", "px-2", "py-0.5", "text-xs"].some((c) =>
      bordered.includes(c),
    ),
);

if (failures > 0) {
  console.error(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log("\nAll Badge checks passed.");
