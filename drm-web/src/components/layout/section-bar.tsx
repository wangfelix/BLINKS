import { cva, type VariantProps } from "class-variance-authority";

import { mergeClassNames } from "@/lib/utils";

/**
 * Full-width band that separates one section of a card, dialog or shell from
 * the next with a single border, such as a progress header, toolbar, filter
 * row or pagination footer. Elements that are not plain divs (a form, a
 * CardHeader) can use `sectionBarVariants` directly.
 */
const sectionBarVariants = cva("", {
  variants: {
    edge: {
      /** Border below the bar, for bars at the top of a section. */
      bottom: "border-b",
      /** Border above the bar, for footer bars. */
      top: "border-t",
      /** No border of its own, for tones that bring one. */
      none: "",
    },
    tone: {
      plain: "border-border/70",
      muted: "border-border/70 bg-muted/20",
      destructive: "border-destructive/20 bg-destructive/5",
      /** Translucent, blurred bar with its own bottom border (`surface-bar`). */
      glass: "surface-bar",
    },
    inset: {
      /** No padding, for elements that bring their own. */
      none: "",
      /** Roomy padding for the progress band of a study shell. */
      page: "px-5 py-6 sm:px-10",
      /** Padding aligned with dialog header and footer bars. */
      dialog: "px-5 py-3 sm:px-7",
      /** Padding aligned with card content. */
      card: "px-4 py-4 sm:px-5",
      /** Card padding with less height, for footer bars. */
      "card-compact": "px-4 py-3 sm:px-5",
    },
    layout: {
      block: "",
      /** Wrapping row with content spread to both ends. */
      toolbar: "flex flex-wrap items-center justify-between gap-3",
    },
  },
  defaultVariants: {
    edge: "bottom",
    tone: "plain",
    inset: "card",
    layout: "block",
  },
});

type SectionBarProps = React.ComponentProps<"div"> &
  VariantProps<typeof sectionBarVariants>;

const SectionBar = ({
  edge,
  tone,
  inset,
  layout,
  className,
  ...props
}: SectionBarProps) => (
  <div
    data-slot="section-bar"
    className={mergeClassNames(
      sectionBarVariants({ edge, tone, inset, layout }),
      className,
    )}
    {...props}
  />
);

export { SectionBar, sectionBarVariants };
