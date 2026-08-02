"use client";

import { useRouter } from "next/navigation";
import {
  useQuery,
  useQueryClient,
  type UseQueryResult,
} from "@tanstack/react-query";
import { RefreshCwIcon } from "lucide-react";

import type { RoundState, StudyStateResponse } from "@/lib/api-types";
import { ApiError, getRound, getStudyState } from "@/lib/api-client";
import { formatHour } from "@/lib/time";
import { useRequireAuth } from "@/lib/use-require-auth";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Column, Row } from "@/components/layout/flex";
import { Text } from "@/components/layout/text";
import { StudyTeamContactLink } from "@/components/study-team-contact-link";
import { RoundEditor } from "@/components/reconstruct/round-editor";
import { ReadOnlyActivityList } from "@/components/reconstruct/read-only-activity-list";
import { CategoryLegendCard } from "@/components/reconstruct/category-legend-card";
import { StudyNavbar } from "@/components/study-navbar";
import { StudyProgress } from "@/components/study-progress";

/** The round the participant works on next; null once both are submitted. */
const firstUnsubmittedRound = (
  round1: RoundState,
  round2: RoundState,
): 1 | 2 | null => {
  if (round1.status !== "submitted") return 1;
  if (round2.status !== "submitted") return 2;
  return null;
};

const stepLabel = (roundState: RoundState): string => {
  if (roundState.round === 1) return "Step 1 · From memory";
  return "Step 2 · With photos";
};

const RoundSkeleton = () => (
  <Column gap="md">
    <Skeleton className="h-6 w-48" />
    <Skeleton className="h-28 w-full rounded-xl" />
    <Skeleton className="h-28 w-full rounded-xl" />
    <Skeleton className="h-28 w-full rounded-xl" />
  </Column>
);

const StudyStateSkeleton = () => <RoundSkeleton />;

const StudyStateErrorAlert = ({
  error,
  onRetry,
}: {
  error: unknown;
  onRetry: () => void;
}) => (
  <Alert variant="destructive">
    <AlertTitle>Could not load your study progress</AlertTitle>
    <AlertDescription>
      <Text variant="inherit">
        {error instanceof ApiError
          ? error.message
          : "Please check your connection or "}
        <StudyTeamContactLink /> the study team
      </Text>
      <Button variant="outline" size="sm" className="mt-2" onClick={onRetry}>
        Try again
      </Button>
    </AlertDescription>
  </Alert>
);

const NoRecordedDayNotice = () => (
  <Alert>
    <AlertTitle>No recorded day yet</AlertTitle>
    <AlertDescription>
      Once the camera has recorded your day, it will appear here for
      reconstruction in the evening.
    </AlertDescription>
  </Alert>
);

const OpensInTheEveningNotice = ({
  availableFromHour,
}: {
  availableFromHour: number;
}) => (
  <Alert>
    <AlertTitle>The survey opens in the evening</AlertTitle>
    <AlertDescription>
      Please start the survey in the evening, before you go to bed, but from{" "}
      {formatHour(availableFromHour)} at the earliest.
    </AlertDescription>
  </Alert>
);

