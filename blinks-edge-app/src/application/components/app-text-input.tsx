import { useState } from "react";
import { StyleSheet, TextInput, TextInputProps, View } from "react-native";

import { AppText } from "@/application/components/app-text";
import { colors, radius, spacing } from "@/application/theme/theme";

interface AppTextInputProps extends TextInputProps {
  label: string;
  errorMessage?: string | null;
}

export const AppTextInput = ({
  label,
  errorMessage,
  ...inputProps
}: AppTextInputProps) => {
  const [isFocused, setIsFocused] = useState(false);

  return (
    <View style={styles.container}>
      <AppText variant="label">{label}</AppText>
      <TextInput
        style={[
          styles.input,
          inputProps.multiline && styles.inputMultiline,
          isFocused && styles.inputFocused,
          !!errorMessage && styles.inputError,
        ]}
        placeholderTextColor={colors.textMuted}
        onFocus={() => setIsFocused(true)}
        onBlur={() => setIsFocused(false)}
        autoCapitalize="none"
        {...inputProps}
      />
      {errorMessage ? (
        <AppText variant="caption" color={colors.danger}>
          {errorMessage}
        </AppText>
      ) : null}
    </View>
  );
};

const styles = StyleSheet.create({
  container: { gap: spacing.xs },
  input: {
    backgroundColor: colors.surface,
    borderColor: colors.border,
    borderWidth: 1,
    borderRadius: radius.md,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
    fontSize: 16,
    color: colors.textPrimary,
  },
  inputMultiline: { minHeight: 96, textAlignVertical: "top" },
  inputFocused: { borderColor: colors.primary },
  inputError: { borderColor: colors.danger },
});
