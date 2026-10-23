import { clsx, type ClassValue } from "clsx";
import { extendTailwindMerge } from "tailwind-merge";

/**
 * tailwind-merge configured with the theme tokens from `globals.css`, so a
 * later `tracking-label` or `text-2xs` replaces an earlier class of the same
 * group instead of being kept next to it.
 */
const twMerge = extendTailwindMerge({
  extend: {
    theme: {
      text: ["2xs", "3xs", "4xs"],
      tracking: ["label"],
    },
  },
});

/**
 * Combines class names (strings, conditionals, arrays) into one string and
 * resolves conflicting Tailwind classes — the later class wins, so
 * `mergeClassNames("p-2", isLarge && "p-4")` yields `"p-4"` when isLarge.
 */
export function mergeClassNames(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

/**
 * Alias kept ONLY for the generated shadcn components under
 * `src/components/ui/` (and anything `npx shadcn add` creates later), which
 * import this exact name. App code should import `mergeClassNames`.
 */
export const cn = mergeClassNames;