/** Read-only rendering of an already-submitted round (both-steps-done view). */
const SubmittedRoundSection = ({ roundState }: { roundState: RoundState }) => {
  const roundQuery = useQuery({
    queryKey: ["round", roundState.round],
    queryFn: () => getRound(roundState.round),
  });
  return (
    <section className="space-y-3">
      <Row gap="sm" align="center">
        <h2 className="text-base font-semibold">{stepLabel(roundState)}</h2>
        <Badge variant="secondary">Submitted</Badge>
      </Row>
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

const BothStepsSubmittedView = ({
  round1,
  round2,
  onGoToSurvey,
}: {
  round1: RoundState;
  round2: RoundState;
  onGoToSurvey: () => void;
}) => (
  <Column gap="xl">
    <Alert>
      <AlertTitle>Both steps are submitted</AlertTitle>
      <AlertDescription>
        <Text variant="inherit">
          Thank you! If you have not filled in the questionnaire yet, please do
          so now.
        </Text>
        <Button size="sm" className="mt-2" onClick={onGoToSurvey}>
          Go to the questionnaire
        </Button>
      </AlertDescription>
    </Alert>
    <SubmittedRoundSection roundState={round1} />
    <SubmittedRoundSection roundState={round2} />
  </Column>
);

/** Loads and renders the currently editable round. */
export const ActiveRoundView = ({
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
          <Text variant="inherit">{message}</Text>
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
  const isAlreadySubmitted = reconstruction.status === "submitted";
  if (isAlreadySubmitted) {
    return (
      <Column gap="lg">
        <Row gap="sm" align="center">
          <h2 className="text-lg font-semibold">This step is submitted</h2>
          <Badge variant="secondary">Submitted</Badge>
        </Row>
        <ReadOnlyActivityList
          activities={reconstruction.activities}
          frames={reconstruction.frames ?? null}
        />
      </Column>
    );
  }

  const isWaitingForRecordingEnd =
    reconstruction.round === 2 &&
    reconstruction.activities.length === 0 &&
    reconstruction.recordingEnded === false;
  if (isWaitingForRecordingEnd) {
    return (
      <Alert>
        <AlertTitle>Please end the recording first</AlertTitle>
        <AlertDescription>
          <Text variant="inherit">
            End today&apos;s recording in the BLINKS phone app. Your assisted
            activity list will be prepared after the final photos are processed.
          </Text>
          <Button
            variant="outline"
            size="sm"
            className="mt-2"
            onClick={() => void roundQuery.refetch()}
          >
            <RefreshCwIcon />
            Refresh
          </Button>
        </AlertDescription>
      </Alert>
    );
  }

  const isStillWaitingForVlmLabels =
    reconstruction.round === 2 &&
    reconstruction.activities.length === 0 &&
    (reconstruction.vlmPendingCount ?? 0) > 0;
  if (isStillWaitingForVlmLabels) {
    return (
      <Alert>
        <AlertTitle>Your day is still being processed</AlertTitle>
        <AlertDescription>
          <Text variant="inherit">
            The recordings of your day are still being prepared — please check
            back in a few minutes.
          </Text>
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
      day={reconstruction.day}
      initialActivities={reconstruction.activities}
      frames={reconstruction.frames ?? null}
      onSubmitted={() => onSubmitted(round)}
    />
  );
};

/** Everything below the page header; each study state gets its own view. */
const StudyStateView = ({
  stateQuery,
  onRoundSubmitted,
  onGoToSurvey,
}: {
  stateQuery: UseQueryResult<StudyStateResponse, Error>;
  onRoundSubmitted: (round: 1 | 2) => void;
  onGoToSurvey: () => void;
}) => {
  if (stateQuery.isPending) {
    return <StudyStateSkeleton />;
  }
  if (stateQuery.isError) {
    return (
      <StudyStateErrorAlert
        error={stateQuery.error}
        onRetry={() => void stateQuery.refetch()}
      />
    );
  }

  const state = stateQuery.data;
  const hasRecordedDay = state.day !== null;
  const isOpenForReconstruction = state.available;
  const round1 = state.rounds.find((entry) => entry.round === 1);
  const round2 = state.rounds.find((entry) => entry.round === 2);

  if (!hasRecordedDay) {
    return <NoRecordedDayNotice />;
  }
  if (!isOpenForReconstruction) {
    return (
      <OpensInTheEveningNotice availableFromHour={state.availableFromHour} />
    );
  }
  if (round1 === undefined || round2 === undefined) {
    // The server always sends both rounds; nothing sensible to render if not.
    return null;
  }

  const activeRound = firstUnsubmittedRound(round1, round2);

  return (
    <Row gap="xl" align="start">
      <Column gap="xl" className="min-w-0 flex-1">
        {activeRound === null ? (
          <BothStepsSubmittedView
            round1={round1}
            round2={round2}
            onGoToSurvey={onGoToSurvey}
          />
        ) : (
          <ActiveRoundView
            key={activeRound}
            round={activeRound}
            onSubmitted={onRoundSubmitted}
          />
        )}
        {/* Small screens: no room for a side panel, so the legend stacks
            below the editor instead. */}
        <CategoryLegendCard className="lg:hidden" />
      </Column>
      <aside className="sticky top-8 hidden w-64 shrink-0 lg:block">
        <CategoryLegendCard />
      </aside>
    </Row>
  );
};

const ReconstructContent = () => {
  const router = useRouter();
  const stateQuery = useQuery({
    queryKey: ["study-state"],
    queryFn: getStudyState,
    refetchOnMount: "always",
  });

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
    <main className="flex w-full flex-1 flex-col">
      <StudyNavbar />
      <StudyProgress currentPage="reconstruction" />

      <section className="mx-auto w-full max-w-4xl flex-1 px-4 py-8 lg:max-w-6xl">
        <StudyStateView
          stateQuery={stateQuery}
          onRoundSubmitted={handleRoundSubmitted}
          onGoToSurvey={() => router.push("/survey")}
        />
      </section>
    </main>
  );
};

const ReconstructPage = () => {
  const ready = useRequireAuth();
  if (!ready) return null;
  return <ReconstructContent />;
};

export default ReconstructPage;
