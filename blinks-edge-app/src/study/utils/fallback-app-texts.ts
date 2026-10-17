import type { AppTexts } from "@/study/types/app-config";

// Offline safety net only (contract 4.5: recording must never fail because of
// the config). Used for the recording notification and the onboarding form
// while this account has never loaded GET /api/app-config. The study's real
// texts come from config/study.yaml; these mirror config/study.example.yaml.
export const FALLBACK_APP_TEXTS: Omit<AppTexts, "endSessionAvailableFrom"> = {
  recordingNotificationTitle: "BLINKS is recording",
  recordingNotificationBody: "Receiving camera frames over Bluetooth",
  testRecordingNotificationTitle: "BLINKS test recording",
  testRecordingNotificationBody: "Checking the camera connection",
  onboarding: {
    title: "Tell us about yourself",
    intro:
      "The AI assistant uses your work description to distinguish work from other activities; your usual schedule times the evening reminder.",
    occupationLabel: "Occupation",
    occupationPlaceholder: "e.g. Master Student in Industrial Engineering",
    workDescriptionLabel: "What your work consists of",
    workDescriptionPlaceholder:
      "e.g. writing reports, analyzing data, meetings, programming,...",
    wakeTimeLabel: "Usual wake-up time",
    bedTimeLabel: "Usual bedtime",
  },
};
