import { ReactNode } from "react";
import { Pressable, StyleSheet, View, ViewStyle } from "react-native";

import { colors, radius, spacing } from "@/application/theme/theme";

interface AppCardProps {
  children: ReactNode;
  onPress?: () => void;
  style?: ViewStyle;
}

export const AppCard = ({ children, onPress, style }: AppCardProps) => {
  if (onPress) {
    return (
      <Pressable
        onPress={onPress}
        style={({ pressed }) => [styles.card, pressed && styles.pressed, style]}
      >
        {children}
      </Pressable>
    );
  }
  return <View style={[styles.card, style]}>{children}</View>;
};

const styles = StyleSheet.create({
  card: {
    backgroundColor: colors.surface,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.border,
    padding: spacing.lg,
  },
  pressed: { opacity: 0.9 },
});
