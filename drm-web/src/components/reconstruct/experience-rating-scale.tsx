"use client";

import type { ExperienceRating } from "@/lib/api-types";
import { Row } from "@/components/layout/flex";
import { Text } from "@/components/layout/text";
import { mergeClassNames } from "@/lib/utils";
import {Label} from "@/components/ui/label";

const RATING_VALUES: ExperienceRating[] = [1, 2, 3, 4, 5, 6, 7];

/** The category an experience rating exists for ('other' is never rated). */
export type RatedCategory = "work" | "break";

// Item wording fixed by Michael (mail 2026-07-19) — keep verbatim.
const SCALE_COPY: Record<
  RatedCategory,
  { question: string; lowAnchor: string; highAnchor: string }
> = {
  work: {
    question: "How mentally demanding was this activity?",
    lowAnchor: "Not at all",
    highAnchor: "Very much",
  },
  break: {
    question: "How mentally recovering was this activity?",
    lowAnchor: "Not at all",
    highAnchor: "Very much",
  },
};

/**
 * 7-point Likert scale shown under an activity's label/category row. Work
 * activities rate mental demand, breaks rate mental recovery.
 */
export const ExperienceRatingScale = ({
  category,
  value,
  onChange,
  invalid = false,
}: {
  category: RatedCategory;
  value: ExperienceRating | null;
  onChange: (rating: ExperienceRating) => void;
  invalid?: boolean;
}) => {
  const copy = SCALE_COPY[category];
  return (
    <Row gap="md" align="center" justify="between" wrap className="px-1">
      <Label color={invalid ? "destructive" : undefined}>
        {copy.question}
      </Label>
      <Row
        gap="sm"
        align="center"
        role="radiogroup"
        aria-label={copy.question}
        aria-invalid={invalid || undefined}
      >
        <Text variant="nudge">{copy.lowAnchor}</Text>
        {RATING_VALUES.map((rating) => (
          <button
            key={rating}
            type="button"
            role="radio"
            aria-checked={value === rating}
            aria-label={`${rating} of 5`}
            onClick={() => onChange(rating)}
            className={mergeClassNames(
              "size-8 rounded-full border text-sm tabular-nums transition-colors focus-visible:ring-2 focus-visible:ring-ring",
              value === rating
                ? "border-primary bg-primary font-medium text-primary-foreground"
                : "text-muted-foreground hover:bg-muted",
              invalid && value === null && "border-destructive",
            )}
          >
            {rating}
          </button>
        ))}
        <Text variant="nudge">{copy.highAnchor}</Text>
      </Row>
    </Row>
  );
};
