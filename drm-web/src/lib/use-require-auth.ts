"use client";

import { useEffect, useSyncExternalStore } from "react";
import { useRouter } from "next/navigation";
import { useQuery } from "@tanstack/react-query";

import {
  getStoredToken,
  getStudyStatus,
  storeStudyRoutingState,
} from "@/lib/api-client";

const subscribeToNothing = () => () => {};

/** True after hydration (client render), false during SSR/prerender. */
const useIsHydrated = (): boolean =>
  useSyncExternalStore(
    subscribeToNothing,
    () => true,
    () => false,
  );

/**
 * Database-backed client guard: redirects unauthenticated visitors to login,
 * completed participants away from active study pages, and active
 * participants away from the completion page. The Next proxy mirrors this
 * with cookies for fast navigation; the API response remains authoritative.
 */
export const useRequireAuth = (
  studyAccess: "active" | "completed" = "active",
): boolean => {
  const router = useRouter();
  const isHydrated = useIsHydrated();
  const hasToken = isHydrated && getStoredToken() !== null;
  const studyStatusQuery = useQuery({
    queryKey: ["study-status"],
    queryFn: getStudyStatus,
    enabled: hasToken,
  });
  const studyCompleted = studyStatusQuery.data?.completed;

  useEffect(() => {
    if (!isHydrated) return;
    if (!hasToken) {
      router.replace("/");
      return;
    }
    if (studyCompleted === undefined) return;
    storeStudyRoutingState(studyCompleted);
    if (studyCompleted && studyAccess === "active") {
      router.replace("/done");
    } else if (!studyCompleted && studyAccess === "completed") {
      router.replace("/reconstruct");
    }
  }, [isHydrated, hasToken, router, studyAccess, studyCompleted]);

  if (!hasToken || studyCompleted === undefined) return false;
  return studyAccess === "completed" ? studyCompleted : !studyCompleted;
};
