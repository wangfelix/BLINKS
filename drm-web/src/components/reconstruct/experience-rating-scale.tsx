"use client";

import type { StudyConfigExperienceItem } from "@/lib/api-types";
import { Row } from "@/components/layout/flex";
import { Text } from "@/components/layout/text";
import { Grid } from "@/components/layout/grid";
import { Box } from "@/components/layout/box";
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
      <Grid
        gap="md"
        layout="field-row"
        className={mergeClassNames("py-4", className)}
      >
        <Label color={invalid ? "destructive" : undefined}>
          {item.question}
        </Label>
        <Box className="w-full min-w-0 sm:justify-self-end">
          <Grid
            place="center"
            className="gap-1.5"
            style={{
              gridTemplateColumns: `repeat(${values.length}, minmax(0, 1fr))`,
            }}
            role="radiogroup"
            aria-label={item.question}
            aria-invalid={invalid || undefined}
          >
            {ratingButtons}
          </Grid>
          <Row align="center" justify="between" className="mt-1.5 px-0.5">
            <Text variant="caption">{copy.lowAnchor}</Text>
            <Text variant="caption">{copy.highAnchor}</Text>
          </Row>
        </Box>
      </Grid>
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
        <Text variant="caption">{copy.lowAnchor}</Text>
        {ratingButtons}
        <Text variant="caption">{copy.highAnchor}</Text>
      </Row>
    </Row>
  );
};
