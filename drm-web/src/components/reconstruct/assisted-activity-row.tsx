"use client";

import { Trash2Icon } from "lucide-react";

import type { CategoryLabel, Frame } from "@/lib/api-types";
import { frameImageSrc } from "@/lib/api-client";
import { formatTimeOfDay, formatTimeSpan } from "@/lib/time";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
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
  showValidation,
  onChangeLabel,
  onChangeCategory,
  onDelete,
  onAdjustBoundaries,
}: {
  activity: EditableActivity;
  dayFrames: Frame[];
  issue: string | null;
  showValidation: boolean;
  onChangeLabel: (rawLabel: string) => void;
  onChangeCategory: (category: CategoryLabel) => void;
  onDelete: () => void;
  onAdjustBoundaries: () => void;
}) => {
  const startMs = activity.startMs ?? 0;
  const endMs = activity.endMs ?? 0;
  const framesInSpan = dayFrames.filter(
    (frame) =>
      frame.captureEpochMs >= startMs && frame.captureEpochMs <= endMs,
  );
  const thumbnails = sampleEvenly(framesInSpan, THUMBNAIL_COUNT);
  const labelMissing = showValidation && activity.rawLabel.trim() === "";
  const categoryMissing = showValidation && activity.categoryLabel === null;

  return (
    <div className="space-y-3 rounded-xl border bg-card p-4 shadow-xs">
      <div className="flex items-center justify-between gap-2">
        <span className="font-mono text-sm font-medium tabular-nums">
          {formatTimeSpan(startMs, endMs)}
        </span>
        <div className="flex items-center gap-1">
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
        </div>
      </div>

      {thumbnails.length > 0 && (
        <div className="flex gap-2 overflow-x-auto pb-1">
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
        </div>
      )}

      <div className="flex flex-col gap-2 sm:flex-row">
        <Input
          value={activity.rawLabel}
          placeholder="What were you doing?"
          aria-label="Activity description"
          aria-invalid={labelMissing || undefined}
          onChange={(event) => onChangeLabel(event.target.value)}
          className="flex-1"
        />
        <CategorySelect
          value={activity.categoryLabel}
          onChange={onChangeCategory}
          invalid={categoryMissing}
        />
      </div>

      {showValidation && issue !== null && (
        <p className="text-sm text-destructive">{issue}</p>
      )}
    </div>
  );
};
