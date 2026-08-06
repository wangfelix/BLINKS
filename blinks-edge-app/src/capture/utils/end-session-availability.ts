const END_SESSION_AVAILABLE_HOUR = 19;

// End becomes available at 19:00 on the local calendar day on which the main
// session started. Comparing timestamps, instead of only the current hour,
// keeps the action available after midnight and during morning-after recovery.
export const isStudySessionEndAvailable = (
  nowMs: number,
  sessionIdSeconds: number | null,
): boolean => {
  if (sessionIdSeconds === null) return false;
  const cutoff = new Date(sessionIdSeconds * 1_000);
  cutoff.setHours(END_SESSION_AVAILABLE_HOUR, 0, 0, 0);
  return nowMs >= cutoff.getTime();
};
