import type { ReactNode } from "react";

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

      <div className="relative z-20">
        <StudyNavbar />
      </div>

      {progress !== undefined && progressPosition === "full-width" && (
        <div className="relative z-10 border-b border-border/60 bg-background/55 px-4 py-4 backdrop-blur-xl sm:px-8 sm:py-5">
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
            !isPlain &&
              "overflow-hidden rounded-3xl border border-white/50 bg-background/80 shadow-[0_24px_80px_-28px_rgba(15,23,42,0.35)] ring-1 ring-foreground/5 backdrop-blur-2xl dark:border-white/10",
          )}
        >
          {progress !== undefined && progressPosition === "card" && (
            <div className="border-b border-border/70 bg-muted/20 px-5 py-6 sm:px-10">
              {progress}
            </div>
          )}

          <div
            className={mergeClassNames(
              "relative",
              !isPlain && "px-5 py-7 sm:px-8 sm:py-9",
              contentClassName,
            )}
          >
            {children}
          </div>
        </div>
      </section>
    </main>
  );
};
