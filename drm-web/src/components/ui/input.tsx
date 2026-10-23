import * as React from "react";
import { Input as InputPrimitive } from "@base-ui/react/input";
import { cva, type VariantProps } from "class-variance-authority";

import { cn } from "@/lib/utils";

const inputVariants = cva(
  "w-full min-w-0 rounded-lg border border-input bg-transparent px-2.5 py-1 text-base transition-colors outline-none file:inline-flex file:h-6 file:border-0 file:bg-transparent file:text-sm file:font-medium file:text-foreground placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:pointer-events-none disabled:cursor-not-allowed disabled:bg-input/50 disabled:opacity-50 aria-invalid:border-destructive aria-invalid:ring-3 aria-invalid:ring-destructive/20 md:text-sm",
  {
    variants: {
      size: {
        default: "h-9",
        lg: "h-11",
        /** Tall rounded field with larger text, for sign-in forms. */
        xl: "h-12 rounded-xl px-4 md:text-base",
      },
      surface: {
        default: "",
        /** Opaque page background. */
        solid: "bg-background",
        /** Translucent blurred background that turns opaque on hover and focus. */
        frosted:
          "border-border/70 bg-background/60 backdrop-blur-sm transition-[border-color,box-shadow,background-color] hover:bg-background/80 focus-visible:bg-background",
      },
    },
    defaultVariants: {
      size: "default",
      surface: "default",
    },
  },
);

type InputProps = Omit<React.ComponentProps<"input">, "size"> &
  VariantProps<typeof inputVariants>;

function Input({ className, type, size, surface, ...props }: InputProps) {
  return (
    <InputPrimitive
      type={type}
      data-slot="input"
      className={cn(inputVariants({ size, surface }), className)}
      {...props}
    />
  );
}

/** Icon slot on the left edge of the field. Sizes the icon unless it sets its own `size-*` class. */
const inputGroupIconVariants = cva(
  "pointer-events-none absolute top-1/2 z-10 flex -translate-y-1/2 text-muted-foreground [&_svg:not([class*='size-'])]:size-4",
  {
    variants: {
      size: {
        default: "left-3",
        lg: "left-4",
        xl: "left-4",
      },
    },
    defaultVariants: {
      size: "default",
    },
  },
);

/** Padding that keeps the typed text clear of the icon and action slots. */
const inputGroupPaddingVariants = cva("", {
  variants: {
    size: {
      default: "",
      lg: "",
      xl: "",
    },
    hasIcon: {
      true: "",
      false: "",
    },
    hasAction: {
      true: "",
      false: "",
    },
  },
  compoundVariants: [
    { size: "default", hasIcon: true, className: "pl-9" },
    { size: ["lg", "xl"], hasIcon: true, className: "pl-11" },
    { size: "default", hasAction: true, className: "pr-10" },
    { size: "lg", hasAction: true, className: "pr-11" },
    { size: "xl", hasAction: true, className: "pr-12" },
  ],
  defaultVariants: {
    size: "default",
    hasIcon: false,
    hasAction: false,
  },
});

type InputGroupProps = InputProps & {
  /** Decorative icon shown inside the field on the left. */
  icon?: React.ReactNode;
  /** Interactive control shown inside the field on the right, e.g. a visibility toggle. */
  action?: React.ReactNode;
  /** Class names for the positioned wrapper around the field. */
  groupClassName?: string;
};

/** Input with optional icon and action slots positioned inside the field. */
function InputGroup({
  icon,
  action,
  groupClassName,
  size,
  className,
  ...props
}: InputGroupProps) {
  const hasIcon = icon !== undefined && icon !== null;
  const hasAction = action !== undefined && action !== null;

  return (
    <div data-slot="input-group" className={cn("relative", groupClassName)}>
      {hasIcon && (
        <span
          data-slot="input-group-icon"
          className={inputGroupIconVariants({ size })}
          aria-hidden
        >
          {icon}
        </span>
      )}
      <Input
        size={size}
        className={cn(
          inputGroupPaddingVariants({ size, hasIcon, hasAction }),
          className,
        )}
        {...props}
      />
      {hasAction && (
        <span
          data-slot="input-group-action"
          className="absolute top-1/2 right-2 flex -translate-y-1/2"
        >
          {action}
        </span>
      )}
    </div>
  );
}

export { Input, InputGroup, inputVariants };
