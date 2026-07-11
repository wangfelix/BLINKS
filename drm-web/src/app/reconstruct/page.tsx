"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { RefreshCwIcon } from "lucide-react";

import type { ReconstructionDay } from "@/lib/api-types";
import {
  ApiError,
  clearStoredToken,
  getReconstruction,
  getReconstructionDays,
} from "@/lib/api-client";
import { formatHour } from "@/lib/time";
import { useRequireAuth } from "@/lib/use-require-auth";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { Skeleton } from "@/components/ui/skeleton";
import { DayEditor } from "@/components/reconstruct/day-editor";
import { DaySwitcher } from "@/components/reconstruct/day-switcher";
import { ReadOnlyActivityList } from "@/components/reconstruct/read-only-activity-list";

const DaySkeleton = () => (
  <div className="space-y-3">
    <Skeleton className="h-6 w-48" />
    <Skeleton className="h-28 w-full rounded-xl" />
    <Skeleton className="h-28 w-full rounded-xl" />
    <Skeleton className="h-28 w-full rounded-xl" />
  </div>
);

/** Loads and renders one selected day (editor, read-only, or banner states). */
const DayView = ({ dayInfo }: { dayInfo: ReconstructionDay }) => {
  const queryClient = useQueryClient();
  const reconstructionQuery = useQuery({
    queryKey: ["reconstruction", dayInfo.day],
    queryFn: () => getReconstruction(dayInfo.day),
    // Always refetch on mount so the editor initializes from the server's
    // current draft (local edits of a previously viewed day were autosaved).
    refetchOnMount: "always",
  });

  if (reconstructionQuery.isLoading || reconstructionQuery.isFetching) {
    return <DaySkeleton />;
  }

  if (reconstructionQuery.isError || reconstructionQuery.data === undefined) {
    const message =
      reconstructionQuery.error instanceof ApiError
        ? reconstructionQuery.error.message
        : "Could not load this day.";
    return (
      <Alert variant="destructive">
        <AlertTitle>Could not load this day</AlertTitle>
        <AlertDescription>
          <p>{message}</p>
          <Button
            variant="outline"
            size="sm"
            className="mt-2"
            onClick={() => void reconstructionQuery.refetch()}
          >
            Try again
          </Button>
        </AlertDescription>
      </Alert>
    );
  }

  const reconstruction = reconstructionQuery.data;

  if (reconstruction.status === "submitted") {
    return (
      <div className="space-y-4">
        <div className="flex items-center gap-2">
          <h2 className="text-lg font-semibold">
            Reconstruction for this day
          </h2>
          <Badge variant="secondary">Submitted</Badge>
        </div>
        <p className="text-sm text-muted-foreground">
          This day has been submitted and can no longer be edited.
        </p>
        <ReadOnlyActivityList
          activities={reconstruction.activities}
          frames={reconstruction.frames ?? null}
        />
      </div>
    );
  }

  if (
    reconstruction.condition === "assisted" &&
    reconstruction.activities.length === 0 &&
    dayInfo.vlmPendingCount > 0
  ) {
    return (
      <Alert>
        <AlertTitle>Your day is still being processed</AlertTitle>
        <AlertDescription>
          <p>
            The recordings of this day are still being prepared — please check
            back in a few minutes.
          </p>
          <Button
            variant="outline"
            size="sm"
            className="mt-2"
            onClick={() => {
              void queryClient.invalidateQueries({
                queryKey: ["reconstruction-days"],
              });
              void reconstructionQuery.refetch();
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
    <DayEditor
      day={reconstruction.day}
      condition={reconstruction.condition}
      initialActivities={reconstruction.activities}
      frames={reconstruction.frames ?? null}
    />
  );
};

const ReconstructContent = () => {
  const router = useRouter();
  const daysQuery = useQuery({
    queryKey: ["reconstruction-days"],
    queryFn: getReconstructionDays,
  });
  const [selectedDay, setSelectedDay] = useState<string | null>(null);

  const days = daysQuery.data?.days;

  // Preselect the most recent available, not-yet-submitted day (list is
  // sorted day-descending by the server).
  useEffect(() => {
    if (days === undefined || selectedDay !== null) return;
    const preferred =
      days.find((day) => day.available && day.status !== "submitted") ??
      days.find((day) => day.available) ??
      null;
    if (preferred !== null) setSelectedDay(preferred.day);
  }, [days, selectedDay]);

  const selectedDayInfo =
    days?.find((day) => day.day === selectedDay) ?? null;

  const handleSignOut = () => {
    clearStoredToken();
    router.replace("/");
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

      {daysQuery.isPending && (
        <div className="flex gap-2">
          <Skeleton className="h-14 w-40 rounded-xl" />
          <Skeleton className="h-14 w-40 rounded-xl" />
        </div>
      )}

      {daysQuery.isError && (
        <Alert variant="destructive">
          <AlertTitle>Could not load your study days</AlertTitle>
          <AlertDescription>
            <p>
              {daysQuery.error instanceof ApiError
                ? daysQuery.error.message
                : "Please check your connection (KIT VPN) and try again."}
            </p>
            <Button
              variant="outline"
              size="sm"
              className="mt-2"
              onClick={() => void daysQuery.refetch()}
            >
              Try again
            </Button>
          </AlertDescription>
        </Alert>
      )}

      {days !== undefined && days.length === 0 && (
        <Alert>
          <AlertTitle>No recorded days yet</AlertTitle>
          <AlertDescription>
            Once the camera has recorded a day, it will appear here for
            reconstruction in the evening.
          </AlertDescription>
        </Alert>
      )}

      {days !== undefined && days.length > 0 && (
        <>
          <DaySwitcher
            days={days}
            selectedDay={selectedDay}
            onSelect={setSelectedDay}
          />
          <Separator />
          {selectedDayInfo === null ? (
            <Alert>
              <AlertTitle>No day is available yet</AlertTitle>
              <AlertDescription>
                Today&apos;s reconstruction opens in the evening
                {days[0] !== undefined &&
                  ` (from ${formatHour(days[0].availableFromHour)})`}
                . Past days stay available at any time.
              </AlertDescription>
            </Alert>
          ) : (
            <DayView key={selectedDayInfo.day} dayInfo={selectedDayInfo} />
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
