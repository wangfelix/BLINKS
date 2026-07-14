const STUDY_TEAM_EMAIL = "felix-wang@outlook.de";

/** Mailto link to the study team, styled for inline use in body text. */
export const StudyTeamContactLink = () => (
  <a
    href={`mailto:${STUDY_TEAM_EMAIL}`}
    className="underline transition-colors hover:text-foreground"
  >
    Contact
  </a>
);
