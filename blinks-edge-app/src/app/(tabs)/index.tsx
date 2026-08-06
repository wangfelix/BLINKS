import { CalendarCheckIcon, RecordIcon } from "phosphor-react-native";
import { StyleSheet, View } from "react-native";

import { AppButton } from "@/application/components/app-button";
import { AppCard } from "@/application/components/app-card";
import { AppText } from "@/application/components/app-text";
import { ScreenContainer } from "@/application/components/screen-container";
import { formatDate } from "@/application/utils/format-time";
import { colors, spacing } from "@/application/theme/theme";
import { useDashboardModel } from "@/dashboard/model/use-dashboard-model";
import { useCustomTabBarHeight } from "@/navigation/components/custom-tab-bar/utils/custom-tab-bar-hooks";

const DashboardScreen = () => {
  const tabBarHeight = useCustomTabBarHeight();
  const {
    username,
    hasSession,
    isSessionActive,
    isTestSessionActive,
    isRestoringSession,
    canOpenSession,
    startButtonLabel,
    openSession,
  } = useDashboardModel();

  return (
    <ScreenContainer scrollable bottomSpacing={tabBarHeight}>
      <View style={styles.header}>
        <AppText variant="title">Hello, {username ?? "participant"}</AppText>
        <AppText variant="caption">{formatDate(Date.now())}</AppText>
      </View>

      <AppCard style={styles.todayCard}>
        <CalendarCheckIcon
          size={28}
          color={hasSession ? colors.success : colors.textMuted}
          weight={hasSession ? "fill" : "regular"}
        />
        <View style={styles.todayText}>
          <AppText variant="subheading">Your recording day</AppText>
          <AppText variant="caption">
            {isRestoringSession
              ? "Restoring your unfinished recording…"
              : isTestSessionActive
                ? "Lab test in progress — your main recording has not started"
              : isSessionActive
                ? "Recording in progress — wear the glasses through your day"
                : hasSession
                  ? "Completed — reconstruct your day on the website this evening"
                  : "Not started yet — start the session when your day begins"}
          </AppText>
        </View>
      </AppCard>

      <AppButton
        label={startButtonLabel}
        onPress={() => void openSession()}
        disabled={!canOpenSession}
        icon={<RecordIcon size={22} color={colors.textOnAccent} weight="fill" />}
        style={styles.startButton}
      />
      {!canOpenSession ? (
        <AppText variant="caption" style={styles.hint}>
          {isRestoringSession
            ? "Reconnecting to your existing session."
            : "Your study recording session is complete."}
        </AppText>
      ) : null}
    </ScreenContainer>
  );
};

const styles = StyleSheet.create({
  header: { gap: spacing.xs },
  todayCard: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.lg,
  },
  todayText: { gap: spacing.xs, flex: 1 },
  startButton: { minHeight: 60 },
  hint: { textAlign: "center" },
});

export default DashboardScreen;
