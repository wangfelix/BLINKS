"use client";

import { useMemo, type ReactNode } from "react";
import { ImageOffIcon, Trash2Icon } from "lucide-react";

import type { ActivityLabel, CategoryLabel, Frame } from "@/lib/api-types";
import {
  experienceItemsForCategory,
  thumbnailsPerActivity,
} from "@/lib/study-config-store";
import { frameImageSrc } from "@/lib/api-client";
import { mergeClassNames } from "@/lib/utils";
import { formatTimeOfDay, formatTimeSpan } from "@/lib/time";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Text } from "@/components/layout/text";
import { CategorySelect } from "@/components/reconstruct/category-select";
import { ActivitySelect } from "@/components/reconstruct/activity-select";
import { ExperienceRatingScale } from "@/components/reconstruct/experience-rating-scale";
import {
  sampleEvenly,
  type EditableActivity,
} from "@/components/reconstruct/editor-types";
import { frameIdentityKey } from "@/components/photos/use-photo-deletion";
import { Column, Row } from "@/components/layout/flex";
import { Grid } from "@/components/layout/grid";
import { Box } from "@/components/layout/box";

export type MergeHighlightPhase = "holding" | "fading";

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
  <Grid gap="sm" layout="field-row" className={className}>
    <Label htmlFor={htmlFor} color={invalid ? "destructive" : undefined}>
      {label}
    </Label>
    <Box className="w-full min-w-0 sm:w-80 sm:justify-self-end">{children}</Box>
  </Grid>
);

/** One assisted-condition activity row: time span, frame thumbnails, labels. */
export const AssistedActivityRow = ({
  activity,
  dayFrames,
  issue,
  highlightIssues,
  mergeHighlightPhase,
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
  mergeHighlightPhase: MergeHighlightPhase | null;
  onChangeLabel: (rawLabel: ActivityLabel) => void;
  onChangeCategory: (category: CategoryLabel) => void;
  onChangeExperienceRating: (itemKey: string, rating: number) => void;
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
          frame.captureEpochMs >= startMs && frame.captureEpochMs < endMs,
      ),
    [dayFrames, endMs, startMs],
  );
  const thumbnails = useMemo(
    () => sampleEvenly(framesInSpan, thumbnailsPerActivity()),
    [framesInSpan],
  );
  const hasLivePhotos = useMemo(
    () => framesInSpan.some((frame) => frame.deletedAt === null),
    [framesInSpan],
  );
  const isLabelMissing = highlightIssues && activity.rawLabel === null;
  const isCategoryMissing = highlightIssues && activity.categoryLabel === null;
  const showIssueMessage = highlightIssues && issue !== null;
  const ratedItems = experienceItemsForCategory(activity.categoryLabel);

  return (
    <article
      className={mergeClassNames(
        "overflow-hidden rounded-2xl border bg-card [contain-intrinsic-size:auto_23rem] [content-visibility:auto]",
        activity.isIncorrectAnnotationInjected &&
          "border-yellow-200 bg-yellow-50",
        mergeHighlightPhase === "holding" && "border-yellow-400 bg-yellow-100",
        mergeHighlightPhase === "fading" &&
          "transition-[background-color,border-color] duration-[800ms] ease-out motion-reduce:transition-none",
      )}
    >
      <Box position="relative" isolate clip className="bg-muted">
        {thumbnails.length > 0 ? (
          <Row className="h-40 overflow-x-auto sm:h-44">
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
                      <Text as="span" variant="small">
                        Deleted
                      </Text>
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
                <figcaption className="pointer-events-none absolute right-2 bottom-2 rounded-full border border-white/15 bg-black/75 px-2 py-1 text-3xs text-white tabular-nums">
                  {formatTimeOfDay(frame.captureEpochMs)}
                </figcaption>
              </figure>
            ))}
          </Row>
        ) : (
          <Column
            gap="sm"
            align="center"
            justify="center"
            className="h-40 text-muted-foreground sm:h-44"
          >
            <ImageOffIcon className="size-8" aria-hidden />
            <Text as="span" variant="label">
              No images available
            </Text>
          </Column>
        )}

        <div
          className="pointer-events-none absolute inset-x-0 top-0 h-28 bg-gradient-to-b from-black/55 via-black/20 to-transparent"
          aria-hidden
        />
        <Column
          gap="sm"
          align="start"
          className="absolute inset-x-3 top-3 z-10 sm:flex-row sm:items-start sm:justify-between"
        >
          <Badge variant="pill" tone="overlay-strong" size="sm" numeric>
            {formatTimeSpan(startMs, endMs)}
          </Badge>

          <Row align="center" justify="end" wrap className="gap-1.5">
            <Button
              variant="secondary"
              size="sm"
              surface="overlay"
              className="hover:bg-background"
              onClick={() => onViewPhotos()}
            >
              View all photos
            </Button>
            <Button
              variant="secondary"
              size="sm"
              surface="overlay"
              className="hover:bg-background"
              onClick={onAdjustBoundaries}
            >
              Adjust times
            </Button>
            <Button
              variant="destructive-ghost"
              size="icon-sm"
              surface="overlay"
              aria-label="Delete activity"
              onClick={onDelete}
            >
              <Trash2Icon />
            </Button>
          </Row>
        </Column>

        {!hasLivePhotos && thumbnails.length > 0 && (
          <Badge
            variant="pill"
            tone="note"
            className="absolute bottom-3 left-3"
          >
            No photos remaining
          </Badge>
        )}
      </Box>

      <Box className="px-4 sm:px-6">
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
          className={ratedItems.length === 0 ? "pt-2 pb-3" : "py-2"}
        >
          <CategorySelect
            id={`${activity.localId}-category`}
            value={activity.categoryLabel}
            onChange={onChangeCategory}
            invalid={isCategoryMissing}
            triggerClassName="h-11 w-full min-w-0 rounded-lg bg-background/70 sm:w-full"
          />
        </AssistedFieldRow>

        {ratedItems.map((item, index) => {
          const value = activity.ratings[item.key] ?? null;
          return (
            <ExperienceRatingScale
              key={item.key}
              item={item}
              value={value}
              onChange={(rating) => onChangeExperienceRating(item.key, rating)}
              invalid={
                highlightIssues && item.requiredOnSubmit && value === null
              }
              layout="field-row"
              className={index === ratedItems.length - 1 ? "pt-2 pb-3" : "py-2"}
            />
          );
        })}

        {showIssueMessage && (
          <Box className="py-3">
            <Text tone="destructive">{issue}</Text>
          </Box>
        )}
      </Box>
    </article>
  );
};
