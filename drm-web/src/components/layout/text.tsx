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

/** Elements Text can render as; `p` is the default. */
type TextElement = "p" | "span" | "div" | "h1" | "h2" | "h3" | "label";

type TextProps<T extends TextElement> = {
  /** The element to render, e.g. `h1` for a page title or `span` inline. */
  as?: T;
} & Omit<React.ComponentProps<NoInfer<T>>, "as"> &
  VariantProps<typeof textVariants>;

/** Text with the app's standard text styles, rendered as `as` (default `p`). */
export const Text = <T extends TextElement = "p">({
  as,
  className,
  variant,
  ...elementProps
}: TextProps<T>) => {
  const Element = (as ?? "p") as React.ElementType;
  return (
    <Element
      className={mergeClassNames(textVariants({ variant }), className)}
      {...elementProps}
    />
  );
};
