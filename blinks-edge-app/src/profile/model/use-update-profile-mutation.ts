import { useMutation, useQueryClient } from "@tanstack/react-query";

import {
  ParticipantProfile,
  ProfileUpdateInput,
  updateProfile,
} from "@/profile/api/profile-api";
import { profileKeys } from "@/profile/query-options/profile-queries";

// Shared by the onboarding screen and the Profile tab's edit card: PUT the new
// values, then write them into the cached profile immediately (the onboarding
// gate in the root layout reads that cache, so this is what unblocks the tabs
// without waiting for a refetch).
export const useUpdateProfileMutation = () => {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (input: ProfileUpdateInput) => updateProfile(input),
    onSuccess: (_response, input) => {
      queryClient.setQueryData<ParticipantProfile>(
        profileKeys.detail(),
        (previous) => (previous ? { ...previous, ...input } : previous),
      );
      void queryClient.invalidateQueries({ queryKey: profileKeys.all });
    },
  });
};
