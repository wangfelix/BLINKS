import type { ActivityLabel } from "@/lib/api-types";

// Participant-facing labels for the closed activity enum. Keep the enum keys
// synchronized with server/src/activity-vocabulary.ts and
// server/vlm/vlm_worker.py.
export const ACTIVITY_ITEMS: {
  value: ActivityLabel;
  label: string;
}[] = [
  { value: "computer_or_monitor_use", label: "Computer or monitor use" },
  { value: "watching_video", label: "Watching video or TV" },
  {
    value: "paper_reading_writing",
    label: "Reading or handwriting on paper",
  },
  { value: "handheld_device_use", label: "Handheld device use" },
  { value: "remote_meeting", label: "Remote meeting or video call" },
  { value: "phone_call", label: "Phone call" },
  { value: "in_person_interaction", label: "In-person interaction" },
  { value: "tools_or_materials", label: "Handling tools or materials" },
  { value: "eating_drinking", label: "Eating or drinking" },
  { value: "food_preparation", label: "Preparing or serving food" },
  { value: "cleaning_household", label: "Cleaning or household task" },
  {
    value: "assisting_person_animal",
    label: "Assisting a person or animal",
  },
  { value: "personal_care", label: "Personal care" },
  {
    value: "walking_or_movement",
    label: "Walking, cycling, or sustained movement",
  },
  { value: "no_task_engagement", label: "No specific activity" },
  { value: "other", label: "Other" },
  { value: "unclear", label: "Unclear / cannot determine" },
];

const ACTIVITY_LABEL_SET: ReadonlySet<string> = new Set(
  ACTIVITY_ITEMS.map((item) => item.value),
);

export const isActivityLabel = (value: unknown): value is ActivityLabel =>
  typeof value === "string" && ACTIVITY_LABEL_SET.has(value);

export const activityDisplayLabel = (
  value: ActivityLabel | null,
): string | null =>
  value === null
    ? null
    : (ACTIVITY_ITEMS.find((item) => item.value === value)?.label ?? null);
