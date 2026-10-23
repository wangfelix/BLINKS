import { cva, type VariantProps } from "class-variance-authority";

import { mergeClassNames } from "@/lib/utils";

/**
 * Styling knobs for Grid. The gap scale matches Row and Column. Responsive
 * column counts (`sm:grid-cols-2`, …) and anything else these props do not
 * cover go through `className`.
 */
const gridVariants = cva("grid", {
  variants: {
    gap: {
      none: "",
      "2xs": "gap-0.5",
      xs: "gap-1",
      sm: "gap-2",
      md: "gap-3",
      lg: "gap-4",
      xl: "gap-6",
      "2xl": "gap-8",
    },
    cols: {
      1: "grid-cols-1",
      2: "grid-cols-2",
      3: "grid-cols-3",
      4: "grid-cols-4",
    },
    align: {
      start: "items-start",
      center: "items-center",
      end: "items-end",
      stretch: "items-stretch",
    },
    place: {
      center: "place-items-center",
    },
    layout: {
      /**
       * Stacked label and control on small screens; from `sm` on, label and
       * control sit side by side in the `field-row` column template.
       */
      "field-row": "sm:grid-cols-field-row sm:items-center sm:gap-6",
    },
  },
  defaultVariants: {
    gap: "none",
  },
});

type GridProps = React.ComponentProps<"div"> &
  VariantProps<typeof gridVariants>;

/** A CSS grid container (`display: grid`). */
const Grid = ({
  className,
  gap,
  cols,
  align,
  place,
  layout,
  ...divProps
}: GridProps) => (
  <div
    className={mergeClassNames(
      gridVariants({ gap, cols, align, place, layout }),
      className,
    )}
    {...divProps}
  />
);

export { Grid, gridVariants };
