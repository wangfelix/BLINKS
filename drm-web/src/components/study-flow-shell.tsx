import type { ReactNode } from "react";

import { SectionBar } from "@/components/layout/section-bar";
import { BlinksLogo } from "@/components/blinks-logo";
import { Row } from "@/components/layout/flex";
import { mergeClassNames } from "@/lib/utils";

export const StudyFlowBackground = () => (
  <div
    className="pointer-events-none absolute inset-0 overflow-hidden"
    aria-hidden
  >
    <div className="onboarding-orb onboarding-orb-one absolute -top-24 -left-20 size-80 rounded-full bg-sky-300/35 blur-3xl" />
    <div className="onboarding-orb onboarding-orb-two absolute top-1/4 -right-32 size-96 rounded-full bg-violet-300/30 blur-3xl" />
    <div className="onboarding-orb onboarding-orb-three absolute -bottom-32 left-1/3 size-96 rounded-full bg-emerald-200/35 blur-3xl" />
    <div className="absolute inset-0 bg-grid mask-fade-radial opacity-16" />
  </div>
);

export const StudyFlowShell = ({
  progress,
  headerTrailing,
  children,
  contentClassName,
  maxWidthClassName = "max-w-4xl",
}: {
  progress?: ReactNode;
  headerTrailing?: ReactNode;
  children: ReactNode;
  contentClassName?: string;
  maxWidthClassName?: string;
}) => (
  <main className="relative flex min-h-dvh flex-col overflow-hidden bg-background">
    <StudyFlowBackground />

    <header className="relative z-10 flex min-h-16 items-center justify-between surface-bar px-4 sm:px-8">
      <Row gap="md" align="center">
        <BlinksLogo className="h-10 w-[140px]" priority />
        <p className="hidden border-l pl-3 text-xs text-muted-foreground sm:block">
          KIT - KD2Lab
        </p>
      </Row>
      {headerTrailing}
    </header>

    <section
      className={mergeClassNames(
        "relative z-10 mx-auto flex w-full flex-1 items-center px-4 py-8 sm:px-6 sm:py-12",
        maxWidthClassName,
      )}
    >
      <div className="w-full overflow-hidden rounded-3xl surface-glass">
        {progress !== undefined && (
          <SectionBar tone="muted" inset="page">
            {progress}
          </SectionBar>
        )}

        <div
          className={mergeClassNames(
            "relative min-h-[440px] px-5 py-7 sm:min-h-[470px] sm:px-10 sm:py-10",
            contentClassName,
          )}
        >
          {children}
        </div>
      </div>
    </section>
  </main>
);
