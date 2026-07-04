import { useQuery } from "@tanstack/react-query";
import { useState } from "react";

import { useUpdateProfileMutation } from "@/profile/model/use-update-profile-mutation";
import { profileQueryOptions } from "@/profile/query-options/profile-queries";

// Backs the "About your work" card on the Profile tab: shows the stored
// occupation + work description with an inline edit flow (same PUT mutation
// as onboarding).
export const useOccupationModel = () => {
  // ---- STATE ----

  const profileQuery = useQuery(profileQueryOptions());
  const updateProfileMutation = useUpdateProfileMutation();

  const [isEditing, setIsEditing] = useState(false);
  const [occupationDraft, setOccupationDraft] = useState("");
  const [workDescriptionDraft, setWorkDescriptionDraft] = useState("");
  const [validationError, setValidationError] = useState<string | null>(null);

  // ---- ACTIONS ----

  const startEditing = () => {
    setOccupationDraft(profileQuery.data?.occupation ?? "");
    setWorkDescriptionDraft(profileQuery.data?.workDescription ?? "");
    setValidationError(null);
    setIsEditing(true);
  };

  const cancelEditing = () => {
    setIsEditing(false);
    setValidationError(null);
  };

  const saveEdits = () => {
    const trimmedOccupation = occupationDraft.trim();
    const trimmedWorkDescription = workDescriptionDraft.trim();
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
        onSuccess: () => setIsEditing(false),
        onError: () =>
          setValidationError(
            "Saving failed. Check the connection and try again.",
          ),
      },
    );
  };

  // ---- RETURN ----

  return {
    occupation: profileQuery.data?.occupation ?? null,
    workDescription: profileQuery.data?.workDescription ?? null,
    isLoading: profileQuery.isLoading,
    isEditing,
    occupationDraft,
    setOccupationDraft,
    workDescriptionDraft,
    setWorkDescriptionDraft,
    validationError,
    isSaving: updateProfileMutation.isPending,
    startEditing,
    cancelEditing,
    saveEdits,
  };
};
