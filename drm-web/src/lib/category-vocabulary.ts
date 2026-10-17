import type { CategoryLabel } from "@/lib/api-types";

// Participant-facing labels for the activity categories (study definitions).
// Single place for these labels until they come from the study config
// (BLINKS-tasks #3). Keep the keys synchronized with the server.
export const CATEGORY_ITEMS: {
  value: CategoryLabel;
  label: string;
}[] = [
  { value: "work", label: "Work" },
  { value: "break", label: "Break" },
  { value: "other", label: "Other" },
];

export const categoryDisplayLabel = (value: string): string =>
  CATEGORY_ITEMS.find((item) => item.value === value)?.label ?? value;
