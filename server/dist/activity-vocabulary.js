"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ACTIVITY_LABEL_SET = exports.ACTIVITY_LABELS = void 0;
// Closed activity vocabulary shared by the reconstruction API contract.
// Keep these keys synchronized with server/vlm/vlm_worker.py and
// drm-web/src/lib/activity-vocabulary.ts.
exports.ACTIVITY_LABELS = [
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
];
exports.ACTIVITY_LABEL_SET = new Set(exports.ACTIVITY_LABELS);
