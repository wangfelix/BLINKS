"use client";

import { Trash2Icon } from "lucide-react";

import type { CategoryLabel } from "@/lib/api-types";
import { formatTimeOfDay } from "@/lib/time";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { CategorySelect } from "@/components/reconstruct/category-select";
import type { EditableActivity } from "@/components/reconstruct/editor-types";

/**
 * One self-round activity row: the participant types the time span from
 * memory (no frames, no VLM anything — anti-leak) plus label and category.
 * Used by round 1 for everyone and by round 2 in the control arm.
 */
export const SelfActivityRow = ({
  activity,
  issue,
  showValidation,
  onChangeStartTime,
  onChangeEndTime,
  onChangeLabel,
  onChangeCategory,
  onDelete,
}: {
  activity: EditableActivity;
  issue: string | null;
  showValidation: boolean;
  onChangeStartTime: (timeOfDay: string) => void;
  onChangeEndTime: (timeOfDay: string) => void;
  onChangeLabel: (rawLabel: string) => void;
  onChangeCategory: (category: CategoryLabel) => void;
  onDelete: () => void;
}) => {
  const startValue =
    activity.startMs === null ? "" : formatTimeOfDay(activity.startMs);
  const endValue =
    activity.endMs === null ? "" : formatTimeOfDay(activity.endMs);
  const labelMissing = showValidation && activity.rawLabel.trim() === "";
  const categoryMissing = showValidation && activity.categoryLabel === null;
  const timesInvalid =
    showValidation && (activity.startMs === null || activity.endMs === null);

  return (
    <div className="space-y-3 rounded-xl border bg-card p-4 shadow-xs">
      <div className="flex flex-wrap items-end gap-3">
        <div className="space-y-1">
          <Label htmlFor={`${activity.localId}-start`}>From</Label>
          <Input
            id={`${activity.localId}-start`}
            type="time"
            value={startValue}
            aria-invalid={timesInvalid || undefined}
            onChange={(event) => onChangeStartTime(event.target.value)}
            className="w-28"
          />
        </div>
        <div className="space-y-1">
          <Label htmlFor={`${activity.localId}-end`}>To</Label>
          <Input
            id={`${activity.localId}-end`}
            type="time"
            value={endValue}
            aria-invalid={timesInvalid || undefined}
            onChange={(event) => onChangeEndTime(event.target.value)}
            className="w-28"
          />
        </div>
        <div className="min-w-48 flex-1 space-y-1">
          <Label htmlFor={`${activity.localId}-label`}>Activity</Label>
          <Input
            id={`${activity.localId}-label`}
            value={activity.rawLabel}
            placeholder="What were you doing?"
            aria-invalid={labelMissing || undefined}
            onChange={(event) => onChangeLabel(event.target.value)}
          />
        </div>
        <div className="space-y-1">
          <Label>Category</Label>
          <CategorySelect
            value={activity.categoryLabel}
            onChange={onChangeCategory}
            invalid={categoryMissing}
          />
        </div>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label="Delete activity"
          onClick={onDelete}
        >
          <Trash2Icon />
        </Button>
      </div>

      {showValidation && issue !== null && (
        <p className="text-sm text-destructive">{issue}</p>
      )}
    </div>
  );
};
