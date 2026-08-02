export type SurveyKind = "onboarding" | "final";

const SURVEYS: Record<
  SurveyKind,
  { baseUrl: string | undefined; participantParameter: string }
> = {
  onboarding: {
    baseUrl: process.env.NEXT_PUBLIC_ONBOARDING_SURVEY_URL,
    participantParameter: "participant_id",
  },
  final: {
    baseUrl: process.env.NEXT_PUBLIC_FINAL_SURVEY_URL,
    participantParameter: "participantId",
  },
};

export const surveyUrlForParticipant = (
  kind: SurveyKind,
  participantId: string,
): string | null => {
  const survey = SURVEYS[kind];
  if (!survey.baseUrl) return null;
  try {
    const url = new URL(survey.baseUrl);
    url.searchParams.set(survey.participantParameter, participantId);
    return url.toString();
  } catch {
    return null;
  }
};
