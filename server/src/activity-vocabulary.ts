// Closed activity vocabulary shared by the reconstruction API contract.
// Keep these keys synchronized with server/vlm/vlm_worker.py and
// drm-web/src/lib/activity-vocabulary.ts.
export const ACTIVITY_LABELS = [
  "computer_or_monitor_use",
  "watching_video",
  "paper_reading_writing",
  "handheld_device_use",
  "remote_meeting",
  "phone_call",
  "in_person_interaction",
  "tools_or_materials",
  "eating_drinking",
  "food_preparation",
  "cleaning_household",
  "assisting_person_animal",
  "personal_care",
  "walking_or_movement",
  "no_task_engagement",
  "other",
  "unclear",
] as const;

export type ActivityLabel = (typeof ACTIVITY_LABELS)[number];

export const ACTIVITY_LABEL_SET: ReadonlySet<string> = new Set(
  ACTIVITY_LABELS,
);
