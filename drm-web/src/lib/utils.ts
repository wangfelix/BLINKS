import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

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
