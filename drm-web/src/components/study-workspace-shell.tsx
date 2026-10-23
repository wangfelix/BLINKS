import type { ReactNode } from "react";

import { SectionBar } from "@/components/layout/section-bar";
import { Box } from "@/components/layout/box";
import { StudyFlowBackground } from "@/components/study-flow-shell";
import { StudyNavbar } from "@/components/study-navbar";
import { mergeClassNames } from "@/lib/utils";

export const StudyWorkspaceShell = ({
  progress,
  children,
  maxWidthClassName = "max-w-6xl",
  contentClassName,
  variant = "card",
  progressPosition = "card",
}: {
  progress?: ReactNode;
  children: ReactNode;
  maxWidthClassName?: string;
  contentClassName?: string;
  variant?: "card" | "plain";
  progressPosition?: "card" | "full-width";
}) => {
  const isPlain = variant === "plain";

  return (
    <main className="relative flex min-h-dvh flex-col overflow-x-clip bg-background">
      <StudyFlowBackground />

      <Box position="relative" layer="top">
        <StudyNavbar />
      </Box>

      {progress !== undefined && progressPosition === "full-width" && (
        <div className="relative z-10 surface-bar px-4 py-4 sm:px-8 sm:py-5">
          {progress}
        </div>
      )}

      <section
        className={mergeClassNames(
          "relative z-10 mx-auto flex w-full flex-1 px-4 py-8 sm:px-6 sm:py-10",
          maxWidthClassName,
        )}
      >
        <div
          className={mergeClassNames(
            "w-full self-start",
            !isPlain && "overflow-hidden rounded-3xl surface-glass",
          )}
        >
          {progress !== undefined && progressPosition === "card" && (
            <SectionBar tone="muted" inset="page">
              {progress}
            </SectionBar>
          )}

          <Box
            position="relative"
            className={mergeClassNames(
              !isPlain && "px-5 py-7 sm:px-8 sm:py-9",
              contentClassName,
            )}
          >
            {children}
          </Box>
        </div>
      </section>
    </main>
  );
};
