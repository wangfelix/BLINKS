"use client";

import { useEffect, useRef } from "react";
import { CalendarX2Icon, Clock3Icon, LogOutIcon } from "lucide-react";

import { StudyFlowShell } from "@/components/study-flow-shell";
import { StudyProgress } from "@/components/study-progress";
import { Button } from "@/components/ui/button";
import { Column } from "@/components/layout/flex";
import { Text } from "@/components/layout/text";

type ReconstructionStatus =
  { kind: "no-recorded-day" } | { kind: "opens-later"; availableFrom: string };

export const ReconstructionStatusScreen = ({
  status,
  onSignOut,
}: {
  status: ReconstructionStatus;
  onSignOut: () => void;
}) => {
  const headingRef = useRef<HTMLHeadingElement>(null);
  const isWaitingForDay = status.kind === "no-recorded-day";
  const Icon = isWaitingForDay ? CalendarX2Icon : Clock3Icon;

  useEffect(() => {
    const frame = window.requestAnimationFrame(() => {
      headingRef.current?.focus({ preventScroll: true });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [status.kind]);

  return (
    <StudyFlowShell
      progress={<StudyProgress currentPage="reconstruction" bare />}
      headerTrailing={
        <Button variant="ghost" size="sm" onClick={onSignOut}>
          <LogOutIcon aria-hidden />
          Sign out
        </Button>
      }
    >
      <Column
        align="center"
        justify="center"
        className="onboarding-step-enter onboarding-stagger mx-auto min-h-step max-w-xl text-center"
      >
        <span className="grid size-16 place-items-center rounded-2xl bg-sky-500/10 text-sky-700 ring-1 ring-sky-500/10">
          <Icon className="size-7" aria-hidden />
        </span>
        <Text
          as="h1"
          variant="title"
          ref={headingRef}
          tabIndex={-1}
          className="mt-6 outline-none sm:text-3xl"
        >
          {isWaitingForDay
            ? "No recorded day yet"
            : "The reconstruction opens in the evening"}
        </Text>
        <p className="mt-3 text-sm leading-7 text-muted-foreground sm:text-base">
          {isWaitingForDay ? (
            <>
              Once the camera has recorded your day, it will appear here for
              reconstruction in the evening. Please log out and return after
              your recording day.
            </>
          ) : (
            <>
              Please return in the evening, before you go to bed. Your
              reconstruction will be available from {status.availableFrom} at
              the earliest.
            </>
          )}
        </p>
        <Button className="mt-8" size="lg" onClick={onSignOut}>
          <LogOutIcon aria-hidden />
          Log out
        </Button>
      </Column>
    </StudyFlowShell>
  );
};
