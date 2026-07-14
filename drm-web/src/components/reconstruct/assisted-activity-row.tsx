"use client";

import { Trash2Icon } from "lucide-react";

import type { CategoryLabel, Frame } from "@/lib/api-types";
import { frameImageSrc } from "@/lib/api-client";
import { formatTimeOfDay, formatTimeSpan } from "@/lib/time";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Column, Row } from "@/components/layout/flex";
import { Text } from "@/components/layout/text";
import { CategorySelect } from "@/components/reconstruct/category-select";
import {
  sampleEvenly,
  type EditableActivity,
} from "@/components/reconstruct/editor-types";

const THUMBNAIL_COUNT = 5;

/** One assisted-condition activity row: time span, frame thumbnails, labels. */
export const AssistedActivityRow = ({
  activity,
  dayFrames,
  issue,
  highlightIssues,
  onChangeLabel,
  onChangeCategory,
  onDelete,
  onAdjustBoundaries,
}: {
  activity: EditableActivity;
  dayFrames: Frame[];
  issue: string | null;
  highlightIssues: boolean;
  onChangeLabel: (rawLabel: string) => void;
  onChangeCategory: (category: CategoryLabel) => void;
  onDelete: () => void;
  onAdjustBoundaries: () => void;
}) => {
  const startMs = activity.startMs ?? 0;
  const endMs = activity.endMs ?? 0;
  const framesInSpan = dayFrames.filter(
    (frame) => frame.captureEpochMs >= startMs && frame.captureEpochMs <= endMs,
  );
  const thumbnails = sampleEvenly(framesInSpan, THUMBNAIL_COUNT);
  const isLabelMissing = highlightIssues && activity.rawLabel.trim() === "";
  const isCategoryMissing = highlightIssues && activity.categoryLabel === null;
  const showIssueMessage = highlightIssues && issue !== null;

  return (
    <Column gap="md" className="rounded-xl border bg-card p-4 shadow-xs">
      <Row gap="sm" align="center" justify="between">
        <span className="text-sm font-medium tabular-nums">
          {formatTimeSpan(startMs, endMs)}
        </span>

        <Row gap="xs" align="center">
          <Button variant="ghost" size="sm" onClick={onAdjustBoundaries}>
            Adjust times
          </Button>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="Delete activity"
            onClick={onDelete}
          >
            <Trash2Icon />
          </Button>
        </Row>
      </Row>

      {thumbnails.length > 0 && (
        <Row gap="sm" className="overflow-x-auto pb-1">
          {thumbnails.map((frame) => (
            <figure key={frame.captureEpochMs} className="w-24 shrink-0">
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

      <Column gap="sm" className="sm:flex-row">
        <Input
          value={activity.rawLabel}
          placeholder="What were you doing?"
          aria-label="Activity description"
          aria-invalid={isLabelMissing || undefined}
          onChange={(event) => onChangeLabel(event.target.value)}
          className="flex-1"
        />
        <CategorySelect
          value={activity.categoryLabel}
          onChange={onChangeCategory}
          invalid={isCategoryMissing}
        />
      </Column>

      {showIssueMessage && <Text variant="destructive">{issue}</Text>}
    </Column>
  );
};
