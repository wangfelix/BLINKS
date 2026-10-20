/**
 * Study Settings unlock: the PIN comes only from the server config
 * (cached per user). Without a loaded config the page stays locked.
 */
export const isStudySettingsPinCorrect = (
  expectedPin: string | null,
  enteredPin: string,
): boolean => expectedPin !== null && enteredPin === expectedPin;
