"use client";

import { useRouter } from "next/navigation";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { CheckCircle2Icon, LockIcon, RefreshCwIcon } from "lucide-react";

import type { RoundState, StudyStateResponse } from "@/lib/api-types";
import {
  ApiError,
  clearStoredToken,
  getRound,
  getStudyState,
} from "@/lib/api-client";
import { formatHour } from "@/lib/time";
import { useRequireAuth } from "@/lib/use-require-auth";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { Skeleton } from "@/components/ui/skeleton";
import { RoundEditor } from "@/components/reconstruct/round-editor";
import { ReadOnlyActivityList } from "@/components/reconstruct/read-only-activity-list";
import { cn } from "@/lib/utils";

const RoundSkeleton = () => (
  <div className="space-y-3">
    <Skeleton className="h-6 w-48" />
    <Skeleton className="h-28 w-full rounded-xl" />
    <Skeleton className="h-28 w-full rounded-xl" />
    <Skeleton className="h-28 w-full rounded-xl" />
  </div>
);

/** Chip label for a step; round 2's mode stays hidden while it is locked. */
const stepLabel = (state: RoundState): string => {
  if (state.round === 1) return "Step 1 · From memory";
  if (state.mode === "assisted") return "Step 2 · With photos";
  if (state.mode === "self") return "Step 2 · From memory again";
  return "Step 2";
};

/** "Step 1 of 2 / Step 2 of 2" progress header for the fixed two-step flow. */
const StepProgress = ({
  rounds,
  activeRound,
}: {
  rounds: RoundState[];
  activeRound: 1 | 2 | null;
}) => (
  <div className="flex flex-wrap gap-2">
    {rounds.map((state) => {
      const isActive = state.round === activeRound;
      const isSubmitted = state.status === "submitted";
      return (
        <div
          key={state.round}
          className={cn(
            "flex items-center gap-2 rounded-xl border bg-card px-3 py-2 text-sm",
            isActive ? "border-primary ring-2 ring-primary/25" : "border-border",
            state.locked && "opacity-60",
          )}
        >
          {isSubmitted ? (
            <CheckCircle2Icon className="size-4 text-primary" aria-hidden />
          ) : state.locked ? (
            <LockIcon className="size-4 text-muted-foreground" aria-hidden />
          ) : null}
          <span className={cn("font-medium", !isActive && "text-muted-foreground")}>
            {stepLabel(state)}
          </span>
          {isSubmitted && <Badge variant="secondary">Submitted</Badge>}
        </div>
      );
    })}
  </div>
);

/** Read-only rendering of an already-submitted round (both-steps-done view). */
const SubmittedRoundSection = ({ roundState }: { roundState: RoundState }) => {
  const roundQuery = useQuery({
    queryKey: ["round", roundState.round],
    queryFn: () => getRound(roundState.round),
  });
  return (
    <section className="space-y-3">
      <div className="flex items-center gap-2">
        <h2 className="text-base font-semibold">{stepLabel(roundState)}</h2>
        <Badge variant="secondary">Submitted</Badge>
      </div>
      {roundQuery.isPending && <Skeleton className="h-28 w-full rounded-xl" />}
      {roundQuery.data !== undefined && (
        <ReadOnlyActivityList
          activities={roundQuery.data.activities}
          frames={roundQuery.data.frames ?? null}
        />
      )}
    </section>
  );
};

/** Loads and renders the currently editable round. */
const ActiveRoundView = ({
  round,
  onSubmitted,
}: {
  round: 1 | 2;
  onSubmitted: (round: 1 | 2) => void;
}) => {
  const queryClient = useQueryClient();
  const roundQuery = useQuery({
    queryKey: ["round", round],
    queryFn: () => getRound(round),
    // Always refetch on mount so the editor initializes from the server's
    // current draft (autosaved edits from an earlier visit).
    refetchOnMount: "always",
  });

  if (roundQuery.isLoading || roundQuery.isFetching) {
    return <RoundSkeleton />;
  }

  if (roundQuery.isError || roundQuery.data === undefined) {
    const message =
      roundQuery.error instanceof ApiError
        ? roundQuery.error.message
        : "Could not load this step.";
    return (
      <Alert variant="destructive">
        <AlertTitle>Could not load this step</AlertTitle>
        <AlertDescription>
          <p>{message}</p>
          <Button
            variant="outline"
            size="sm"
            className="mt-2"
            onClick={() => void roundQuery.refetch()}
          >
            Try again
          </Button>
        </AlertDescription>
      </Alert>
    );
  }

  const reconstruction = roundQuery.data;

  // Defense in depth: never mount the editor on an already-submitted round
  // (possible when the study-state answer is momentarily stale).
  if (reconstruction.status === "submitted") {
    return (
      <div className="space-y-4">
        <div className="flex items-center gap-2">
          <h2 className="text-lg font-semibold">This step is submitted</h2>
          <Badge variant="secondary">Submitted</Badge>
        </div>
        <ReadOnlyActivityList
          activities={reconstruction.activities}
          frames={reconstruction.frames ?? null}
        />
      </div>
    );
  }

  if (
    reconstruction.mode === "assisted" &&
    reconstruction.activities.length === 0 &&
    (reconstruction.vlmPendingCount ?? 0) > 0
  ) {
    return (
      <Alert>
        <AlertTitle>Your day is still being processed</AlertTitle>
        <AlertDescription>
          <p>
            The recordings of your day are still being prepared — please check
            back in a few minutes.
          </p>
          <Button
            variant="outline"
            size="sm"
            className="mt-2"
            onClick={() => {
              void queryClient.invalidateQueries({ queryKey: ["study-state"] });
              void roundQuery.refetch();
            }}
          >
            <RefreshCwIcon />
            Refresh
          </Button>
        </AlertDescription>
      </Alert>
    );
  }

  return (
    <RoundEditor
      round={round}
      mode={reconstruction.mode}
      day={reconstruction.day}
      initialActivities={reconstruction.activities}
      frames={reconstruction.frames ?? null}
      onSubmitted={() => onSubmitted(round)}
    />
  );
};

