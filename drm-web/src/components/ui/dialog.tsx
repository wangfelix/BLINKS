"use client";

import * as React from "react";
import { Dialog as DialogPrimitive } from "@base-ui/react/dialog";
import { cva, type VariantProps } from "class-variance-authority";

import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { XIcon } from "lucide-react";

function Dialog({ ...props }: DialogPrimitive.Root.Props) {
  return <DialogPrimitive.Root data-slot="dialog" {...props} />;
}

function DialogTrigger({ ...props }: DialogPrimitive.Trigger.Props) {
  return <DialogPrimitive.Trigger data-slot="dialog-trigger" {...props} />;
}

function DialogPortal({ ...props }: DialogPrimitive.Portal.Props) {
  return <DialogPrimitive.Portal data-slot="dialog-portal" {...props} />;
}

function DialogClose({ ...props }: DialogPrimitive.Close.Props) {
  return <DialogPrimitive.Close data-slot="dialog-close" {...props} />;
}

function DialogOverlay({
  className,
  ...props
}: DialogPrimitive.Backdrop.Props) {
  return (
    <DialogPrimitive.Backdrop
      data-slot="dialog-overlay"
      className={cn(
        "fixed inset-0 isolate z-50 bg-black/10 duration-100 supports-backdrop-filter:backdrop-blur-xs data-open:animate-in data-open:fade-in-0 data-closed:animate-out data-closed:fade-out-0",
        className,
      )}
      {...props}
    />
  );
}

const dialogContentVariants = cva(
  "fixed top-1/2 left-1/2 z-50 grid w-full max-w-[calc(100%-2rem)] -translate-x-1/2 -translate-y-1/2 rounded-xl bg-popover text-sm text-popover-foreground ring-1 ring-foreground/10 duration-100 outline-none data-open:animate-in data-open:fade-in-0 data-open:zoom-in-95 data-closed:animate-out data-closed:fade-out-0 data-closed:zoom-out-95",
  {
    variants: {
      variant: {
        default: "gap-4 p-4 sm:max-w-sm",
        /** Compact confirmation with flush, separately padded sections. */
        confirm: "gap-0 overflow-hidden rounded-2xl p-0 sm:max-w-md",
        /** Large workspace panel on the page background, up to the viewport height, with flush sections. */
        panel:
          "max-h-dialog gap-0 overflow-hidden rounded-3xl bg-background p-0 sm:max-w-6xl",
      },
    },
    defaultVariants: {
      variant: "default",
    },
  },
);

const dialogCloseVariants = cva("absolute", {
  variants: {
    closePosition: {
      corner: "top-2 right-2",
      /** Further from the corner, aligned with a spacious header bar. */
      inset: "top-5 right-5",
    },
  },
  defaultVariants: {
    closePosition: "corner",
  },
});

function DialogContent({
  className,
  children,
  variant,
  closePosition,
  showCloseButton = true,
  ...props
}: DialogPrimitive.Popup.Props &
  VariantProps<typeof dialogContentVariants> &
  VariantProps<typeof dialogCloseVariants> & {
    showCloseButton?: boolean;
  }) {
  return (
    <DialogPortal>
      <DialogOverlay />
      <DialogPrimitive.Popup
        data-slot="dialog-content"
        className={cn(dialogContentVariants({ variant }), className)}
        {...props}
      >
        {children}
        {showCloseButton && (
          <DialogPrimitive.Close
            data-slot="dialog-close"
            render={
              <Button
                variant="ghost"
                className={dialogCloseVariants({ closePosition })}
                size="icon-sm"
              />
            }
          >
            <XIcon />
            <span className="sr-only">Close</span>
          </DialogPrimitive.Close>
        )}
      </DialogPrimitive.Popup>
    </DialogPortal>
  );
}

const dialogHeaderVariants = cva("flex flex-col gap-2", {
  variants: {
    variant: {
      default: "",
      /** Bordered top section of a flush dialog, with room for the close button. */
      bar: "border-b border-border/70 px-5 py-5 pr-16 sm:px-7",
      /** Bar with more vertical padding and room for an inset close button. */
      "bar-spacious":
        "border-b border-border/70 px-5 py-5 pr-16 sm:px-7 sm:py-6 sm:pr-20",
    },
  },
  defaultVariants: {
    variant: "default",
  },
});

function DialogHeader({
  className,
  variant,
  ...props
}: React.ComponentProps<"div"> & VariantProps<typeof dialogHeaderVariants>) {
  return (
    <div
      data-slot="dialog-header"
      className={cn(dialogHeaderVariants({ variant }), className)}
      {...props}
    />
  );
}

/** Padded content section of a flush dialog. */
function DialogBody({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="dialog-body"
      className={cn("px-5 py-6 pr-14 sm:px-6", className)}
      {...props}
    />
  );
}

const dialogFooterVariants = cva(
  "flex flex-col-reverse gap-2 border-t sm:flex-row",
  {
    variants: {
      variant: {
        default: "-mx-4 -mb-4 rounded-b-xl bg-muted/50 p-4 sm:justify-end",
        /** Bottom section of a flush dialog, actions aligned right. */
        flush: "bg-muted/30 p-4 sm:justify-end",
        /** Bottom bar of a panel dialog, content spread to both ends. */
        split:
          "border-border/70 bg-background px-5 py-4 sm:items-center sm:justify-between sm:px-7",
      },
    },
    defaultVariants: {
      variant: "default",
    },
  },
);

function DialogFooter({
  className,
  variant,
  showCloseButton = false,
  children,
  ...props
}: React.ComponentProps<"div"> &
  VariantProps<typeof dialogFooterVariants> & {
    showCloseButton?: boolean;
  }) {
  return (
    <div
      data-slot="dialog-footer"
      className={cn(dialogFooterVariants({ variant }), className)}
      {...props}
    >
      {children}
      {showCloseButton && (
        <DialogPrimitive.Close render={<Button variant="outline" />}>
          Close
        </DialogPrimitive.Close>
      )}
    </div>
  );
}

const dialogTitleVariants = cva("font-heading font-medium", {
  variants: {
    size: {
      default: "text-base leading-none",
      lg: "text-lg leading-tight font-semibold",
      /** Large title that grows one step from the sm breakpoint. */
      xl: "text-lg leading-tight font-semibold sm:text-xl",
    },
  },
  defaultVariants: {
    size: "default",
  },
});

function DialogTitle({
  className,
  size,
  ...props
}: DialogPrimitive.Title.Props & VariantProps<typeof dialogTitleVariants>) {
  return (
    <DialogPrimitive.Title
      data-slot="dialog-title"
      className={cn(dialogTitleVariants({ size }), className)}
      {...props}
    />
  );
}

function DialogDescription({
  className,
  ...props
}: DialogPrimitive.Description.Props) {
  return (
    <DialogPrimitive.Description
      data-slot="dialog-description"
      className={cn(
        "text-sm text-muted-foreground *:[a]:underline *:[a]:underline-offset-3 *:[a]:hover:text-foreground",
        className,
      )}
      {...props}
    />
  );
}

export {
  Dialog,
  DialogBody,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogOverlay,
  DialogPortal,
  DialogTitle,
  DialogTrigger,
};
