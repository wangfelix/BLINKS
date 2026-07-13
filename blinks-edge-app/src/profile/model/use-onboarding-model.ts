import { useState } from "react";

import { isValidTimeOfDay } from "@/profile/api/profile-api";
import { useUpdateProfileMutation } from "@/profile/model/use-update-profile-mutation";

export const useOnboardingModel = () => {
  // ---- STATE ----

  const [occupation, setOccupation] = useState("");
  const [workDescription, setWorkDescription] = useState("");
  const [wakeTime, setWakeTime] = useState("");
  const [bedTime, setBedTime] = useState("");
  const [validationError, setValidationError] = useState<string | null>(null);

  const updateProfileMutation = useUpdateProfileMutation();

  const canSubmit =
    occupation.trim() !== "" &&
    workDescription.trim() !== "" &&
    wakeTime.trim() !== "" &&
    bedTime.trim() !== "";

  // ---- ACTIONS ----

  // On success the cached profile carries a complete profile, the onboarding
  // guard in the root layout flips, and Expo Router moves to the tabs on its
  // own — no manual navigation needed here.
  const submit = () => {
    const trimmedOccupation = occupation.trim();
    const trimmedWorkDescription = workDescription.trim();
    const trimmedWakeTime = wakeTime.trim();
    const trimmedBedTime = bedTime.trim();
    if (
      !trimmedOccupation ||
      !trimmedWorkDescription ||
      !trimmedWakeTime ||
      !trimmedBedTime
    ) {
      setValidationError("Fill in all fields.");
      return;
    }
    if (!isValidTimeOfDay(trimmedWakeTime) || !isValidTimeOfDay(trimmedBedTime)) {
      setValidationError("Times must be HH:MM (24-hour), e.g. 07:30 or 23:00.");
      return;
    }
    setValidationError(null);
    updateProfileMutation.mutate(
      {
        occupation: trimmedOccupation,
        workDescription: trimmedWorkDescription,
        wakeTime: trimmedWakeTime,
        bedTime: trimmedBedTime,
      },
      {
        onError: () =>
          setValidationError(
            "Saving failed. Check the connection and try again.",
          ),
      },
    );
  };

  // ---- RETURN ----

  return {
    occupation,
    setOccupation,
    workDescription,
    setWorkDescription,
    wakeTime,
    setWakeTime,
    bedTime,
    setBedTime,
    canSubmit,
    validationError,
    isSubmitting: updateProfileMutation.isPending,
    submit,
  };
};
