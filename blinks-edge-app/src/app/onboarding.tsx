import { StyleSheet, View } from "react-native";
import { KeyboardAwareScrollView } from "react-native-keyboard-aware-scroll-view";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AppButton } from "@/application/components/app-button";
import { AppText } from "@/application/components/app-text";
import { AppTextInput } from "@/application/components/app-text-input";
import { colors, spacing } from "@/application/theme/theme";
import { useOnboardingModel } from "@/profile/model/use-onboarding-model";
import { useAppConfig } from "@/study/model/use-app-config";
import { FALLBACK_APP_TEXTS } from "@/study/utils/fallback-app-texts";

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
    formError,
    wakeTimeError,
    bedTimeError,
    isSubmitting,
    submit,
  } = useOnboardingModel();
  const texts = (useAppConfig().config?.texts.app ?? FALLBACK_APP_TEXTS)
    .onboarding;

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
        <AppText variant="title">{texts.title}</AppText>
        <AppText variant="body" color={colors.textSecondary}>
          {texts.intro}
        </AppText>
      </View>

      <View style={styles.form}>
        <AppTextInput
          label={texts.occupationLabel}
          value={occupation}
          onChangeText={setOccupation}
          placeholder={texts.occupationPlaceholder}
          autoCapitalize="sentences"
          multiline
          numberOfLines={2}
          returnKeyType="next"
          style={styles.occupationInput}
        />
        <AppTextInput
          label={texts.workDescriptionLabel}
          value={workDescription}
          onChangeText={setWorkDescription}
          placeholder={texts.workDescriptionPlaceholder}
          autoCapitalize="sentences"
          multiline
        />
        <View style={styles.timeRow}>
          <View style={styles.timeField}>
            <AppTextInput
              label={texts.wakeTimeLabel}
              value={wakeTime}
              onChangeText={setWakeTime}
              placeholder="07:30"
              keyboardType="numbers-and-punctuation"
              maxLength={5}
              errorMessage={wakeTimeError}
            />
          </View>
          <View style={styles.timeField}>
            <AppTextInput
              label={texts.bedTimeLabel}
              value={bedTime}
              onChangeText={setBedTime}
              placeholder="23:00"
              keyboardType="numbers-and-punctuation"
              maxLength={5}
              errorMessage={bedTimeError}
            />
          </View>
        </View>
        {formError ? (
          <AppText variant="caption" color={colors.danger}>
            {formError}
          </AppText>
        ) : null}
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
  occupationInput: { minHeight: 64, textAlignVertical: "center" },
  timeRow: { flexDirection: "row", gap: spacing.md },
  timeField: { flex: 1 },
});

export default OnboardingScreen;
