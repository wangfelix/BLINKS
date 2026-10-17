/**
 * Study Settings unlock rule: the PIN comes only from the server config
 * (cached per user). Without a loaded config there is nothing to compare
 * against, so the page stays locked — there is no fallback PIN in code.
 */
export const isStudySettingsPinCorrect = (
  expectedPin: string | null,
  enteredPin: string,
): boolean => expectedPin !== null && enteredPin === expectedPin;
