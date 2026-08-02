"use client";

import type { ExperienceRating } from "@/lib/api-types";
import { Row } from "@/components/layout/flex";
import { Text } from "@/components/layout/text";
import { mergeClassNames } from "@/lib/utils";
import { Label } from "@/components/ui/label";

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
  layout = "inline",
  className,
}: {
  category: RatedCategory;
  value: ExperienceRating | null;
  onChange: (rating: ExperienceRating) => void;
  invalid?: boolean;
  layout?: "inline" | "field-row";
  className?: string;
}) => {
  const copy = SCALE_COPY[category];

  const ratingButtons = RATING_VALUES.map((rating) => (
    <button
      key={rating}
      type="button"
      role="radio"
      aria-checked={value === rating}
      aria-label={`${rating} of 7`}
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
          "grid gap-3 py-4 sm:grid-cols-[minmax(0,1fr)_20rem] sm:items-center sm:gap-6",
          className,
        )}
      >
        <Label color={invalid ? "destructive" : undefined}>
          {copy.question}
        </Label>
        <div className="w-full min-w-0 sm:justify-self-end">
          <div
            className="grid grid-cols-7 place-items-center gap-1.5"
            role="radiogroup"
            aria-label={copy.question}
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
      <Label color={invalid ? "destructive" : undefined}>{copy.question}</Label>
      <Row
        gap="sm"
        align="center"
        role="radiogroup"
        aria-label={copy.question}
        aria-invalid={invalid || undefined}
      >
        <Text variant="nudge">{copy.lowAnchor}</Text>
        {ratingButtons}
        <Text variant="nudge">{copy.highAnchor}</Text>
      </Row>
    </Row>
  );
};
