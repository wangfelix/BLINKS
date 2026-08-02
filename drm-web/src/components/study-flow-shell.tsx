import type { ReactNode } from "react";

import { BlinksLogo } from "@/components/blinks-logo";
import { mergeClassNames } from "@/lib/utils";

export const StudyFlowBackground = () => (
  <div
    className="pointer-events-none absolute inset-0 overflow-hidden"
    aria-hidden
  >
    <div className="onboarding-orb onboarding-orb-one absolute -top-24 -left-20 size-80 rounded-full bg-sky-300/35 blur-3xl dark:bg-sky-500/15" />
    <div className="onboarding-orb onboarding-orb-two absolute top-1/4 -right-32 size-96 rounded-full bg-violet-300/30 blur-3xl dark:bg-violet-500/15" />
    <div className="onboarding-orb onboarding-orb-three absolute -bottom-32 left-1/3 size-96 rounded-full bg-emerald-200/35 blur-3xl dark:bg-emerald-500/10" />
    <div className="absolute inset-0 bg-[linear-gradient(to_right,var(--border)_1px,transparent_1px),linear-gradient(to_bottom,var(--border)_1px,transparent_1px)] [mask-image:radial-gradient(ellipse_at_center,black,transparent_72%)] bg-[size:44px_44px] opacity-[0.16]" />
  </div>
);

export const StudyFlowShell = ({
  progress,
  headerTrailing,
  children,
  contentClassName,
}: {
  progress: ReactNode;
  headerTrailing: ReactNode;
  children: ReactNode;
  contentClassName?: string;
}) => (
  <main className="relative flex min-h-dvh flex-col overflow-hidden bg-background">
    <StudyFlowBackground />

    <header className="relative z-10 flex min-h-16 items-center justify-between border-b border-border/60 bg-background/55 px-4 backdrop-blur-xl sm:px-8">
      <div className="flex items-center gap-3">
        <BlinksLogo className="h-10 w-[140px]" priority />
        <p className="hidden border-l pl-3 text-xs text-muted-foreground sm:block">
          KIT · KD2Lab
        </p>
      </div>
      {headerTrailing}
    </header>

    <section className="relative z-10 mx-auto flex w-full max-w-4xl flex-1 items-center px-4 py-8 sm:px-6 sm:py-12">
      <div className="w-full overflow-hidden rounded-3xl border border-white/50 bg-background/80 shadow-[0_24px_80px_-28px_rgba(15,23,42,0.35)] ring-1 ring-foreground/5 backdrop-blur-2xl dark:border-white/10">
        <div className="border-b border-border/70 bg-muted/20 px-5 py-6 sm:px-10">
          {progress}
        </div>

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
