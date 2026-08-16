import { useQuery } from "@tanstack/react-query";
import { useState } from "react";

import { isValidTimeOfDay } from "@/profile/api/profile-api";
import { useUpdateProfileMutation } from "@/profile/model/use-update-profile-mutation";
import { profileQueryOptions } from "@/profile/query-options/profile-queries";

const TIME_FORMAT_ERROR =
  "Times must be HH:MM (24-hour), e.g. 07:30 or 23:00.";

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
  const [formError, setFormError] = useState<string | null>(null);
  const [wakeTimeError, setWakeTimeError] = useState<string | null>(null);
  const [bedTimeError, setBedTimeError] = useState<string | null>(null);

  // ---- ACTIONS ----

  const startEditing = () => {
    setOccupationDraft(profileQuery.data?.occupation ?? "");
    setWorkDescriptionDraft(profileQuery.data?.workDescription ?? "");
    setWakeTimeDraft(profileQuery.data?.wakeTime ?? "");
    setBedTimeDraft(profileQuery.data?.bedTime ?? "");
    setFormError(null);
    setWakeTimeError(null);
    setBedTimeError(null);
    setIsEditing(true);
  };

  const cancelEditing = () => {
    setIsEditing(false);
    setFormError(null);
    setWakeTimeError(null);
    setBedTimeError(null);
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
      setFormError("Fill in all fields.");
      setWakeTimeError(null);
      setBedTimeError(null);
      return;
    }
    const isWakeTimeValid = isValidTimeOfDay(trimmedWakeTime);
    const isBedTimeValid = isValidTimeOfDay(trimmedBedTime);
    if (!isWakeTimeValid || !isBedTimeValid) {
      setFormError(null);
      setWakeTimeError(isWakeTimeValid ? null : TIME_FORMAT_ERROR);
      setBedTimeError(isBedTimeValid ? null : TIME_FORMAT_ERROR);
      return;
    }
    setFormError(null);
    setWakeTimeError(null);
    setBedTimeError(null);
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
          setFormError(
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
    formError,
    wakeTimeError,
    bedTimeError,
    isSaving: updateProfileMutation.isPending,
    startEditing,
    cancelEditing,
    saveEdits,
  };
};
