"use client";

import { useQuery } from "@tanstack/react-query";
import { CheckIcon, LockIcon } from "lucide-react";

import type { RoundState } from "@/lib/api-types";
import { getStudyState } from "@/lib/api-client";
import { getStudyConfig } from "@/lib/study-config-store";
import { Skeleton } from "@/components/ui/skeleton";
import { Column } from "@/components/layout/flex";
import { Grid } from "@/components/layout/grid";
import { Container } from "@/components/layout/container";
import { mergeClassNames } from "@/lib/utils";

type StudyPage = "reconstruction" | "surveys";
type StepNumber = 1 | 2 | 3;
type StepState = "completed" | "active" | "locked" | "pending";

interface DisplayStep {
  number: StepNumber;
  label: string;
  state: StepState;
}

const firstUnsubmittedRound = (
  round1: RoundState,
  round2: RoundState,
): 1 | 2 | null => {
  if (round1.status !== "submitted") return 1;
  if (round2.status !== "submitted") return 2;
  return null;
};

const roundLabel = (round: 1 | 2): string => {
  const texts = getStudyConfig().texts.progress;
  return round === 1 ? texts.selfRound : texts.assistedRound;
};

const roundStepState = (
  roundState: RoundState,
  activeRound: 1 | 2 | null,
): StepState => {
  if (roundState.status === "submitted") return "completed";
  if (roundState.round === activeRound) return "active";
  if (roundState.locked) return "locked";
  return "pending";
};

const StepperSkeleton = () => (
  <Grid cols={3} className="relative mx-auto w-full max-w-[440px] py-2.5">
    <div
      className="absolute top-6 right-1/6 left-1/6 h-px bg-border"
      aria-hidden
    />
    {[1, 2, 3].map((step) => (
      <Column key={step} align="center" className="relative z-10 gap-1.5">
        <Skeleton className="size-7 rounded-full" />
        <Skeleton className="h-3 w-20" />
      </Column>
    ))}
  </Grid>
);

const Stepper = ({ steps }: { steps: DisplayStep[] }) => {
  const firstConnectorComplete = steps[0]?.state === "completed";
  const secondConnectorComplete = steps[1]?.state === "completed";

  return (
    <Container className="relative max-w-[440px] py-2.5">
      <div
        className={mergeClassNames(
          "absolute top-6 left-1/6 h-px w-1/3",
          firstConnectorComplete ? "bg-primary" : "bg-border",
        )}
        aria-hidden
      />
      <div
        className={mergeClassNames(
          "absolute top-6 right-1/6 h-px w-1/3",
          secondConnectorComplete ? "bg-primary" : "bg-border",
        )}
        aria-hidden
      />

      <ol className="relative grid grid-cols-3">
        {steps.map((step) => {
          const isCompleted = step.state === "completed";
          const isActive = step.state === "active";

          return (
            <li
              key={step.number}
              className="flex min-w-0 flex-col items-center text-center"
              aria-current={isActive ? "step" : undefined}
            >
              <span
                className={mergeClassNames(
                  "relative z-10 flex size-7 items-center justify-center rounded-full border-2 text-xs font-semibold",
                  (isActive || isCompleted) &&
                    "border-primary bg-primary text-primary-foreground",
                  !isActive &&
                    !isCompleted &&
                    "border-border bg-background text-muted-foreground",
                  isActive &&
                    "ring-1 ring-primary/30 ring-offset-1 ring-offset-muted",
                )}
              >
                {isCompleted ? (
                  <CheckIcon className="size-4" aria-hidden />
                ) : step.state === "locked" ? (
                  <LockIcon className="size-3.5" aria-hidden />
                ) : (
                  step.number
                )}
              </span>
              <span
                className={mergeClassNames(
                  "mt-1.5 px-1 text-xs leading-4 font-medium",
                  !isActive && !isCompleted && "text-muted-foreground",
                )}
              >
                {step.label}
              </span>
            </li>
          );
        })}
      </ol>
    </Container>
  );
};

export const StudyProgress = ({
  currentPage,
  bare = false,
  activeRoundOverride,
}: {
  currentPage: StudyPage;
  bare?: boolean;
  activeRoundOverride?: 1 | 2;
}) => {
  const stateQuery = useQuery({
    queryKey: ["study-state"],
    queryFn: getStudyState,
    enabled: activeRoundOverride === undefined,
  });

  let progressContent = <StepperSkeleton />;
  if (activeRoundOverride !== undefined) {
    progressContent = (
      <Stepper
        steps={[
          {
            number: 1,
            label: roundLabel(1),
            state: activeRoundOverride === 1 ? "active" : "completed",
          },
          {
            number: 2,
            label: roundLabel(2),
            state: activeRoundOverride === 2 ? "active" : "locked",
          },
          { number: 3, label: "Surveys", state: "pending" },
        ]}
      />
    );
  } else if (stateQuery.data !== undefined) {
    const round1 = stateQuery.data.rounds.find((entry) => entry.round === 1);
    const round2 = stateQuery.data.rounds.find((entry) => entry.round === 2);

    if (round1 !== undefined && round2 !== undefined) {
      const activeRound = firstUnsubmittedRound(round1, round2);
      const isSurveysPage = currentPage === "surveys";
      const steps: DisplayStep[] = [
        {
          number: 1,
          label: roundLabel(1),
          state: isSurveysPage
            ? "completed"
            : roundStepState(round1, activeRound),
        },
        {
          number: 2,
          label: roundLabel(2),
          state: isSurveysPage
            ? "completed"
            : roundStepState(round2, activeRound),
        },
        {
          number: 3,
          label: "Surveys",
          state: isSurveysPage ? "active" : "pending",
        },
      ];
      progressContent = <Stepper steps={steps} />;
    }
  }

  if (bare) {
    return <section aria-label="Study progress">{progressContent}</section>;
  }

  return (
    <section className="border-b bg-muted" aria-label="Study progress">
      <div className="px-4">{progressContent}</div>
    </section>
  );
};
