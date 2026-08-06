import { useEffect } from "react";
import { Pressable, StyleSheet, View } from "react-native";
import Animated, {
  interpolateColor,
  useAnimatedStyle,
  useSharedValue,
  withTiming,
} from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AppButton } from "@/application/components/app-button";
import { AppText } from "@/application/components/app-text";
import { colors, radius, spacing } from "@/application/theme/theme";
import { EndSessionConfirmationModal } from "@/capture/components/end-session-confirmation-modal";
import { RecordingMetadataCard } from "@/capture/components/recording-metadata-card";
import { RecordingStatusPill } from "@/capture/components/recording-status-pill";
import { useRecordingScreenModel } from "@/capture/model/use-recording-screen-model";

const RecordingScreen = () => {
  const insets = useSafeAreaInsets();
  const {
    isIdle,
    isPaused,
    isTestSession,
    elapsedLabel,
    cameraStatusLabel,
    serverStatusLabel,
    framesLabel,
    lastFrameLabel,
    isEndSessionAvailable,
    isEndConfirmationVisible,
    isEnding,
    togglePause,
    confirmEndSession,
    cancelEndSession,
    endSelectedSession,
    closeScreen,
  } = useRecordingScreenModel();

  // 0 = recording (green), 1 = paused (neutral); animated on every toggle.
  const pausedProgress = useSharedValue(isPaused ? 1 : 0);
  useEffect(() => {
    pausedProgress.value = withTiming(isPaused ? 1 : 0, { duration: 450 });
  }, [isPaused, pausedProgress]);

  const backgroundStyle = useAnimatedStyle(() => ({
    backgroundColor: interpolateColor(
      pausedProgress.value,
      [0, 1],
      [colors.recordingActive, colors.recordingPaused],
    ),
  }));

  if (isIdle) {
    // Reached without an active session (e.g. after ending it): offer the way
    // back instead of a dead screen.
    return (
      <View style={[styles.idleContainer, { paddingTop: insets.top }]}>
        <AppText variant="heading">No active session</AppText>
        <AppButton label="Back to Dashboard" onPress={closeScreen} />
      </View>
    );
  }

  return (
    <Animated.View style={[styles.container, backgroundStyle]}>
      <View
        style={[
          styles.content,
          {
            paddingTop: insets.top + spacing.xl,
            paddingBottom: insets.bottom + spacing.xl,
          },
        ]}
      >
        <RecordingStatusPill
          isPaused={isPaused}
          isTestSession={isTestSession}
        />

        <View style={styles.elapsedBlock}>
          <AppText style={styles.elapsedTime} color={colors.textOnAccent}>
            {elapsedLabel}
          </AppText>
          <AppText variant="label" color="rgba(255,255,255,0.75)">
            recorded time
          </AppText>
        </View>

        <RecordingMetadataCard
          rows={[
            { label: "Camera", value: cameraStatusLabel },
            { label: "Server", value: serverStatusLabel },
            { label: "Frames", value: framesLabel },
            { label: "Last frame", value: lastFrameLabel },
          ]}
        />

        <View style={styles.buttonColumn}>
          <AppButton
            label={isPaused ? "Resume recording" : "Pause recording"}
            onPress={togglePause}
            variant="onColor"
            style={styles.pauseButton}
          />
          <View style={styles.endButtonBlock}>
            <Pressable
              onPress={confirmEndSession}
              disabled={!isEndSessionAvailable}
              accessibilityRole="button"
              accessibilityLabel={
                isEndSessionAvailable
                  ? isTestSession
                    ? "End test session"
                    : "End session"
                  : "End session, available from 19:00"
              }
              accessibilityState={{ disabled: !isEndSessionAvailable }}
              style={({ pressed }) => [
                styles.endButton,
                pressed && styles.endButtonPressed,
                !isEndSessionAvailable && styles.endButtonDisabled,
              ]}
            >
              <AppText variant="subheading" color={colors.textOnAccent}>
                {isTestSession ? "End test session" : "End session"}
              </AppText>
            </Pressable>
            {!isEndSessionAvailable && (
              <AppText
                variant="caption"
                color="rgba(255,255,255,0.75)"
                style={styles.endAvailabilityLabel}
              >
                Available from 19:00
              </AppText>
            )}
          </View>
        </View>
      </View>

      <EndSessionConfirmationModal
        visible={isEndConfirmationVisible}
        isEnding={isEnding}
        isTestSession={isTestSession}
        onCancel={cancelEndSession}
        onConfirm={() => void endSelectedSession()}
      />
    </Animated.View>
  );
};

const styles = StyleSheet.create({
  container: { flex: 1 },
  content: {
    flex: 1,
    paddingHorizontal: spacing.xl,
    justifyContent: "space-between",
  },
  elapsedBlock: { alignItems: "center", gap: spacing.xs },
  elapsedTime: {
    fontSize: 64,
    fontWeight: "700",
    fontVariant: ["tabular-nums"],
  },
  buttonColumn: { gap: spacing.md },
  pauseButton: { minHeight: 60 },
  endButtonBlock: { gap: spacing.sm },
  endButton: {
    minHeight: 52,
    borderRadius: radius.md,
    borderWidth: 1.5,
    borderColor: "rgba(255,255,255,0.7)",
    alignItems: "center",
    justifyContent: "center",
  },
  endButtonPressed: { opacity: 0.7 },
  endButtonDisabled: { opacity: 0.42 },
  endAvailabilityLabel: { textAlign: "center" },
  idleContainer: {
    flex: 1,
    backgroundColor: colors.background,
    alignItems: "center",
    justifyContent: "center",
    gap: spacing.xl,
    padding: spacing.xl,
  },
});

export default RecordingScreen;
