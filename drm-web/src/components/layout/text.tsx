import { cva, type VariantProps } from "class-variance-authority";

import { mergeClassNames } from "@/lib/utils";

/**
 * Typography roles for running text and headings. `variant` sets size,
 * weight and tracking; `tone` sets the color and defaults to the role's own
 * color (see `defaultTones`); `weight` replaces the role's font weight.
 * Spacing, alignment and responsive sizes go through `className`.
 */
const textVariants = cva("", {
  variants: {
    variant: {
      /** Hero heading of a landing or completion screen. */
      display: "text-3xl font-semibold tracking-tight",
      /** Page or screen title. */
      title: "text-2xl font-semibold tracking-tight",
      /** Section or card heading. */
      heading: "text-lg font-semibold",
      /** Heading of a smaller section or a step. */
      subheading: "text-base font-semibold",
      /** Regular body copy. */
      body: "text-sm",
      /** Short emphasized line at body size, e.g. a list or group label. */
      label: "text-sm font-medium",
      /** Small print: hints, save indicators, image captions. */
      caption: "text-xs",
      /** Small kicker line above a heading. */
      eyebrow: "text-xs font-medium tracking-widest",
      /**
       * No styles of its own, for slots that style their children already
       * (e.g. AlertDescription).
       */
      inherit: "",
    },
    tone: {
      default: "text-foreground",
      muted: "text-muted-foreground",
      destructive: "text-destructive",
      /** Keeps the color of the parent element. */
      inherit: "",
    },
    weight: {
      normal: "font-normal",
      medium: "font-medium",
      semibold: "font-semibold",
      bold: "font-bold",
    },
  },
  defaultVariants: {
    variant: "body",
  },
});

type TextVariant = NonNullable<VariantProps<typeof textVariants>["variant"]>;
type TextTone = NonNullable<VariantProps<typeof textVariants>["tone"]>;

/** The color each role uses when no `tone` is given. */
const defaultTones: Record<TextVariant, TextTone> = {
  display: "inherit",
  title: "inherit",
  heading: "inherit",
  subheading: "inherit",
  body: "default",
  label: "inherit",
  caption: "muted",
  eyebrow: "muted",
  inherit: "inherit",
};

/** Elements Text can render as; `p` is the default. */
type TextElement = "p" | "span" | "div" | "h1" | "h2" | "h3" | "label";

type TextProps<T extends TextElement> = {
  /** The element to render, e.g. `h1` for a page title or `span` inline. */
  as?: T;
} & Omit<React.ComponentProps<NoInfer<T>>, "as"> &
  VariantProps<typeof textVariants>;

/** Resolves the role, tone and weight classes, filling in the role's default tone. */
const textClassName = ({
  variant,
  tone,
  weight,
}: VariantProps<typeof textVariants>) =>
  textVariants({
    variant,
    tone: tone ?? defaultTones[variant ?? "body"],
    weight,
  });

/** Text in one of the app's typography roles, rendered as `as` (default `p`). */
const Text = <T extends TextElement = "p">({
  as,
  className,
  variant,
  tone,
  weight,
  ...elementProps
}: TextProps<T>) => {
  const Element = (as ?? "p") as React.ElementType;
  return (
    <Element
      className={mergeClassNames(
        textClassName({ variant, tone, weight }),
        className,
      )}
      {...elementProps}
    />
  );
};

export { Text, textVariants };
