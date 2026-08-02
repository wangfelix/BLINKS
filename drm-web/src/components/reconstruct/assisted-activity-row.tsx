"use client";

import { useMemo, type ReactNode } from "react";
import { ImageOffIcon, Trash2Icon } from "lucide-react";

import type {
  ActivityLabel,
  CategoryLabel,
  ExperienceRating,
  Frame,
} from "@/lib/api-types";
import { frameImageSrc } from "@/lib/api-client";
import { mergeClassNames } from "@/lib/utils";
import { formatTimeOfDay, formatTimeSpan } from "@/lib/time";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Text } from "@/components/layout/text";
import { CategorySelect } from "@/components/reconstruct/category-select";
import { ActivitySelect } from "@/components/reconstruct/activity-select";
import {
  ExperienceRatingScale,
  type RatedCategory,
} from "@/components/reconstruct/experience-rating-scale";
import {
  sampleEvenly,
  type EditableActivity,
} from "@/components/reconstruct/editor-types";
import { frameIdentityKey } from "@/components/photos/use-photo-deletion";

const THUMBNAIL_COUNT = 5;

const AssistedFieldRow = ({
  label,
  htmlFor,
  invalid,
  className,
  children,
}: {
  label: string;
  htmlFor: string;
  invalid: boolean;
  className?: string;
  children: ReactNode;
}) => (
  <div
    className={mergeClassNames(
      "grid gap-2 sm:grid-cols-[minmax(0,1fr)_20rem] sm:items-center sm:gap-6",
      className,
    )}
  >
    <Label htmlFor={htmlFor} color={invalid ? "destructive" : undefined}>
      {label}
    </Label>
    <div className="w-full min-w-0 sm:w-80 sm:justify-self-end">{children}</div>
  </div>
);

