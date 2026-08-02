"use client";

import { useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { BugIcon, XIcon } from "lucide-react";

import { Button, buttonVariants } from "@/components/ui/button";
import { mergeClassNames } from "@/lib/utils";

const DEV_DESTINATIONS = [
  { href: "/", label: "Landing / login" },
  { href: "/dev/onboarding", label: "Onboarding preview" },
  { href: "/dev/self-intro", label: "Self-DRM introduction" },
  { href: "/dev/self", label: "Self-DRM" },
  { href: "/dev/assisted-intro", label: "Assisted introduction" },
  { href: "/dev/assisted", label: "VLM-assisted DRM" },
  { href: "/survey", label: "Survey link" },
  { href: "/done", label: "Done / offboarding" },
] as const;

export const DevNavigator = () => {
  const pathname = usePathname();
  const [isOpen, setIsOpen] = useState(false);

  return (
    <div className="fixed right-4 bottom-4 z-50 flex flex-col items-end gap-2">
      {isOpen && (
        <div className="w-56 rounded-xl border border-amber-300 bg-white p-2 shadow-xl">
          <div className="flex items-center justify-between gap-2 px-2 py-1">
            <span className="text-xs font-semibold tracking-wide text-amber-800 uppercase">
              DRM dev mode
            </span>
            <Button
              variant="ghost"
              size="icon-xs"
              aria-label="Close developer navigation"
              onClick={() => setIsOpen(false)}
            >
              <XIcon />
            </Button>
          </div>
          <nav
            className="mt-1 flex flex-col gap-1"
            aria-label="Developer pages"
          >
            {DEV_DESTINATIONS.map((destination) => (
              <Link
                key={destination.href}
                href={destination.href}
                className={mergeClassNames(
                  buttonVariants({
                    variant:
                      pathname === destination.href ? "secondary" : "ghost",
                    size: "sm",
                  }),
                  "w-full justify-start",
                )}
                onClick={() => setIsOpen(false)}
              >
                {destination.label}
              </Link>
            ))}
          </nav>
        </div>
      )}

      <Button
        className="border-amber-400 bg-amber-300 text-amber-950 shadow-lg hover:bg-amber-400"
        aria-expanded={isOpen}
        aria-label="Toggle developer navigation"
        onClick={() => setIsOpen((open) => !open)}
      >
        <BugIcon />
        Dev pages
      </Button>
    </div>
  );
};
