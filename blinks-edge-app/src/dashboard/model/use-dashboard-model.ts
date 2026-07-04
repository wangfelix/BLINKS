import { useQuery } from "@tanstack/react-query";
import { useRouter } from "expo-router";
import { Alert } from "react-native";

import { appConfig } from "@/application/config/app-config";
import { toLocalDayKey } from "@/application/utils/format-time";
import { useAuth } from "@/authentication/context/auth-context";
import { useRecordingSession } from "@/capture/model/use-recording-session";
import { requestCapturePermissions } from "@/capture/permissions/request-capture-permissions";
import { profileQueryOptions } from "@/profile/query-options/profile-queries";
import { sessionsQueryOptions } from "@/sessions/query-options/session-queries";

export const useDashboardModel = () => {
  const router = useRouter();
  const { username } = useAuth();
  const { session, startSession } = useRecordingSession();
  const sessionsQuery = useQuery(sessionsQueryOptions());
  const profileQuery = useQuery(profileQueryOptions());

  // ---- STATE ----

  const sessions = sessionsQuery.data ?? [];
  const isSessionActive = session.phase !== "idle";
  const todayKey = toLocalDayKey(Date.now());

  const participatedDayKeys = new Set(
    sessions.map((entry) => toLocalDayKey(entry.startedAtMs)),
  );
  // A session running right now may not have reached the server list yet.
  if (isSessionActive) participatedDayKeys.add(todayKey);

  // The study length = the participant's DRM condition plan length; the
  // appConfig constant is only the fallback while the profile loads.
  const studyDurationDays =
    profileQuery.data?.studyDurationDays ?? appConfig.studyDurationDays;

  const participatedDays = Math.min(
    participatedDayKeys.size,
    studyDurationDays,
  );
  const remainingDays = studyDurationDays - participatedDays;
  const hasSessionToday = participatedDayKeys.has(todayKey);

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
    studyDurationDays,
    participatedDays,
    remainingDays,
    hasSessionToday,
    isSessionActive,
    canOpenSession,
    startButtonLabel,
    openSession,
  };
};
