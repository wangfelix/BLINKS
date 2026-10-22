"use client";

import type { StudyConfigExperienceItem } from "@/lib/api-types";
import { Row } from "@/components/layout/flex";
import { Text } from "@/components/layout/text";
import { mergeClassNames } from "@/lib/utils";
import { Label } from "@/components/ui/label";

/** Every answer value of the item's scale, low to high. */
const scaleValues = (item: StudyConfigExperienceItem): number[] =>
  Array.from(
    { length: item.scale.max - item.scale.min + 1 },
    (_, index) => item.scale.min + index,
  );

/** "Mental demand 4/7" / "Recovery 2/7" for the submitted view. */
export const experienceRatingSummaryLabel = (
  item: StudyConfigExperienceItem,
  rating: number,
): string => `${item.shortLabel} ${rating}/${item.scale.max}`;

/**
 * Likert scale of one experience item (question, anchors and scale length
 * from the study config), shown under an activity's label/category row.
 */
export const ExperienceRatingScale = ({
  item,
  value,
  onChange,
  invalid = false,
  layout = "inline",
  className,
}: {
  item: StudyConfigExperienceItem;
  value: number | null;
  onChange: (rating: number) => void;
  invalid?: boolean;
  layout?: "inline" | "field-row";
  className?: string;
}) => {
  const copy = item.scale;
  const values = scaleValues(item);

  const ratingButtons = values.map((rating) => (
    <button
      key={rating}
      type="button"
      role="radio"
      aria-checked={value === rating}
      aria-label={`${rating} of ${item.scale.max}`}
      onClick={() => onChange(rating)}
      className={mergeClassNames(
        "size-8 rounded-full border text-sm tabular-nums transition-colors focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none",
        value === rating
          ? "border-primary bg-primary font-medium text-primary-foreground"
          : "text-muted-foreground hover:bg-muted",
        invalid && value === null && "border-destructive",
      )}
    >
      {rating}
    </button>
  ));

  if (layout === "field-row") {
    return (
      <div
        className={mergeClassNames(
          "grid gap-3 py-4 sm:grid-cols-field-row sm:items-center sm:gap-6",
          className,
        )}
      >
        <Label color={invalid ? "destructive" : undefined}>
          {item.question}
        </Label>
        <div className="w-full min-w-0 sm:justify-self-end">
          <div
            className="grid place-items-center gap-1.5"
            style={{
              gridTemplateColumns: `repeat(${values.length}, minmax(0, 1fr))`,
            }}
            role="radiogroup"
            aria-label={item.question}
            aria-invalid={invalid || undefined}
          >
            {ratingButtons}
          </div>
          <div className="mt-1.5 flex items-center justify-between px-0.5">
            <Text variant="nudge">{copy.lowAnchor}</Text>
            <Text variant="nudge">{copy.highAnchor}</Text>
          </div>
        </div>
      </div>
    );
  }

  return (
    <Row
      gap="md"
      align="center"
      justify="between"
      wrap
      className={mergeClassNames("px-1", className)}
    >
      <Label color={invalid ? "destructive" : undefined}>{item.question}</Label>
      <Row
        gap="sm"
        align="center"
        role="radiogroup"
        aria-label={item.question}
        aria-invalid={invalid || undefined}
      >
        <Text variant="nudge">{copy.lowAnchor}</Text>
        {ratingButtons}
        <Text variant="nudge">{copy.highAnchor}</Text>
      </Row>
    </Row>
  );
};
