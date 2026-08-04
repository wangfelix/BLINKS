import { queryOptions } from "@tanstack/react-query";

import { fetchStudyStatus } from "@/study/api/study-api";

export const studyKeys = {
  all: ["study"] as const,
  status: () => [...studyKeys.all, "status"] as const,
};

export const studyStatusQueryOptions = () =>
  queryOptions({
    queryKey: studyKeys.status(),
    queryFn: fetchStudyStatus,
  });
