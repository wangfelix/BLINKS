import { CalendarCheckIcon, RecordIcon } from "phosphor-react-native";
import { StyleSheet, View } from "react-native";

import { AppButton } from "@/application/components/app-button";
import { AppCard } from "@/application/components/app-card";
import { AppText } from "@/application/components/app-text";
import { ScreenContainer } from "@/application/components/screen-container";
import { formatDate } from "@/application/utils/format-time";
import { colors, spacing } from "@/application/theme/theme";
import { StudyProgressCard } from "@/dashboard/components/study-progress-card";
import { useDashboardModel } from "@/dashboard/model/use-dashboard-model";
import { useCustomTabBarHeight } from "@/navigation/components/custom-tab-bar/utils/custom-tab-bar-hooks";

const DashboardScreen = () => {
  const tabBarHeight = useCustomTabBarHeight();
  const {
    username,
    participatedDays,
    remainingDays,
    hasSessionToday,
    isSessionActive,
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

      <StudyProgressCard
        participatedDays={participatedDays}
        remainingDays={remainingDays}
      />

      <AppCard style={styles.todayCard}>
        <CalendarCheckIcon
          size={28}
          color={hasSessionToday ? colors.success : colors.textMuted}
          weight={hasSessionToday ? "fill" : "regular"}
        />
        <View style={styles.todayText}>
          <AppText variant="subheading">Today&apos;s session</AppText>
          <AppText variant="caption">
            {isSessionActive
              ? "Recording in progress"
              : hasSessionToday
                ? "Completed — see History for the frames"
                : "Not started yet"}
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
          One session per day — you are done for today.
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
