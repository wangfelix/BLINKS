import type { ActivityLabel } from "@/lib/api-types";
import { getStudyConfig } from "@/lib/study-config-store";

// Participant-facing labels for the closed activity vocabulary. Keys, labels
// and order come from the study config (`activities[]`, GET /api/study-config).
export const activityItems = (): {
  value: ActivityLabel;
  label: string;
}[] =>
  getStudyConfig().activities.map((activity) => ({
    value: activity.key,
    label: activity.displayLabel,
  }));

export const isActivityLabel = (value: unknown): value is ActivityLabel =>
  typeof value === "string" &&
  getStudyConfig().activities.some((activity) => activity.key === value);

export const activityDisplayLabel = (
  value: ActivityLabel | null,
): string | null =>
  value === null
    ? null
    : (getStudyConfig().activities.find((activity) => activity.key === value)
        ?.displayLabel ?? null);
