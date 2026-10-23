import { cva, type VariantProps } from "class-variance-authority";

import { mergeClassNames } from "@/lib/utils";

/**
 * Width constraint for a block of page content. By default the block is
 * centered (`mx-auto`) and takes the full width up to its `size`.
 */
const containerVariants = cva("", {
  variants: {
    size: {
      sm: "max-w-sm",
      lg: "max-w-lg",
      xl: "max-w-xl",
      "2xl": "max-w-2xl",
      "4xl": "max-w-4xl",
      /** Wide content area of the admin dashboard. */
      wide: "max-w-[1600px]",
    },
    center: {
      true: "mx-auto",
      false: "",
    },
    fill: {
      true: "w-full",
      false: "",
    },
  },
  defaultVariants: {
    center: true,
    fill: true,
  },
});

type ContainerProps = React.ComponentProps<"div"> &
  VariantProps<typeof containerVariants>;

const Container = ({
  className,
  size,
  center,
  fill,
  ...divProps
}: ContainerProps) => (
  <div
    className={mergeClassNames(
      containerVariants({ size, center, fill }),
      className,
    )}
    {...divProps}
  />
);

export { Container, containerVariants };
