import { useQuery } from "@tanstack/react-query";
import { useRouter } from "expo-router";

import { sessionsQueryOptions } from "@/sessions/query-options/session-queries";
import { SessionSummary } from "@/sessions/types/session-types";

export const useHistoryModel = () => {
  const router = useRouter();
  const sessionsQuery = useQuery(sessionsQueryOptions());

  // ---- ACTIONS ----

  const openSession = (session: SessionSummary) => {
    router.push({
      pathname: "/session-detail",
      params: {
        device: session.device,
        session: String(session.session),
        startedAtMs: String(session.startedAtMs),
      },
    });
  };

  // ---- RETURN ----

  return {
    sessions: sessionsQuery.data ?? [],
    isLoading: sessionsQuery.isLoading,
    isRefetching: sessionsQuery.isRefetching,
    refetch: sessionsQuery.refetch,
    openSession,
  };
};
