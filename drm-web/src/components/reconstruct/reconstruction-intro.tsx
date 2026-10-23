"use client";

import { useEffect, useRef } from "react";
import {
  ArrowRightIcon,
  CalendarClockIcon,
  LogOutIcon,
  SparklesIcon,
} from "lucide-react";

import { getStudyConfig } from "@/lib/study-config-store";
import { StudyFlowShell } from "@/components/study-flow-shell";
import { StudyProgress } from "@/components/study-progress";
import { Button } from "@/components/ui/button";
import { AssistedRoundReminder } from "@/components/reconstruct/assisted-round-reminder";
import { Column, Row } from "@/components/layout/flex";

const INTRO_CONTENT = {
  1: {
    icon: CalendarClockIcon,
    iconClassName: "bg-sky-500/10 text-sky-700 ring-sky-500/10",
  },
  2: {
    icon: SparklesIcon,
    iconClassName: "bg-violet-500/10 text-violet-700 ring-violet-500/10",
  },
} as const;

export const ReconstructionIntro = ({
  round,
  onContinue,
  onSignOut,
  preview = false,
}: {
  round: 1 | 2;
  onContinue: () => void;
  onSignOut?: () => void;
  preview?: boolean;
}) => {
  const content = INTRO_CONTENT[round];
  const texts = getStudyConfig().texts.rounds;
  const title = round === 1 ? texts.selfIntroTitle : texts.assistedIntroTitle;
  const description =
    round === 1 ? texts.selfIntroDescription : texts.assistedIntroDescription;
  const Icon = content.icon;
  const headingRef = useRef<HTMLHeadingElement>(null);

  useEffect(() => {
    const frame = window.requestAnimationFrame(() => {
      headingRef.current?.focus({ preventScroll: true });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [round]);

  return (
    <StudyFlowShell
      progress={
        <StudyProgress
          currentPage="reconstruction"
          bare
          activeRoundOverride={preview ? round : undefined}
        />
      }
      headerTrailing={
        preview ? (
          <span className="rounded-full border border-amber-300 bg-amber-100 px-3 py-1 text-xs font-semibold text-amber-900">
            Developer preview
          </span>
        ) : (
          <Button variant="ghost" size="sm" onClick={onSignOut}>
            <LogOutIcon aria-hidden />
            Sign out
          </Button>
        )
      }
    >
      <Column
        justify="center"
        className="onboarding-step-enter onboarding-stagger mx-auto min-h-step max-w-2xl"
      >
        <Row gap="lg" align="start" className="sm:gap-5">
          <span
            className={`grid size-12 shrink-0 place-items-center rounded-2xl ring-1 sm:size-14 ${content.iconClassName}`}
          >
            <Icon className="size-5 sm:size-6" aria-hidden />
          </span>
          <header>
            <h1
              ref={headingRef}
              tabIndex={-1}
              className="text-2xl font-semibold tracking-tight outline-none sm:text-3xl"
            >
              {title}
            </h1>
            <p className="mt-3 text-sm leading-7 text-muted-foreground sm:text-base sm:leading-8">
              {description}
            </p>
            {round === 2 && <AssistedRoundReminder className="mt-6" />}
          </header>
        </Row>

        <Row justify="end" className="mt-9">
          <Button
            size="lg"
            className="w-full shadow-md sm:w-auto"
            onClick={onContinue}
          >
            Continue
            <ArrowRightIcon aria-hidden />
          </Button>
        </Row>
      </Column>
    </StudyFlowShell>
  );
};
