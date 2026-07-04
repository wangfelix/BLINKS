import { useState } from "react";

import { useUpdateProfileMutation } from "@/profile/model/use-update-profile-mutation";

export const useOnboardingModel = () => {
  // ---- STATE ----

  const [occupation, setOccupation] = useState("");
  const [workDescription, setWorkDescription] = useState("");
  const [validationError, setValidationError] = useState<string | null>(null);

  const updateProfileMutation = useUpdateProfileMutation();

  // ---- ACTIONS ----

  // On success the cached profile carries a non-empty occupation, the
  // onboarding guard in the root layout flips, and Expo Router moves to the
  // tabs on its own — no manual navigation needed here.
  const submit = () => {
    const trimmedOccupation = occupation.trim();
    const trimmedWorkDescription = workDescription.trim();
    if (!trimmedOccupation || !trimmedWorkDescription) {
      setValidationError("Fill in both fields.");
      return;
    }
    setValidationError(null);
    updateProfileMutation.mutate(
      {
        occupation: trimmedOccupation,
        workDescription: trimmedWorkDescription,
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
    validationError,
    isSubmitting: updateProfileMutation.isPending,
    submit,
  };
};
