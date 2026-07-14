import { cva, type VariantProps } from "class-variance-authority";

import { mergeClassNames } from "@/lib/utils";

/**
 * Shared styling knobs for Row and Column. Every knob is optional; the
 * defaults are a plain flex container with no gap. Anything these props do
 * not cover (padding, borders, responsive overrides, …) goes through
 * `className` as usual.
 */
const flexVariants = cva("flex", {
  variants: {
    gap: {
      none: "",
      xs: "gap-1",
      sm: "gap-2",
      md: "gap-3",
      lg: "gap-4",
      xl: "gap-6",
    },
    align: {
      start: "items-start",
      center: "items-center",
      end: "items-end",
      baseline: "items-baseline",
      stretch: "items-stretch",
    },
    justify: {
      start: "justify-start",
      center: "justify-center",
      end: "justify-end",
      between: "justify-between",
    },
    wrap: {
      true: "flex-wrap",
    },
  },
  defaultVariants: {
    gap: "none",
  },
});

type FlexProps = React.ComponentPropsWithoutRef<"div"> &
  VariantProps<typeof flexVariants>;

/** A horizontal flex container (`display: flex`, row direction). */
export const Row = ({
  className,
  gap,
  align,
  justify,
  wrap,
  ...divProps
}: FlexProps) => (
  <div
    className={mergeClassNames(
      "flex-row",
      flexVariants({ gap, align, justify, wrap }),
      className,
    )}
    {...divProps}
  />
);

/** A vertical flex container (`display: flex`, column direction). */
export const Column = ({
  className,
  gap,
  align,
  justify,
  wrap,
  ...divProps
}: FlexProps) => (
  <div
    className={mergeClassNames(
      "flex-col",
      flexVariants({ gap, align, justify, wrap }),
      className,
    )}
    {...divProps}
  />
);
