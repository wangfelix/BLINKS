import { cva, type VariantProps } from "class-variance-authority";

import { mergeClassNames } from "@/lib/utils";

const textVariants = cva("", {
  variants: {
    variant: {
      /** Regular body copy. */
      primary: "text-sm text-foreground",
      /** Supporting copy in the muted foreground color. */
      secondary: "text-sm text-muted-foreground",
      /** Small print: hints, save indicators, image captions. */
      nudge: "text-xs text-muted-foreground",
      /** Validation and error messages. */
      destructive: "text-sm text-destructive",
      /** Small uppercase-style kicker line above a heading. */
      eyebrow: "text-xs font-medium tracking-widest text-muted-foreground",
      /**
       * No styles of its own — for slots that style their children already
       * (e.g. AlertDescription).
       */
      inherit: "",
    },
  },
  defaultVariants: {
    variant: "primary",
  },
});

type TextProps = React.ComponentPropsWithoutRef<"p"> &
  VariantProps<typeof textVariants>;

/** A paragraph with the app's standard text styles baked in. */
export const Text = ({ className, variant, ...paragraphProps }: TextProps) => (
  <p
    className={mergeClassNames(textVariants({ variant }), className)}
    {...paragraphProps}
  />
);
