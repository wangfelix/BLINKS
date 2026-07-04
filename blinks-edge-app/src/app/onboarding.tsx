import {
  KeyboardAvoidingView,
  Platform,
  ScrollView,
  StyleSheet,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AppButton } from "@/application/components/app-button";
import { AppText } from "@/application/components/app-text";
import { AppTextInput } from "@/application/components/app-text-input";
import { colors, spacing } from "@/application/theme/theme";
import { useOnboardingModel } from "@/profile/model/use-onboarding-model";

// Blocking onboarding step shown after sign-in until the participant has
// provided an occupation + work description (see the guard in _layout.tsx).
const OnboardingScreen = () => {
  const insets = useSafeAreaInsets();
  const {
    occupation,
    setOccupation,
    workDescription,
    setWorkDescription,
    validationError,
    isSubmitting,
    submit,
  } = useOnboardingModel();

  return (
    <KeyboardAvoidingView
      style={styles.container}
      behavior={Platform.OS === "ios" ? "padding" : undefined}
    >
      <ScrollView
        contentContainerStyle={[
          styles.content,
          { paddingTop: insets.top + spacing.xxl },
        ]}
        keyboardShouldPersistTaps="handled"
        showsVerticalScrollIndicator={false}
      >
        <View style={styles.header}>
          <AppText variant="title">Tell us about your work</AppText>
          <AppText variant="body" color={colors.textSecondary}>
            The AI assistant uses this to distinguish work from other
            activities in your day.
          </AppText>
        </View>

        <View style={styles.form}>
          <AppTextInput
            label="Occupation"
            value={occupation}
            onChangeText={setOccupation}
            placeholder="e.g. PhD student"
            autoCapitalize="sentences"
            returnKeyType="next"
          />
          <AppTextInput
            label="What your work consists of"
            value={workDescription}
            onChangeText={setWorkDescription}
            placeholder="e.g. writing papers, analyzing data, meetings"
            autoCapitalize="sentences"
            multiline
            errorMessage={validationError}
          />
          <AppButton
            label="Continue"
            onPress={submit}
            loading={isSubmitting}
            disabled={!occupation.trim() || !workDescription.trim()}
          />
        </View>
      </ScrollView>
    </KeyboardAvoidingView>
  );
};

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.background },
  content: {
    flexGrow: 1,
    justifyContent: "center",
    paddingHorizontal: spacing.xl,
    gap: spacing.xxl,
  },
  header: { gap: spacing.md },
  form: { gap: spacing.lg },
});

export default OnboardingScreen;
