"use client";

import { useEffect, useSyncExternalStore } from "react";
import { useRouter } from "next/navigation";

import { getStoredToken } from "@/lib/api-client";

const subscribeToNothing = () => () => {};

/** True after hydration (client render), false during SSR/prerender. */
const useIsHydrated = (): boolean =>
  useSyncExternalStore(
    subscribeToNothing,
    () => true,
    () => false,
  );

/**
 * Client-side auth guard: redirects to the login page ("/") when no token is
 * stored. Returns true once a token is present, so callers can avoid flashing
 * protected content.
 */
export const useRequireAuth = (): boolean => {
  const router = useRouter();
  const isHydrated = useIsHydrated();
  const hasToken = isHydrated && getStoredToken() !== null;

  useEffect(() => {
    if (isHydrated && !hasToken) router.replace("/");
  }, [isHydrated, hasToken, router]);

  return hasToken;
};
