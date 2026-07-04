"use client";

import type { Activity, Frame } from "@/lib/api-types";
import { frameImageSrc } from "@/lib/api-client";
import { formatTimeOfDay, formatTimeSpan } from "@/lib/time";
import { Badge } from "@/components/ui/badge";
import { sampleEvenly } from "@/components/reconstruct/editor-types";

const THUMBNAIL_COUNT = 5;

const CATEGORY_DISPLAY: Record<string, string> = {
  work: "Work",
  break: "Break",
  other: "Other",
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
      <p className="py-8 text-center text-sm text-muted-foreground">
        No activities were recorded for this day.
      </p>
    );
  }

  return (
    <div className="space-y-3">
      {activities.map((activity) => {
        const thumbnails =
          frames === null
            ? []
            : sampleEvenly(
                frames.filter(
                  (frame) =>
                    frame.captureEpochMs >= activity.startMs &&
                    frame.captureEpochMs <= activity.endMs,
                ),
                THUMBNAIL_COUNT,
              );
        return (
          <div
            key={`${activity.startMs}-${activity.endMs}-${activity.position}`}
            className="space-y-3 rounded-xl border bg-card p-4"
          >
            <div className="flex flex-wrap items-center gap-3">
              <span className="font-mono text-sm font-medium tabular-nums">
                {formatTimeSpan(activity.startMs, activity.endMs)}
              </span>
              <span className="flex-1 text-sm">
                {activity.rawLabel ?? "—"}
              </span>
              {activity.categoryLabel !== null && (
                <Badge variant="secondary">
                  {CATEGORY_DISPLAY[activity.categoryLabel] ??
                    activity.categoryLabel}
                </Badge>
              )}
            </div>
            {thumbnails.length > 0 && (
              <div className="flex gap-2 overflow-x-auto pb-1">
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
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
};
