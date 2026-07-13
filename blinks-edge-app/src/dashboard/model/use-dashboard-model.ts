import { useQuery } from "@tanstack/react-query";
import { useRouter } from "expo-router";
import { Alert } from "react-native";

import { toLocalDayKey } from "@/application/utils/format-time";
import { useAuth } from "@/authentication/context/auth-context";
import { useRecordingSession } from "@/capture/model/use-recording-session";
import { requestCapturePermissions } from "@/capture/permissions/request-capture-permissions";
import { sessionsQueryOptions } from "@/sessions/query-options/session-queries";

// Single-day study: the dashboard tracks exactly one recording day (today).
// The DRM design has one field day per participant; there is no multi-day
// progress to show.
export const useDashboardModel = () => {
  const router = useRouter();
  const { username } = useAuth();
  const { session, startSession } = useRecordingSession();
  const sessionsQuery = useQuery(sessionsQueryOptions());

  // ---- STATE ----

  const sessions = sessionsQuery.data ?? [];
  const isSessionActive = session.phase !== "idle";
  const todayKey = toLocalDayKey(Date.now());

  // A session running right now may not have reached the server list yet.
  const hasSessionToday =
    isSessionActive ||
    sessions.some((entry) => toLocalDayKey(entry.startedAtMs) === todayKey);

  // One self-administered session per day; an active session can always be
  // reopened.
  const canOpenSession = isSessionActive || !hasSessionToday;
  const startButtonLabel = isSessionActive
    ? "Return to session"
    : "Start session";

  // ---- ACTIONS ----

  const openSession = async () => {
    if (isSessionActive) {
      router.push("/recording");
      return;
    }
    const granted = await requestCapturePermissions();
    if (!granted) {
      Alert.alert(
        "Permissions needed",
        "BLINKS needs Bluetooth and notification permissions to record a session.",
      );
      return;
    }
    await startSession();
    router.push("/recording");
  };

  // ---- RETURN ----

  return {
    username,
    isLoading: sessionsQuery.isLoading,
    hasSessionToday,
    isSessionActive,
    canOpenSession,
    startButtonLabel,
    openSession,
  };
};
