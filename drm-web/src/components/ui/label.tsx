"use client";

import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";

import { cn } from "@/lib/utils";

const labelVariants = cva(
  "flex items-center gap-2 text-sm leading-none font-medium select-none group-data-[disabled=true]:pointer-events-none group-data-[disabled=true]:opacity-50 peer-disabled:cursor-not-allowed peer-disabled:opacity-50",
  {
    variants: {
      color: {
        default: "",
        destructive: "text-destructive",
      },
    },
    defaultVariants: {
      color: "default",
    },
  },
);

type LabelProps = Omit<React.ComponentProps<"label">, "color"> &
  VariantProps<typeof labelVariants>;

function Label({ className, color, ...props }: LabelProps) {
  return (
    <label
      data-slot="label"
      className={cn(labelVariants({ color }), className)}
      {...props}
    />
  );
}

export { Label, labelVariants };
