import { queryOptions } from "@tanstack/react-query";

import { fetchProfile } from "@/profile/api/profile-api";

export const profileKeys = {
  all: ["profile"] as const,
  detail: () => [...profileKeys.all, "detail"] as const,
};

export const profileQueryOptions = () =>
  queryOptions({
    queryKey: profileKeys.detail(),
    queryFn: fetchProfile,
  });
