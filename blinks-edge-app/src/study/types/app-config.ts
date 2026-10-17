// Shape of GET /api/app-config (docs/study-config-contract.md, section 4.3).
// Keep in sync with the server when the contract changes.
export interface AppConfigFormFactor {
  key: string;
  displayLabel: string;
}

export interface AppOnboardingTexts {
  title: string;
  intro: string;
  occupationLabel: string;
  occupationPlaceholder: string;
  workDescriptionLabel: string;
  workDescriptionPlaceholder: string;
  wakeTimeLabel: string;
  bedTimeLabel: string;
}

export interface AppTexts {
  recordingNotificationTitle: string;
  recordingNotificationBody: string;
  testRecordingNotificationTitle: string;
  testRecordingNotificationBody: string;
  /** Contains the placeholder "{{time}}", e.g. "Available from {{time}}". */
  endSessionAvailableFrom: string;
  onboarding: AppOnboardingTexts;
}

export interface AppConfigResponse {
  timezone: string;
  schedule: { endSessionAvailableAt: string };
  devices: { formFactors: AppConfigFormFactor[] };
  capture: { intervalMsByFormFactor: Record<string, number> };
  texts: { app: AppTexts };
  studySettingsPin: string;
}

/** Everything except the PIN; this part is cached as a plain file. */
export type CachedAppConfig = Omit<AppConfigResponse, "studySettingsPin">;
