import type { AppTexts } from "@/study/types/app-config";

// Fallback texts for the recording notification and the onboarding form while
// this account has not loaded GET /api/app-config. They mirror
// config/study.example.yaml.
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
