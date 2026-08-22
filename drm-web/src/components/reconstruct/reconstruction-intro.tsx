"use client";

import { useEffect, useRef } from "react";
import {
  ArrowRightIcon,
  CalendarClockIcon,
  LogOutIcon,
  SparklesIcon,
} from "lucide-react";

import { StudyFlowShell } from "@/components/study-flow-shell";
import { StudyProgress } from "@/components/study-progress";
import { Button } from "@/components/ui/button";
import { AssistedRoundReminder } from "@/components/reconstruct/assisted-round-reminder";

const INTRO_CONTENT = {
  1: {
    title: "Welcome back!",
    description:
      "In the following, you will reconstruct your day. Please specify the time frame of each activity, select a suitable description from a list of options, and specify whether the activity was a work or break activity, or neither. A description of each term is available on the next page.",
    icon: CalendarClockIcon,
    iconClassName:
      "bg-sky-500/10 text-sky-700 ring-sky-500/10 dark:text-sky-300",
  },
  2: {
    title: "Review the automated suggestion",
    description:
      "In the next step, you will see an automatically generated suggestion of a reconstruction of your day. Please adjust the suggested list of entries until it matches your day. You can delete entries, adjust their times, activity types and descriptions. You can also add activities for which no images have been recorded, e.g. when you paused the recording during the day.",
    icon: SparklesIcon,
    iconClassName:
      "bg-violet-500/10 text-violet-700 ring-violet-500/10 dark:text-violet-300",
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
      <div className="onboarding-step-enter onboarding-stagger mx-auto flex min-h-[350px] max-w-2xl flex-col justify-center">
        <div className="flex items-start gap-4 sm:gap-5">
          <span
            className={`grid size-12 shrink-0 place-items-center rounded-2xl ring-1 sm:size-14 ${content.iconClassName}`}
          >
            <Icon className="size-5 sm:size-6" aria-hidden />
          </span>
          <div>
            <h1
              ref={headingRef}
              tabIndex={-1}
              className="text-2xl font-semibold tracking-tight outline-none sm:text-3xl"
            >
              {content.title}
            </h1>
            <p className="mt-3 text-sm leading-7 text-muted-foreground sm:text-base sm:leading-8">
              {content.description}
            </p>
            {round === 2 && <AssistedRoundReminder className="mt-6" />}
          </div>
        </div>

        <div className="mt-9 flex justify-end">
          <Button
            size="lg"
            className="w-full shadow-md sm:w-auto"
            onClick={onContinue}
          >
            Continue
            <ArrowRightIcon aria-hidden />
          </Button>
        </div>
      </div>
    </StudyFlowShell>
  );
};
