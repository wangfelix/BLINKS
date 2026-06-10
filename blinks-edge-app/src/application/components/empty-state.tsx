import { ReactNode } from "react";
import { StyleSheet, View } from "react-native";

import { AppText } from "@/application/components/app-text";
import { colors, spacing } from "@/application/theme/theme";

interface EmptyStateProps {
  icon?: ReactNode;
  title: string;
  message: string;
}

export const EmptyState = ({ icon, title, message }: EmptyStateProps) => (
  <View style={styles.container}>
    {icon}
    <AppText variant="subheading">{title}</AppText>
    <AppText variant="caption" color={colors.textMuted} style={styles.message}>
      {message}
    </AppText>
  </View>
);

const styles = StyleSheet.create({
  container: {
    alignItems: "center",
    gap: spacing.sm,
    paddingVertical: spacing.xxl,
    paddingHorizontal: spacing.xl,
  },
  message: { textAlign: "center" },
});
