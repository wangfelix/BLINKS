import { StyleSheet, View } from "react-native";
import { KeyboardAwareScrollView } from "react-native-keyboard-aware-scroll-view";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AppButton } from "@/application/components/app-button";
import { AppText } from "@/application/components/app-text";
import { AppTextInput } from "@/application/components/app-text-input";
import { colors, spacing } from "@/application/theme/theme";
import { useOnboardingModel } from "@/profile/model/use-onboarding-model";

// Blocking onboarding step shown after sign-in until the participant has
// provided an occupation + work description (VLM classification context) and
// their usual wake/bed times (the bedtime drives the evening fallback push
// reminder). See the guard in _layout.tsx.
const OnboardingScreen = () => {
  const insets = useSafeAreaInsets();
  const {
    occupation,
    setOccupation,
    workDescription,
    setWorkDescription,
    wakeTime,
    setWakeTime,
    bedTime,
    setBedTime,
    canSubmit,
    validationError,
    isSubmitting,
    submit,
  } = useOnboardingModel();

  return (
    <KeyboardAwareScrollView
      style={styles.container}
      contentContainerStyle={[
        styles.content,
        { paddingTop: insets.top + spacing.xxl },
      ]}
      automaticallyAdjustKeyboardInsets
      enableOnAndroid
      extraScrollHeight={spacing.lg}
      keyboardShouldPersistTaps="handled"
      showsVerticalScrollIndicator={false}
    >
      <View style={styles.header}>
        <AppText variant="title">Tell us about yourself</AppText>
        <AppText variant="body" color={colors.textSecondary}>
          The AI assistant uses your work description to distinguish work from
          other activities; your usual schedule times the evening reminder.
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
        />
        <View style={styles.timeRow}>
          <View style={styles.timeField}>
            <AppTextInput
              label="Usual wake-up time"
              value={wakeTime}
              onChangeText={setWakeTime}
              placeholder="07:30"
              keyboardType="numbers-and-punctuation"
              maxLength={5}
            />
          </View>
          <View style={styles.timeField}>
            <AppTextInput
              label="Usual bedtime"
              value={bedTime}
              onChangeText={setBedTime}
              placeholder="23:00"
              keyboardType="numbers-and-punctuation"
              maxLength={5}
              errorMessage={validationError}
            />
          </View>
        </View>
        <AppButton
          label="Continue"
          onPress={submit}
          loading={isSubmitting}
          disabled={!canSubmit}
        />
      </View>
    </KeyboardAwareScrollView>
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
  timeRow: { flexDirection: "row", gap: spacing.md },
  timeField: { flex: 1 },
});

export default OnboardingScreen;
