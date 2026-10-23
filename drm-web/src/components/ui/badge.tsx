import { mergeProps } from "@base-ui/react/merge-props";
import { useRender } from "@base-ui/react/use-render";
import { cva, type VariantProps } from "class-variance-authority";

import { cn } from "@/lib/utils";

const badgeVariants = cva(
  "group/badge inline-flex h-5 w-fit shrink-0 items-center justify-center gap-1 overflow-hidden rounded-4xl border border-transparent px-2 py-0.5 text-xs font-medium whitespace-nowrap transition-all focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 has-data-[icon=inline-end]:pr-1.5 has-data-[icon=inline-start]:pl-1.5 aria-invalid:border-destructive aria-invalid:ring-destructive/20 [&>svg]:pointer-events-none [&>svg]:size-3!",
  {
    variants: {
      variant: {
        default: "bg-primary text-primary-foreground [a]:hover:bg-primary/80",
        secondary:
          "bg-secondary text-secondary-foreground [a]:hover:bg-secondary/80",
        destructive:
          "bg-destructive/10 text-destructive focus-visible:ring-destructive/20 [a]:hover:bg-destructive/20",
        outline:
          "border-border text-foreground [a]:hover:bg-muted [a]:hover:text-muted-foreground",
        ghost: "hover:bg-muted hover:text-muted-foreground",
        link: "text-primary underline-offset-4 hover:underline",
        /**
         * Pill for status labels, counters and image overlay chips. Drops the
         * fixed height and the border so padding sets the size; `tone`,
         * `size` and `numeric` style it.
         */
        pill: "h-auto border-0",
      },
      /**
       * Pill styles by role: colors, border, corner radius, padding and font
       * weight. No default, so other variants are unaffected.
       */
      tone: {
        /** Developer preview label in a page header. */
        preview:
          "border border-amber-300 bg-amber-100 px-3 py-1 font-semibold text-amber-900",
        /** Inline alert inside a button, e.g. unassigned images. */
        alert: "bg-destructive font-semibold text-white",
        /** Inline suggestion inside a button, e.g. a likely merge. */
        hint: "bg-amber-500 font-semibold text-amber-950",
        /** Small dark chip over an image, e.g. a capture time or count. */
        overlay:
          "rounded-md border border-white/15 bg-black/70 px-2 py-1 text-white",
        /** Larger dark chip over a thumbnail strip, e.g. a time span. */
        "overlay-strong":
          "border border-white/20 bg-black/75 px-3 py-1.5 text-white",
        /** Muted note over an empty image area. */
        note: "bg-background/95 px-3 py-1.5 text-muted-foreground",
        /** Inverted counter of the current selection. */
        selection: "rounded-lg bg-foreground px-2.5 py-1 text-background",
        /** Outlined counter with a leading icon. */
        counter:
          "gap-1.5 rounded-lg border border-border bg-background px-2.5 py-1.5 [&>svg]:size-3.5!",
        /** Prominent uppercase marker over an image, e.g. start or end. */
        marker:
          "min-h-7 rounded-lg bg-blue-600 px-3 py-1.5 font-bold tracking-wider text-white uppercase shadow-lg ring-2 ring-white/90",
      },
      /** Font size; without it the badge keeps `text-xs`. */
      size: {
        sm: "text-sm",
        xs: "text-xs",
        "2xs": "text-2xs",
        "3xs": "text-3xs",
        "4xs": "text-4xs",
      },
      /** Tabular figures for counts and times. */
      numeric: {
        true: "tabular-nums",
        false: "",
      },
    },
    defaultVariants: {
      variant: "default",
    },
  },
);

function Badge({
  className,
  variant = "default",
  tone,
  size,
  numeric,
  render,
  ...props
}: useRender.ComponentProps<"span"> & VariantProps<typeof badgeVariants>) {
  return useRender({
    defaultTagName: "span",
    props: mergeProps<"span">(
      {
        className: cn(
          badgeVariants({ variant, tone, size, numeric }),
          className,
        ),
      },
      props,
    ),
    render,
    state: {
      slot: "badge",
      variant,
    },
  });
}

export { Badge, badgeVariants };