const ReconstructContent = () => {
  const router = useRouter();
  const queryClient = useQueryClient();
  const stateQuery = useQuery({
    queryKey: ["study-state"],
    queryFn: getStudyState,
    refetchOnMount: "always",
  });

  const state: StudyStateResponse | undefined = stateQuery.data;
  const round1 = state?.rounds.find((entry) => entry.round === 1);
  const round2 = state?.rounds.find((entry) => entry.round === 2);
  const activeRound: 1 | 2 | null =
    round1 === undefined || round2 === undefined
      ? null
      : round1.status !== "submitted"
        ? 1
        : round2.status !== "submitted"
          ? 2
          : null;

  const handleSignOut = () => {
    clearStoredToken();
    // Anti-leak on a shared browser: no cached rounds/frames may survive
    // into the next account's session.
    queryClient.clear();
    router.replace("/");
  };

  const handleRoundSubmitted = (round: 1 | 2) => {
    if (round === 2) {
      router.push("/survey");
      return;
    }
    // Step 1 -> step 2: the study-state invalidation (done by the editor)
    // flips activeRound; just bring the participant back to the top.
    window.scrollTo({ top: 0 });
  };

  return (
    <main className="mx-auto w-full max-w-4xl flex-1 space-y-6 px-4 py-8">
      <header className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <p className="text-xs font-medium tracking-widest text-muted-foreground">
            BLINKS — Day Reconstruction Study
          </p>
          <h1 className="text-xl font-semibold tracking-tight">
            Reconstruct your day
          </h1>
        </div>
        <Button variant="ghost" size="sm" onClick={handleSignOut}>
          Sign out
        </Button>
      </header>

      {stateQuery.isPending && (
        <div className="space-y-4">
          <div className="flex gap-2">
            <Skeleton className="h-10 w-44 rounded-xl" />
            <Skeleton className="h-10 w-44 rounded-xl" />
          </div>
          <RoundSkeleton />
        </div>
      )}

      {stateQuery.isError && (
        <Alert variant="destructive">
          <AlertTitle>Could not load your study progress</AlertTitle>
          <AlertDescription>
            <p>
              {stateQuery.error instanceof ApiError
                ? stateQuery.error.message
                : "Please check your connection or "}
                <a
                    href="mailto:felix-wang@outlook.de"
                    className="underline hover:text-foreground transition-colors"
                >
                    Contact
                </a>
                {" "}the study team
            </p>
            <Button
              variant="outline"
              size="sm"
              className="mt-2"
              onClick={() => void stateQuery.refetch()}
            >
              Try again
            </Button>
          </AlertDescription>
        </Alert>
      )}

      {state !== undefined && state.day === null && (
        <Alert>
          <AlertTitle>No recorded day yet</AlertTitle>
          <AlertDescription>
            Once the camera has recorded your day, it will appear here for
            reconstruction in the evening.
          </AlertDescription>
        </Alert>
      )}

      {state !== undefined && state.day !== null && !state.available && (
        <Alert>
          <AlertTitle>The survey opens in the evening</AlertTitle>
          <AlertDescription>
            Please start the survey in the evening, before you go to bed, but from {formatHour(state.availableFromHour)} at the earliest.
          </AlertDescription>
        </Alert>
      )}

      {state !== undefined &&
        state.day !== null &&
        state.available &&
        round1 !== undefined &&
        round2 !== undefined && (
          <>
            <StepProgress
              rounds={[round1, round2]}
              activeRound={activeRound}
            />
            <Separator />
            {activeRound !== null ? (
              <ActiveRoundView
                key={activeRound}
                round={activeRound}
                onSubmitted={handleRoundSubmitted}
              />
            ) : (
              <div className="space-y-6">
                <Alert>
                  <AlertTitle>Both steps are submitted</AlertTitle>
                  <AlertDescription>
                    <p>
                      Thank you! If you have not filled in the questionnaire
                      yet, please do so now.
                    </p>
                    <Button
                      size="sm"
                      className="mt-2"
                      onClick={() => router.push("/survey")}
                    >
                      Go to the questionnaire
                    </Button>
                  </AlertDescription>
                </Alert>
                <SubmittedRoundSection roundState={round1} />
                <SubmittedRoundSection roundState={round2} />
              </div>
            )}
          </>
        )}
    </main>
  );
};

const ReconstructPage = () => {
  const ready = useRequireAuth();
  if (!ready) return null;
  return <ReconstructContent />;
};

export default ReconstructPage;
