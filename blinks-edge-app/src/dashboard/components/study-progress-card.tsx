import { StyleSheet, View } from "react-native";

import { AppCard } from "@/application/components/app-card";
import { AppText } from "@/application/components/app-text";
import { colors, spacing } from "@/application/theme/theme";

interface StudyProgressCardProps {
  studyDurationDays: number;
  participatedDays: number;
  remainingDays: number;
}

export const StudyProgressCard = ({
  studyDurationDays,
  participatedDays,
  remainingDays,
}: StudyProgressCardProps) => {
  const dayNumbers = Array.from(
    { length: studyDurationDays },
    (_, index) => index + 1,
  );

  return (
    <AppCard>
      <AppText variant="subheading">Study progress</AppText>
      <View style={styles.daysRow}>
        {dayNumbers.map((dayNumber) => {
          const isDone = dayNumber <= participatedDays;
          return (
            <View
              key={dayNumber}
              style={[styles.dayCircle, isDone && styles.dayCircleDone]}
            >
              <AppText
                variant="label"
                color={isDone ? colors.textOnAccent : colors.textMuted}
              >
                {dayNumber}
              </AppText>
            </View>
          );
        })}
      </View>
      <AppText variant="caption">
        {participatedDays} of {studyDurationDays} days completed
        {remainingDays > 0 ? ` · ${remainingDays} remaining` : " · all done!"}
      </AppText>
    </AppCard>
  );
};

const styles = StyleSheet.create({
  daysRow: {
    flexDirection: "row",
    gap: spacing.md,
    marginVertical: spacing.lg,
  },
  dayCircle: {
    width: 44,
    height: 44,
    borderRadius: 22,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: colors.surfaceMuted,
    borderWidth: 1,
    borderColor: colors.border,
  },
  dayCircleDone: {
    backgroundColor: colors.primary,
    borderColor: colors.primary,
  },
});
