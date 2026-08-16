import {
  CameraIcon,
  CameraRotateIcon,
  LockKeyIcon,
  RecordIcon,
  TestTubeIcon,
} from "phosphor-react-native";
import { useState } from "react";
import { Pressable, StyleSheet, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AppButton } from "@/application/components/app-button";
import { AppCard } from "@/application/components/app-card";
import { AppText } from "@/application/components/app-text";
import { AppTextInput } from "@/application/components/app-text-input";
import { ScreenContainer } from "@/application/components/screen-container";
import { appConfig } from "@/application/config/app-config";
import { colors, radius, spacing } from "@/application/theme/theme";
import { useStudySettingsModel } from "@/study-settings/model/use-study-settings-model";
import { CAMERA_FORM_FACTORS } from "@/study-settings/types/camera-form-factor";
import type { CameraFormFactor } from "@/study-settings/types/camera-form-factor";
import { IMAGE_ROTATIONS } from "@/study-settings/types/image-rotation";
import type { ImageRotation } from "@/study-settings/types/image-rotation";

const rotationLabel = (rotation: ImageRotation): string =>
  rotation === 0 ? "None" : `${rotation}°`;

const cameraFormFactorLabel: Record<CameraFormFactor, string> = {
  necklace: "Necklace",
  glasses: "Glasses",
};

