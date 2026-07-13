import { useQuery } from "@tanstack/react-query";
import { useState } from "react";

import { isValidTimeOfDay } from "@/profile/api/profile-api";
import { useUpdateProfileMutation } from "@/profile/model/use-update-profile-mutation";
import { profileQueryOptions } from "@/profile/query-options/profile-queries";

// Backs the "About you" card on the Profile tab: shows the stored occupation,
// work description and daily schedule with an inline edit flow (same PUT
// mutation as onboarding — the server requires all four fields together).
export const useOccupationModel = () => {
  // ---- STATE ----

  const profileQuery = useQuery(profileQueryOptions());
  const updateProfileMutation = useUpdateProfileMutation();

  const [isEditing, setIsEditing] = useState(false);
  const [occupationDraft, setOccupationDraft] = useState("");
  const [workDescriptionDraft, setWorkDescriptionDraft] = useState("");
  const [wakeTimeDraft, setWakeTimeDraft] = useState("");
  const [bedTimeDraft, setBedTimeDraft] = useState("");
  const [validationError, setValidationError] = useState<string | null>(null);

  // ---- ACTIONS ----

  const startEditing = () => {
    setOccupationDraft(profileQuery.data?.occupation ?? "");
    setWorkDescriptionDraft(profileQuery.data?.workDescription ?? "");
    setWakeTimeDraft(profileQuery.data?.wakeTime ?? "");
    setBedTimeDraft(profileQuery.data?.bedTime ?? "");
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
    const trimmedWakeTime = wakeTimeDraft.trim();
    const trimmedBedTime = bedTimeDraft.trim();
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
    wakeTime: profileQuery.data?.wakeTime ?? null,
    bedTime: profileQuery.data?.bedTime ?? null,
    isLoading: profileQuery.isLoading,
    isEditing,
    occupationDraft,
    setOccupationDraft,
    workDescriptionDraft,
    setWorkDescriptionDraft,
    wakeTimeDraft,
    setWakeTimeDraft,
    bedTimeDraft,
    setBedTimeDraft,
    validationError,
    isSaving: updateProfileMutation.isPending,
    startEditing,
    cancelEditing,
    saveEdits,
  };
};
