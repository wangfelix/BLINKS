import { KeyboardAvoidingView, Platform, StyleSheet, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AppButton } from "@/application/components/app-button";
import { AppText } from "@/application/components/app-text";
import { AppTextInput } from "@/application/components/app-text-input";
import { colors, spacing } from "@/application/theme/theme";
import { useLoginModel } from "@/authentication/model/use-login-model";

const LoginScreen = () => {
  const insets = useSafeAreaInsets();
  const {
    username,
    setUsername,
    password,
    setPassword,
    errorMessage,
    isSubmitting,
    canSubmit,
    submit,
  } = useLoginModel();

  return (
    <KeyboardAvoidingView
      style={[styles.container, { paddingTop: insets.top }]}
      behavior={Platform.OS === "ios" ? "padding" : undefined}
    >
      <View style={styles.content}>
        <View style={styles.header}>
          <AppText variant="title" style={styles.brand}>
            BLINKS
          </AppText>
          <AppText variant="caption" style={styles.subtitle}>
            Wearable camera study · KD2Lab, KIT
          </AppText>
        </View>

        <View style={styles.form}>
          <AppTextInput
            label="Username"
            value={username}
            onChangeText={setUsername}
            placeholder="participant1"
            autoComplete="username"
            returnKeyType="next"
          />
          <AppTextInput
            label="Password"
            value={password}
            onChangeText={setPassword}
            placeholder="••••••••"
            secureTextEntry
            autoComplete="current-password"
            returnKeyType="done"
            onSubmitEditing={submit}
            errorMessage={errorMessage}
          />
          <AppButton
            label="Sign in"
            onPress={submit}
            disabled={!canSubmit}
            loading={isSubmitting}
          />
        </View>
      </View>
    </KeyboardAvoidingView>
  );
};

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.background },
  content: {
    flex: 1,
    justifyContent: "center",
    paddingHorizontal: spacing.xl,
    gap: spacing.xxl,
  },
  header: { alignItems: "center", gap: spacing.xs },
  brand: { letterSpacing: 6 },
  subtitle: { textAlign: "center" },
  form: { gap: spacing.lg },
});

export default LoginScreen;
