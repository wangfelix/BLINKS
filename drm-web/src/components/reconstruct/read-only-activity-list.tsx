"use client";

import { ImageOffIcon } from "lucide-react";

import type { Activity, Frame } from "@/lib/api-types";
import { frameImageSrc } from "@/lib/api-client";
import { formatTimeOfDay, formatTimeSpan } from "@/lib/time";
import { Badge } from "@/components/ui/badge";
import { Column, Row } from "@/components/layout/flex";
import { Text } from "@/components/layout/text";
import { sampleEvenly } from "@/components/reconstruct/editor-types";
import { frameIdentityKey } from "@/components/photos/use-photo-deletion";
import { activityDisplayLabel } from "@/lib/activity-vocabulary";

const THUMBNAIL_COUNT = 5;

const CATEGORY_DISPLAY: Record<string, string> = {
  work: "Work",
  break: "Break",
  other: "Other",
};

/** "Mental demand 4/7" / "Recovery 2/7" for the submitted view. */
const experienceRatingSummary = (activity: Activity): string | null => {
  if (activity.categoryLabel === "work" && activity.workloadRating !== null) {
    return `Mental demand ${activity.workloadRating}/7`;
  }
  if (activity.categoryLabel === "break" && activity.recoveryRating !== null) {
    return `Recovery ${activity.recoveryRating}/7`;
  }
  return null;
};

/** Frames within the activity's time span. */
const framesForActivity = (
  activity: Activity,
  frames: Frame[] | null,
): Frame[] => {
  if (frames === null) return [];
  return frames.filter(
    (frame) =>
      frame.captureEpochMs >= activity.startMs &&
      frame.captureEpochMs < activity.endMs,
  );
};

const ReadOnlyActivityCard = ({
  activity,
  frames,
}: {
  activity: Activity;
  frames: Frame[] | null;
}) => {
  const activityFrames = framesForActivity(activity, frames);
  const thumbnails = sampleEvenly(activityFrames, THUMBNAIL_COUNT);
  const hasLivePhotos = activityFrames.some(
    (frame) => frame.deletedAt === null,
  );
  const ratingSummary = experienceRatingSummary(activity);
  return (
    <Column gap="md" className="rounded-xl border bg-card p-4">
      <Row gap="md" align="center" wrap>
        <span className="text-sm font-medium tabular-nums">
          {formatTimeSpan(activity.startMs, activity.endMs)}
        </span>
        <span className="flex-1 text-sm">
          {activityDisplayLabel(activity.rawLabel) ?? "—"}
        </span>
        {ratingSummary !== null && (
          <Text variant="nudge" className="tabular-nums">
            {ratingSummary}
          </Text>
        )}
        {activity.categoryLabel !== null && (
          <Badge variant="secondary">
            {CATEGORY_DISPLAY[activity.categoryLabel] ?? activity.categoryLabel}
          </Badge>
        )}
      </Row>
      {thumbnails.length > 0 && (
        <Row gap="sm" className="overflow-x-auto pb-1">
          {thumbnails.map((frame) => (
            <figure key={frameIdentityKey(frame)} className="w-20 shrink-0">
              {frame.deletedAt !== null ? (
                <div className="flex aspect-[4/3] w-full flex-col items-center justify-center gap-0.5 rounded-md border bg-muted text-muted-foreground">
                  <ImageOffIcon className="size-4" aria-hidden />
                  <span className="text-[9px] font-medium">Deleted</span>
                </div>
              ) : (
                /* eslint-disable-next-line @next/next/no-img-element -- authenticated cross-origin image; the Next image proxy cannot forward the auth cookie */
                <img
                  src={frameImageSrc(frame.imageUrl!)}
                  alt={`Frame at ${formatTimeOfDay(frame.captureEpochMs)}`}
                  loading="lazy"
                  className="aspect-[4/3] w-full rounded-md border bg-muted object-cover"
                />
              )}
              <figcaption className="mt-0.5 text-center text-[10px] text-muted-foreground tabular-nums">
                {formatTimeOfDay(frame.captureEpochMs)}
              </figcaption>
            </figure>
          ))}
        </Row>
      )}
      {frames !== null && !hasLivePhotos && (
        <Text variant="secondary" className="text-sm">
          {activityFrames.length === 0
            ? "No images available"
            : "No images remaining"}
        </Text>
      )}
    </Column>
  );
};

/** Read-only rendering of a submitted day's activities. */
export const ReadOnlyActivityList = ({
  activities,
  frames,
}: {
  activities: Activity[];
  frames: Frame[] | null;
}) => {
  if (activities.length === 0) {
    return (
      <Text variant="secondary" className="py-8 text-center">
        No activities were recorded for this day.
      </Text>
    );
  }

  return (
    <Column gap="md">
      {activities.map((activity) => (
        <ReadOnlyActivityCard
          key={`${activity.startMs}-${activity.endMs}-${activity.position}`}
          activity={activity}
          frames={frames}
        />
      ))}
    </Column>
  );
};