/** One assisted-condition activity row: time span, frame thumbnails, labels. */
export const AssistedActivityRow = ({
  activity,
  dayFrames,
  issue,
  highlightIssues,
  onChangeLabel,
  onChangeCategory,
  onChangeExperienceRating,
  onDelete,
  onAdjustBoundaries,
  onViewPhotos,
}: {
  activity: EditableActivity;
  dayFrames: Frame[];
  issue: string | null;
  highlightIssues: boolean;
  onChangeLabel: (rawLabel: ActivityLabel) => void;
  onChangeCategory: (category: CategoryLabel) => void;
  onChangeExperienceRating: (
    category: RatedCategory,
    rating: ExperienceRating,
  ) => void;
  onDelete: () => void;
  onAdjustBoundaries: () => void;
  onViewPhotos: (initialFrame?: Frame) => void;
}) => {
  const startMs = activity.startMs ?? 0;
  const endMs = activity.endMs ?? 0;
  const framesInSpan = useMemo(
    () =>
      dayFrames.filter(
        (frame) =>
          frame.captureEpochMs >= startMs && frame.captureEpochMs <= endMs,
      ),
    [dayFrames, endMs, startMs],
  );
  const thumbnails = useMemo(
    () => sampleEvenly(framesInSpan, THUMBNAIL_COUNT),
    [framesInSpan],
  );
  const hasLivePhotos = useMemo(
    () => framesInSpan.some((frame) => frame.deletedAt === null),
    [framesInSpan],
  );
  const isLabelMissing = highlightIssues && activity.rawLabel === null;
  const isCategoryMissing = highlightIssues && activity.categoryLabel === null;
  const showIssueMessage = highlightIssues && issue !== null;
  const ratedCategory: RatedCategory | null =
    activity.categoryLabel === "work" || activity.categoryLabel === "break"
      ? activity.categoryLabel
      : null;
  const experienceRating =
    ratedCategory === "work"
      ? activity.workloadRating
      : activity.recoveryRating;

  return (
    <article
      className={mergeClassNames(
        "overflow-hidden rounded-2xl border bg-card [contain-intrinsic-size:auto_23rem] [content-visibility:auto]",
        activity.isIncorrectAnnotationInjected &&
          "border-yellow-200 bg-yellow-50 dark:border-yellow-900 dark:bg-yellow-950/20",
      )}
    >
      <div className="relative isolate overflow-hidden bg-muted">
        {thumbnails.length > 0 ? (
          <div className="flex h-40 overflow-x-auto sm:h-44">
            {thumbnails.map((frame) => (
              <figure
                key={frameIdentityKey(frame)}
                className="relative w-36 shrink-0 overflow-hidden border-r border-background/40 last:border-r-0 sm:min-w-0 sm:flex-1"
              >
                <button
                  type="button"
                  className="block size-full bg-muted focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none focus-visible:ring-inset"
                  aria-label={
                    frame.deletedAt === null
                      ? `View all photos, starting at ${formatTimeOfDay(frame.captureEpochMs)}`
                      : `View deleted photo placeholder at ${formatTimeOfDay(frame.captureEpochMs)}`
                  }
                  onClick={() => onViewPhotos(frame)}
                >
                  {frame.deletedAt !== null ? (
                    <span className="flex size-full flex-col items-center justify-center gap-1 text-muted-foreground">
                      <ImageOffIcon className="size-6" aria-hidden />
                      <span className="text-xs font-medium">Deleted</span>
                    </span>
                  ) : (
                    /* eslint-disable-next-line @next/next/no-img-element -- authenticated cross-origin image; the Next image proxy cannot forward the auth cookie */
                    <img
                      src={frameImageSrc(frame.imageUrl!)}
                      alt={`Frame at ${formatTimeOfDay(frame.captureEpochMs)}`}
                      loading="lazy"
                      decoding="async"
                      fetchPriority="low"
                      className="size-full object-cover"
                    />
                  )}
                </button>
                <figcaption className="pointer-events-none absolute right-2 bottom-2 rounded-full border border-white/15 bg-black/75 px-2 py-1 text-[10px] text-white tabular-nums">
                  {formatTimeOfDay(frame.captureEpochMs)}
                </figcaption>
              </figure>
            ))}
          </div>
        ) : (
          <div className="flex h-40 flex-col items-center justify-center gap-2 text-muted-foreground sm:h-44">
            <ImageOffIcon className="size-8" aria-hidden />
            <span className="text-sm font-medium">No photos available</span>
          </div>
        )}

        <div
          className="pointer-events-none absolute inset-x-0 top-0 h-28 bg-gradient-to-b from-black/55 via-black/20 to-transparent"
          aria-hidden
        />
        <div className="absolute inset-x-3 top-3 z-10 flex flex-col items-start gap-2 sm:flex-row sm:items-start sm:justify-between">
          <span className="rounded-full border border-white/20 bg-black/75 px-3 py-1.5 text-sm font-medium text-white tabular-nums">
            {formatTimeSpan(startMs, endMs)}
          </span>

          <div className="flex flex-wrap items-center justify-end gap-1.5">
            <Button
              variant="secondary"
              size="sm"
              className="border border-white/30 bg-background/95 hover:bg-background"
              onClick={() => onViewPhotos()}
            >
              View all photos
            </Button>
            <Button
              variant="secondary"
              size="sm"
              className="border border-white/30 bg-background/95 hover:bg-background"
              onClick={onAdjustBoundaries}
            >
              Adjust times
            </Button>
            <Button
              variant="secondary"
              size="icon-sm"
              className="border border-white/30 bg-background/95 hover:bg-background"
              aria-label="Delete activity"
              onClick={onDelete}
            >
              <Trash2Icon />
            </Button>
          </div>
        </div>

        {!hasLivePhotos && thumbnails.length > 0 && (
          <span className="absolute bottom-3 left-3 rounded-full bg-background/95 px-3 py-1.5 text-xs font-medium text-muted-foreground">
            No photos remaining
          </span>
        )}
      </div>

      <div className="px-4 sm:px-6">
        <AssistedFieldRow
          label="Activity"
          htmlFor={`${activity.localId}-label`}
          invalid={isLabelMissing}
          className="pt-3 pb-2"
        >
          <ActivitySelect
            id={`${activity.localId}-label`}
            value={activity.rawLabel}
            invalid={isLabelMissing}
            onChange={onChangeLabel}
            triggerClassName="h-11 w-full min-w-0 rounded-lg bg-background/70"
          />
        </AssistedFieldRow>

        <AssistedFieldRow
          label="Activity Type"
          htmlFor={`${activity.localId}-category`}
          invalid={isCategoryMissing}
          className={ratedCategory === null ? "pt-2 pb-3" : "py-2"}
        >
          <CategorySelect
            id={`${activity.localId}-category`}
            value={activity.categoryLabel}
            onChange={onChangeCategory}
            invalid={isCategoryMissing}
            triggerClassName="h-11 w-full min-w-0 rounded-lg bg-background/70 sm:w-full"
          />
        </AssistedFieldRow>

        {ratedCategory !== null && (
          <ExperienceRatingScale
            category={ratedCategory}
            value={experienceRating}
            onChange={(rating) =>
              onChangeExperienceRating(ratedCategory, rating)
            }
            invalid={highlightIssues && experienceRating === null}
            layout="field-row"
            className="pt-2 pb-3"
          />
        )}

        {showIssueMessage && (
          <div className="py-3">
            <Text variant="destructive">{issue}</Text>
          </div>
        )}
      </div>
    </article>
  );
};
