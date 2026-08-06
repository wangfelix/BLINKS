import { useQuery } from "@tanstack/react-query";
import { useRouter } from "expo-router";
import { Alert } from "react-native";

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
  const isSessionActive =
    session.kind === "study" && session.phase !== "idle";
  const isTestSessionActive =
    session.kind === "test" && session.phase !== "idle";
  const isAnySessionActive = isSessionActive || isTestSessionActive;
  const isRestoringSession = session.restorationStatus === "restoring";

  // Lifecycle state covers a session that has not produced a frame yet; the
  // frame-derived list remains a fallback for data created by an older app.
  const hasSession = session.hasKnownSession || sessions.length > 0;

  // The study has one session per participant. An unfinished restored session
  // can be reopened; an explicitly ended session cannot create a new ID.
  const canOpenSession =
    !isRestoringSession && (isAnySessionActive || !hasSession);
  const startButtonLabel = isRestoringSession
    ? "Restoring session…"
    : isAnySessionActive
      ? isTestSessionActive
        ? "Return to test recording"
        : "Return to session"
      : "Start session";

  // ---- ACTIONS ----

  const openSession = async () => {
    if (isRestoringSession) return;
    if (isAnySessionActive) {
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
    hasSession,
    isSessionActive,
    isTestSessionActive,
    isRestoringSession,
    canOpenSession,
    startButtonLabel,
    openSession,
  };
};
