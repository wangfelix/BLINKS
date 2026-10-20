import type { CategoryIcon, CategoryLabel } from "@/lib/api-types";
import { getStudyConfig } from "@/lib/study-config-store";

// Participant-facing activity categories (activity types). Keys, labels,
// icons, legend descriptions and order come from the study config
// (`categories[]`, GET /api/study-config).
export const categoryItems = (): {
  value: CategoryLabel;
  label: string;
  icon: CategoryIcon;
  description: string;
}[] =>
  getStudyConfig().categories.map((category) => ({
    value: category.key,
    label: category.displayLabel,
    icon: category.icon,
    description: category.description,
  }));

export const categoryDisplayLabel = (value: string): string =>
  getStudyConfig().categories.find((category) => category.key === value)
    ?.displayLabel ?? value;
