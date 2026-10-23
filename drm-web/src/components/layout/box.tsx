import { cva, type VariantProps } from "class-variance-authority";

import { mergeClassNames } from "@/lib/utils";

/**
 * Plain block wrapper for positioning, stacking and clipping. Used where a
 * wrapper anchors positioned children, lifts its content above a background
 * layer, or clips its content to its box. Padding and sizing go through
 * `className`.
 */
const boxVariants = cva("", {
  variants: {
    position: {
      relative: "relative",
    },
    layer: {
      /** Above the page background layers. */
      raised: "z-10",
      /** Above raised content, for navigation bars and their menus. */
      top: "z-20",
    },
    clip: {
      true: "overflow-hidden",
    },
    isolate: {
      /** Starts a new stacking context for the content's own z-indexes. */
      true: "isolate",
    },
  },
});

type BoxProps = React.ComponentProps<"div"> & VariantProps<typeof boxVariants>;

const Box = ({
  className,
  position,
  layer,
  clip,
  isolate,
  ...divProps
}: BoxProps) => (
  <div
    className={mergeClassNames(
      boxVariants({ position, layer, clip, isolate }),
      className,
    )}
    {...divProps}
  />
);

export { Box, boxVariants };
