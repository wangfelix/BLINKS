"use client";

import type { Activity, Frame } from "@/lib/api-types";
import { frameImageSrc } from "@/lib/api-client";
import { formatTimeOfDay, formatTimeSpan } from "@/lib/time";
import { Badge } from "@/components/ui/badge";
import { Column, Row } from "@/components/layout/flex";
import { Text } from "@/components/layout/text";
import { sampleEvenly } from "@/components/reconstruct/editor-types";

const THUMBNAIL_COUNT = 5;

const CATEGORY_DISPLAY: Record<string, string> = {
  work: "Work",
  break: "Break",
  other: "Other",
};

/** Frames within the activity's time span, thinned to a preview strip. */
const thumbnailsForActivity = (
  activity: Activity,
  frames: Frame[] | null,
): Frame[] => {
  if (frames === null) return [];
  const framesInSpan = frames.filter(
    (frame) =>
      frame.captureEpochMs >= activity.startMs &&
      frame.captureEpochMs <= activity.endMs,
  );
  return sampleEvenly(framesInSpan, THUMBNAIL_COUNT);
};

const ReadOnlyActivityCard = ({
  activity,
  frames,
}: {
  activity: Activity;
  frames: Frame[] | null;
}) => {
  const thumbnails = thumbnailsForActivity(activity, frames);
  return (
    <Column gap="md" className="rounded-xl border bg-card p-4">
      <Row gap="md" align="center" wrap>
        <span className="text-sm font-medium tabular-nums">
          {formatTimeSpan(activity.startMs, activity.endMs)}
        </span>
        <span className="flex-1 text-sm">{activity.rawLabel ?? "—"}</span>
        {activity.categoryLabel !== null && (
          <Badge variant="secondary">
            {CATEGORY_DISPLAY[activity.categoryLabel] ?? activity.categoryLabel}
          </Badge>
        )}
      </Row>
      {thumbnails.length > 0 && (
        <Row gap="sm" className="overflow-x-auto pb-1">
          {thumbnails.map((frame) => (
            <figure key={frame.captureEpochMs} className="w-20 shrink-0">
              {/* eslint-disable-next-line @next/next/no-img-element -- authenticated cross-origin image; the Next image proxy cannot forward the auth cookie */}
              <img
                src={frameImageSrc(frame.imageUrl)}
                alt={`Frame at ${formatTimeOfDay(frame.captureEpochMs)}`}
                loading="lazy"
                className="aspect-[4/3] w-full rounded-md border bg-muted object-cover"
              />
              <figcaption className="mt-0.5 text-center text-[10px] text-muted-foreground tabular-nums">
                {formatTimeOfDay(frame.captureEpochMs)}
              </figcaption>
            </figure>
          ))}
        </Row>
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
