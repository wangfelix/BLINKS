import { getStudyConfig } from "@/lib/study-config-store";

export type SurveyKind = "onboarding" | "final";

/**
 * External survey link for the participant, from the study config
 * (`surveys`, participant tokens only). The participant id is appended under
 * the configured query parameter.
 */
export const surveyUrlForParticipant = (
  kind: SurveyKind,
  participantId: string,
): string | null => {
  const survey = getStudyConfig().surveys?.[kind];
  if (!survey) return null;
  try {
    const url = new URL(survey.url);
    url.searchParams.set(survey.participantParameter, participantId);
    return url.toString();
  } catch {
    return null;
  }
};
