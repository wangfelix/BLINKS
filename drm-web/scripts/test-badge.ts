// Focused checks for the Badge pill variant: fixed height and border are
// dropped, className sets the border, colors and radius, and the tone, size
// and numeric variants set colors, padding, radius and font.
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

/** Class list of the rendered root element, with HTML entities decoded. */
const classesOf = (props: Parameters<typeof Badge>[0]) => {
  const html = renderToStaticMarkup(createElement(Badge, props, "x"));
  return (html.match(/class="([^"]*)"/)?.[1] ?? "")
    .replaceAll("&gt;", ">")
    .replaceAll("&amp;", "&")
    .split(" ");
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

const has = (classes: string[], wanted: string[], dropped: string[] = []) =>
  wanted.every((c) => classes.includes(c)) &&
  !dropped.some((c) => classes.includes(c));

check(
  "default badge has no pill tone, size or numeric classes",
  has(
    classesOf({}),
    ["h-5", "text-xs", "rounded-4xl", "px-2"],
    ["tabular-nums", "h-auto"],
  ),
);

check(
  "preview tone sets amber border, colors, padding and weight",
  has(
    classesOf({ variant: "pill", tone: "preview" }),
    [
      "border",
      "border-amber-300",
      "bg-amber-100",
      "text-amber-900",
      "px-3",
      "py-1",
      "font-semibold",
      "text-xs",
    ],
    ["border-0", "border-transparent", "px-2", "py-0.5", "font-medium"],
  ),
);
check(
  "alert and hint tones keep the default padding and radius",
  has(
    classesOf({ variant: "pill", tone: "alert", size: "3xs" }),
    [
      "bg-destructive",
      "text-white",
      "font-semibold",
      "text-3xs",
      "px-2",
      "py-0.5",
      "rounded-4xl",
    ],
    ["text-xs", "font-medium"],
  ) &&
    has(
      classesOf({ variant: "pill", tone: "hint", size: "3xs" }),
      ["bg-amber-500", "text-amber-950", "font-semibold", "text-3xs"],
      ["text-xs"],
    ),
);
check(
  "overlay tone sets a dark chip with a small radius",
  has(
    classesOf({ variant: "pill", tone: "overlay", size: "4xs" }),
    [
      "rounded-md",
      "border",
      "border-white/15",
      "bg-black/70",
      "text-white",
      "px-2",
      "py-1",
      "text-4xs",
    ],
    ["rounded-4xl", "border-0", "py-0.5", "text-xs", "tabular-nums"],
  ),
);
check(
  "overlay-strong tone with size sm and numeric",
  has(
    classesOf({
      variant: "pill",
      tone: "overlay-strong",
      size: "sm",
      numeric: true,
    }),
    [
      "border",
      "border-white/20",
      "bg-black/75",
      "text-white",
      "px-3",
      "py-1.5",
      "text-sm",
      "tabular-nums",
    ],
    ["border-0", "text-xs"],
  ),
);
check(
  "note tone sets a muted translucent background",
  has(
    classesOf({ variant: "pill", tone: "note" }),
    ["bg-background/95", "text-muted-foreground", "px-3", "py-1.5"],
    ["px-2", "py-0.5"],
  ),
);
check(
  "selection and counter tones use a large radius",
  has(
    classesOf({ variant: "pill", tone: "selection", numeric: true }),
    [
      "rounded-lg",
      "bg-foreground",
      "text-background",
      "px-2.5",
      "py-1",
      "tabular-nums",
    ],
    ["rounded-4xl"],
  ) &&
    has(
      classesOf({ variant: "pill", tone: "counter" }),
      [
        "gap-1.5",
        "rounded-lg",
        "border",
        "border-border",
        "bg-background",
        "px-2.5",
        "py-1.5",
        "[&>svg]:size-3.5!",
      ],
      ["gap-1", "[&>svg]:size-3!", "border-0"],
    ),
);
check(
  "marker tone sets an uppercase bold chip with a ring",
  has(
    classesOf({ variant: "pill", tone: "marker", size: "2xs" }),
    [
      "min-h-7",
      "rounded-lg",
      "bg-blue-600",
      "px-3",
      "py-1.5",
      "text-2xs",
      "font-bold",
      "tracking-wider",
      "text-white",
      "uppercase",
      "shadow-lg",
      "ring-2",
      "ring-white/90",
    ],
    ["font-medium", "text-xs", "rounded-4xl"],
  ),
);
check(
  "className adds positioning next to tone and size",
  has(
    classesOf({
      variant: "pill",
      tone: "overlay",
      size: "3xs",
      className: "pointer-events-none absolute bottom-2 left-2 z-30",
    }),
    [
      "pointer-events-none",
      "absolute",
      "bottom-2",
      "left-2",
      "z-30",
      "bg-black/70",
      "text-3xs",
    ],
  ),
);

if (failures > 0) {
  console.error(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log("\nAll Badge checks passed.");
