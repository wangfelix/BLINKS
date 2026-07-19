"use client";

import { Trash2Icon } from "lucide-react";

import type { CategoryLabel, ExperienceRating } from "@/lib/api-types";
import { formatTimeOfDay } from "@/lib/time";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Column, Row } from "@/components/layout/flex";
import { Text } from "@/components/layout/text";
import { CategorySelect } from "@/components/reconstruct/category-select";
import {
  ExperienceRatingScale,
  type RatedCategory,
} from "@/components/reconstruct/experience-rating-scale";
import type { EditableActivity } from "@/components/reconstruct/editor-types";

/**
 * One self-round activity row: the participant types the time span from
 * memory (no frames, no VLM anything — anti-leak) plus label and category.
 * Used by round 1 for everyone and by round 2 in the control arm.
 */
export const SelfActivityRow = ({
  activity,
  issue,
  highlightIssues,
  onChangeStartTime,
  onChangeEndTime,
  onChangeLabel,
  onChangeCategory,
  onChangeExperienceRating,
  onDelete,
}: {
  activity: EditableActivity;
  issue: string | null;
  highlightIssues: boolean;
  onChangeStartTime: (timeOfDay: string) => void;
  onChangeEndTime: (timeOfDay: string) => void;
  onChangeLabel: (rawLabel: string) => void;
  onChangeCategory: (category: CategoryLabel) => void;
  onChangeExperienceRating: (
    category: RatedCategory,
    rating: ExperienceRating,
  ) => void;
  onDelete: () => void;
}) => {
  const startValue =
    activity.startMs === null ? "" : formatTimeOfDay(activity.startMs);
  const endValue =
    activity.endMs === null ? "" : formatTimeOfDay(activity.endMs);
  const isLabelMissing = highlightIssues && activity.rawLabel.trim() === "";
  const isCategoryMissing = highlightIssues && activity.categoryLabel === null;
  const isTimeSpanIncomplete =
    highlightIssues && (activity.startMs === null || activity.endMs === null);
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
    <Column gap="md" className="rounded-xl border bg-card p-4 shadow-xs">
      <Row gap="md" align="end" wrap>
        <Column gap="xs">
          <Label htmlFor={`${activity.localId}-start`}>From</Label>
          <Input
            id={`${activity.localId}-start`}
            type="time"
            value={startValue}
            aria-invalid={isTimeSpanIncomplete || undefined}
            onChange={(event) => onChangeStartTime(event.target.value)}
            className="w-28"
          />
        </Column>
        <Column gap="xs">
          <Label htmlFor={`${activity.localId}-end`}>To</Label>
          <Input
            id={`${activity.localId}-end`}
            type="time"
            value={endValue}
            aria-invalid={isTimeSpanIncomplete || undefined}
            onChange={(event) => onChangeEndTime(event.target.value)}
            className="w-28"
          />
        </Column>
        <Column gap="xs" className="min-w-48 flex-1">
          <Label htmlFor={`${activity.localId}-label`}>
            Activity Description
          </Label>
          <Input
            id={`${activity.localId}-label`}
            value={activity.rawLabel}
            placeholder="What were you doing?"
            aria-invalid={isLabelMissing || undefined}
            onChange={(event) => onChangeLabel(event.target.value)}
          />
        </Column>
        <Column gap="xs">
          <Label htmlFor={`${activity.localId}-category`}>Activity Type</Label>
          <CategorySelect
            id={`${activity.localId}-category`}
            value={activity.categoryLabel}
            onChange={onChangeCategory}
            invalid={isCategoryMissing}
          />
        </Column>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label="Delete activity"
          onClick={onDelete}
        >
          <Trash2Icon />
        </Button>
      </Row>

      {ratedCategory !== null && (
        <ExperienceRatingScale
          category={ratedCategory}
          value={experienceRating}
          onChange={(rating) => onChangeExperienceRating(ratedCategory, rating)}
          invalid={highlightIssues && experienceRating === null}
        />
      )}

      {showIssueMessage && <Text variant="destructive">{issue}</Text>}
    </Column>
  );
};
