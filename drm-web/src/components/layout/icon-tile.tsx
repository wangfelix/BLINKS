import { cva, type VariantProps } from "class-variance-authority";

import { mergeClassNames } from "@/lib/utils";

/**
 * Square tile that frames a single icon, e.g. next to a dialog title or above
 * an empty-state message. The tile sizes the icon unless the icon sets its
 * own `size-*` class.
 */
const iconTileVariants = cva("flex shrink-0 items-center justify-center", {
  variants: {
    tone: {
      /** Tinted with the primary color. */
      primary: "bg-primary/10 text-primary ring-1 ring-primary/10",
      /** Tinted with the destructive color, for delete confirmations. */
      destructive: "bg-destructive/10 text-destructive",
      /** Bordered tile on the page background with a muted icon. */
      outline: "border bg-background text-muted-foreground",
      /** Bordered translucent tile that keeps the surrounding text color. */
      subtle: "border border-border/70 bg-background/60",
    },
    size: {
      sm: "size-9 rounded-xl [&_svg:not([class*='size-'])]:size-4",
      md: "size-10 rounded-xl [&_svg:not([class*='size-'])]:size-5",
      lg: "size-11 rounded-2xl [&_svg:not([class*='size-'])]:size-5",
      xl: "size-12 rounded-2xl [&_svg:not([class*='size-'])]:size-5",
    },
  },
  defaultVariants: {
    tone: "primary",
    size: "md",
  },
});

type IconTileProps = React.ComponentProps<"span"> &
  VariantProps<typeof iconTileVariants>;

const IconTile = ({ tone, size, className, ...props }: IconTileProps) => (
  <span
    data-slot="icon-tile"
    className={mergeClassNames(iconTileVariants({ tone, size }), className)}
    {...props}
  />
);

export { IconTile, iconTileVariants };
