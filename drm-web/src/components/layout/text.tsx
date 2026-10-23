import { cva, type VariantProps } from "class-variance-authority";

import { mergeClassNames } from "@/lib/utils";

/**
 * Typography roles for running text and headings. `variant` sets size,
 * weight and tracking; `tone` sets the color and defaults to the role's own
 * color (see `defaultTones`); `weight` replaces the role's font weight;
 * `truncate` cuts overflowing text to one line with an ellipsis. Spacing,
 * alignment and further responsive sizes go through `className`.
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
      /** Intro paragraph below a page or card title, one step larger from `sm` on. */
      lead: "text-sm leading-relaxed sm:text-base",
      /** Regular body copy. */
      body: "text-sm",
      /** Short emphasized line at body size, e.g. a list or group label. */
      label: "text-sm font-medium",
      /** Small print: hints, save indicators, image captions. */
      caption: "text-xs",
      /** Small kicker line above a heading. */
      eyebrow: "text-xs font-medium tracking-widest",
      /** Uppercase section kicker, e.g. above an admin page title. */
      overline: "text-xs font-semibold tracking-label uppercase",
      /** Emphasized small print: step labels, counters, placeholder notes. */
      small: "text-xs font-medium",
      /** Monospaced values such as IDs, table cells and counts. */
      mono: "font-mono text-xs",
      /** Large figure of a stat tile. */
      stat: "text-xl font-semibold tracking-tight tabular-nums",
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
    truncate: {
      true: "truncate",
      false: "",
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
  lead: "muted",
  body: "default",
  label: "inherit",
  caption: "muted",
  eyebrow: "muted",
  overline: "muted",
  small: "inherit",
  mono: "inherit",
  stat: "inherit",
  inherit: "inherit",
};

/** Elements Text can render as; `p` is the default. */
type TextElement = "p" | "span" | "div" | "h1" | "h2" | "h3" | "label";

type TextProps<T extends TextElement> = {
  /** The element to render, e.g. `h1` for a page title or `span` inline. */
  as?: T;
} & Omit<React.ComponentProps<NoInfer<T>>, "as"> &
  VariantProps<typeof textVariants>;

/** Resolves the role, tone, weight and truncate classes, filling in the role's default tone. */
const textClassName = ({
  variant,
  tone,
  weight,
  truncate,
}: VariantProps<typeof textVariants>) =>
  textVariants({
    variant,
    tone: tone ?? defaultTones[variant ?? "body"],
    weight,
    truncate,
  });

/** Text in one of the app's typography roles, rendered as `as` (default `p`). */
const Text = <T extends TextElement = "p">({
  as,
  className,
  variant,
  tone,
  weight,
  truncate,
  ...elementProps
}: TextProps<T>) => {
  const Element = (as ?? "p") as React.ElementType;
  return (
    <Element
      className={mergeClassNames(
        textClassName({ variant, tone, weight, truncate }),
        className,
      )}
      {...elementProps}
    />
  );
};

export { Text, textVariants };
