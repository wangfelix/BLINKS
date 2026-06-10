import { CaretRightIcon } from "phosphor-react-native";
import { StyleSheet, View } from "react-native";

import { AppCard } from "@/application/components/app-card";
import { AppText } from "@/application/components/app-text";
import {
  formatDate,
  formatTimeOfDay,
} from "@/application/utils/format-time";
import { colors, spacing } from "@/application/theme/theme";
import { SessionSummary } from "@/sessions/types/session-types";

interface SessionListItemProps {
  session: SessionSummary;
  onPress: () => void;
}

export const SessionListItem = ({ session, onPress }: SessionListItemProps) => (
  <AppCard onPress={onPress} style={styles.card}>
    <View style={styles.textColumn}>
      <AppText variant="subheading">{formatDate(session.startedAtMs)}</AppText>
      <AppText variant="caption">
        {formatTimeOfDay(session.startedAtMs)} –{" "}
        {formatTimeOfDay(session.endedAtMs)} · {session.frameCount} frames
      </AppText>
    </View>
    <CaretRightIcon size={20} color={colors.textMuted} />
  </AppCard>
);

const styles = StyleSheet.create({
  card: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: spacing.md,
  },
  textColumn: { gap: spacing.xs, flex: 1 },
});