const StudySettingsScreen = () => {
  const insets = useSafeAreaInsets();
  const [isUnlocked, setIsUnlocked] = useState(false);
  const [pin, setPin] = useState("");
  const [pinError, setPinError] = useState<string | null>(null);
  const {
    cameraFormFactor,
    isLoadingCameraFormFactor,
    isSavingCameraFormFactor,
    imageRotation,
    isLoadingRotation,
    isSavingRotation,
    canOpenTestSession,
    testSessionButtonLabel,
    isStartingRecording,
    selectCameraFormFactor,
    selectImageRotation,
    openTestRecording,
  } = useStudySettingsModel();

  const unlock = () => {
    if (pin === appConfig.studySettingsPin) {
      setPinError(null);
      setIsUnlocked(true);
      return;
    }
    setPinError("Incorrect PIN");
  };

  if (!isUnlocked) {
    return (
      <ScreenContainer
        scrollable
        keyboardAware
        includeTopInset={false}
        bottomSpacing={insets.bottom}
      >
        <AppCard style={styles.card}>
          <View style={styles.sectionHeader}>
            <LockKeyIcon size={28} color={colors.primary} weight="fill" />
            <View style={styles.headerText}>
              <AppText variant="subheading">Enter Study Settings PIN</AppText>
              <AppText variant="caption">
                These settings are intended for the research team.
              </AppText>
            </View>
          </View>
          <AppTextInput
            label="PIN"
            value={pin}
            onChangeText={(value) => {
              setPin(value.replace(/\D/g, ""));
              setPinError(null);
            }}
            secureTextEntry
            keyboardType="number-pad"
            maxLength={Math.max(4, appConfig.studySettingsPin.length)}
            errorMessage={pinError}
            autoFocus
          />
          <AppButton
            label="Unlock"
            onPress={unlock}
            disabled={pin.length === 0}
          />
        </AppCard>
      </ScreenContainer>
    );
  }

  return (
    <ScreenContainer
      scrollable
      includeTopInset={false}
      bottomSpacing={insets.bottom}
    >
      <AppCard style={styles.card}>
        <View style={styles.sectionHeader}>
          <CameraIcon size={28} color={colors.primary} weight="fill" />
          <View style={styles.headerText}>
            <AppText variant="subheading">Camera type</AppText>
            <AppText variant="caption">
              Select how this participant wears the camera.
            </AppText>
          </View>
        </View>

        <View style={styles.cameraTypeOptions}>
          {CAMERA_FORM_FACTORS.map((candidate) => {
            const isSelected = candidate === cameraFormFactor;
            return (
              <Pressable
                key={candidate}
                accessibilityRole="radio"
                accessibilityState={{ selected: isSelected }}
                accessibilityLabel={`${cameraFormFactorLabel[candidate]} camera`}
                disabled={
                  isLoadingCameraFormFactor || isSavingCameraFormFactor
                }
                onPress={() => void selectCameraFormFactor(candidate)}
                style={({ pressed }) => [
                  styles.cameraTypeOption,
                  isSelected && styles.rotationOptionSelected,
                  pressed && styles.rotationOptionPressed,
                  (isLoadingCameraFormFactor || isSavingCameraFormFactor) &&
                    styles.disabled,
                ]}
              >
                <AppText
                  variant="label"
                  color={isSelected ? colors.primary : colors.textSecondary}
                >
                  {cameraFormFactorLabel[candidate]}
                </AppText>
              </Pressable>
            );
          })}
        </View>
      </AppCard>

      <AppCard style={styles.card}>
        <View style={styles.sectionHeader}>
          <CameraRotateIcon size={28} color={colors.primary} weight="fill" />
          <View style={styles.headerText}>
            <AppText variant="subheading">Image rotation</AppText>
            <AppText variant="caption">
              Rotate every camera image clockwise before it is uploaded.
            </AppText>
          </View>
        </View>

        <View style={styles.rotationOptions}>
          {IMAGE_ROTATIONS.map((rotation) => {
            const isSelected = rotation === imageRotation;
            return (
              <Pressable
                key={rotation}
                accessibilityRole="radio"
                accessibilityState={{ selected: isSelected }}
                accessibilityLabel={`${rotationLabel(rotation)} image rotation`}
                disabled={isLoadingRotation || isSavingRotation}
                onPress={() => void selectImageRotation(rotation)}
                style={({ pressed }) => [
                  styles.rotationOption,
                  isSelected && styles.rotationOptionSelected,
                  pressed && styles.rotationOptionPressed,
                  (isLoadingRotation || isSavingRotation) && styles.disabled,
                ]}
              >
                <AppText
                  variant="label"
                  color={isSelected ? colors.primary : colors.textSecondary}
                >
                  {rotationLabel(rotation)}
                </AppText>
              </Pressable>
            );
          })}
        </View>
      </AppCard>

      <AppCard style={styles.card}>
        <View style={styles.sectionHeader}>
          <TestTubeIcon size={28} color={colors.primary} weight="fill" />
          <View style={styles.headerText}>
            <AppText variant="subheading">Lab test recording</AppText>
            <AppText variant="caption">
              Check the camera, image orientation, and pause controls before
              the field day. Test photos are stored separately and do not count
              as the study session.
            </AppText>
          </View>
        </View>
        <AppButton
          label={testSessionButtonLabel}
          onPress={() => void openTestRecording()}
          disabled={
            !canOpenTestSession || isLoadingRotation || isSavingRotation
          }
          loading={isStartingRecording}
          icon={<RecordIcon size={20} color={colors.textOnAccent} weight="fill" />}
        />
        {!canOpenTestSession ? (
          <AppText variant="caption" style={styles.testUnavailableHint}>
            Test recording is available only before the main session starts.
          </AppText>
        ) : null}
      </AppCard>
    </ScreenContainer>
  );
};

const styles = StyleSheet.create({
  card: { gap: spacing.lg },
  sectionHeader: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: spacing.md,
  },
  headerText: { flex: 1, gap: spacing.xs },
  rotationOptions: {
    flexDirection: "row",
    gap: spacing.sm,
  },
  cameraTypeOptions: {
    flexDirection: "row",
    gap: spacing.sm,
  },
  cameraTypeOption: {
    flex: 1,
    minHeight: 52,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface,
  },
  rotationOption: {
    flex: 1,
    minHeight: 48,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface,
  },
  rotationOptionSelected: {
    borderColor: colors.primary,
    borderWidth: 2,
    backgroundColor: colors.primaryMuted,
  },
  rotationOptionPressed: { opacity: 0.8 },
  disabled: { opacity: 0.6 },
  testUnavailableHint: { textAlign: "center" },
});

export default StudySettingsScreen;
