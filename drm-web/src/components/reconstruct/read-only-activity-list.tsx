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
import { categoryDisplayLabel } from "@/lib/category-vocabulary";
import {
  experienceItemsForCategory,
  thumbnailsPerActivity,
} from "@/lib/study-config-store";
import { experienceRatingSummaryLabel } from "@/components/reconstruct/experience-rating-scale";

/** "Mental demand 4/7" / "Recovery 2/7" for the submitted view. */
const experienceRatingSummary = (activity: Activity): string | null => {
  const summaries = experienceItemsForCategory(activity.categoryLabel).flatMap(
    (item) => {
      const value = activity.ratings[item.key] ?? null;
      return value === null ? [] : [experienceRatingSummaryLabel(item, value)];
    },
  );
  return summaries.length === 0 ? null : summaries.join(" · ");
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
  const thumbnails = sampleEvenly(activityFrames, thumbnailsPerActivity());
  const hasLivePhotos = activityFrames.some(
    (frame) => frame.deletedAt === null,
  );
  const ratingSummary = experienceRatingSummary(activity);
  return (
    <Column gap="md" className="rounded-xl border bg-card p-4">
      <Row gap="md" align="center" wrap>
        <Text as="span" variant="label" className="tabular-nums">
          {formatTimeSpan(activity.startMs, activity.endMs)}
        </Text>
        <Text as="span" tone="inherit" className="flex-1">
          {activityDisplayLabel(activity.rawLabel) ?? "—"}
        </Text>
        {ratingSummary !== null && (
          <Text variant="caption" className="tabular-nums">
            {ratingSummary}
          </Text>
        )}
        {activity.categoryLabel !== null && (
          <Badge variant="secondary">
            {categoryDisplayLabel(activity.categoryLabel)}
          </Badge>
        )}
      </Row>
      {thumbnails.length > 0 && (
        <Row gap="sm" className="overflow-x-auto pb-1">
          {thumbnails.map((frame) => (
            <figure key={frameIdentityKey(frame)} className="w-20 shrink-0">
              {frame.deletedAt !== null ? (
                <Column
                  gap="2xs"
                  align="center"
                  justify="center"
                  className="aspect-photo w-full rounded-md border bg-muted text-muted-foreground"
                >
                  <ImageOffIcon className="size-4" aria-hidden />
                  <Text as="span" variant="small" className="text-4xs">
                    Deleted
                  </Text>
                </Column>
              ) : (
                /* eslint-disable-next-line @next/next/no-img-element -- authenticated cross-origin image; the Next image proxy cannot forward the auth cookie */
                <img
                  src={frameImageSrc(frame.imageUrl!)}
                  alt={`Frame at ${formatTimeOfDay(frame.captureEpochMs)}`}
                  loading="lazy"
                  className="aspect-photo w-full rounded-md border bg-muted object-cover"
                />
              )}
              <figcaption className="mt-0.5 text-center text-3xs text-muted-foreground tabular-nums">
                {formatTimeOfDay(frame.captureEpochMs)}
              </figcaption>
            </figure>
          ))}
        </Row>
      )}
      {frames !== null && !hasLivePhotos && (
        <Text tone="muted" className="text-sm">
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
      <Text tone="muted" className="py-8 text-center">
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
