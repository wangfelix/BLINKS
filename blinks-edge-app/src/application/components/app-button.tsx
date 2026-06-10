import { ReactNode } from "react";
import {
  ActivityIndicator,
  Pressable,
  StyleSheet,
  TextStyle,
  ViewStyle,
} from "react-native";

import { AppText } from "@/application/components/app-text";
import { colors, radius, spacing } from "@/application/theme/theme";

type ButtonVariant = "primary" | "secondary" | "danger" | "onColor";

interface AppButtonProps {
  label: string;
  onPress: () => void;
  variant?: ButtonVariant;
  disabled?: boolean;
  loading?: boolean;
  icon?: ReactNode;
  style?: ViewStyle;
}

const containerByVariant: Record<ButtonVariant, ViewStyle> = {
  primary: { backgroundColor: colors.primary },
  secondary: { backgroundColor: colors.surfaceMuted },
  danger: { backgroundColor: colors.dangerMuted },
  // For use on the colored full-screen recording view.
  onColor: { backgroundColor: "rgba(255,255,255,0.92)" },
};

const labelColorByVariant: Record<ButtonVariant, string> = {
  primary: colors.textOnAccent,
  secondary: colors.textPrimary,
  danger: colors.danger,
  onColor: colors.textPrimary,
};

export const AppButton = ({
  label,
  onPress,
  variant = "primary",
  disabled = false,
  loading = false,
  icon,
  style,
}: AppButtonProps) => {
  const isInactive = disabled || loading;
  const labelStyle: TextStyle = { color: labelColorByVariant[variant] };

  return (
    <Pressable
      onPress={onPress}
      disabled={isInactive}
      style={({ pressed }) => [
        styles.container,
        containerByVariant[variant],
        pressed && styles.pressed,
        isInactive && styles.disabled,
        style,
      ]}
    >
      {loading ? (
        <ActivityIndicator color={labelColorByVariant[variant]} />
      ) : (
        <>
          {icon}
          <AppText variant="subheading" style={labelStyle}>
            {label}
          </AppText>
        </>
      )}
    </Pressable>
  );
};

const styles = StyleSheet.create({
  container: {
    minHeight: 52,
    borderRadius: radius.md,
    alignItems: "center",
    justifyContent: "center",
    flexDirection: "row",
    gap: spacing.sm,
    paddingHorizontal: spacing.lg,
  },
  pressed: { opacity: 0.85 },
  disabled: { opacity: 0.5 },
});
