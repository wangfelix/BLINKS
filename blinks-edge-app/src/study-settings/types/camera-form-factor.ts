export const CAMERA_FORM_FACTORS = ["necklace", "glasses"] as const;

export type CameraFormFactor = (typeof CAMERA_FORM_FACTORS)[number];
