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
import { RecordingMetadataCard } from "@/capture/components/recording-metadata-card";
import { RecordingStatusPill } from "@/capture/components/recording-status-pill";
import { useRecordingScreenModel } from "@/capture/model/use-recording-screen-model";

const RecordingScreen = () => {
  const insets = useSafeAreaInsets();
  const {
    isIdle,
    isPaused,
    elapsedLabel,
    cameraStatusLabel,
    serverStatusLabel,
    framesLabel,
    lastFrameLabel,
    togglePause,
    confirmEndSession,
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
        <RecordingStatusPill isPaused={isPaused} />

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
          <Pressable
            onPress={confirmEndSession}
            style={({ pressed }) => [
              styles.endButton,
              pressed && { opacity: 0.7 },
            ]}
          >
            <AppText variant="subheading" color={colors.textOnAccent}>
              End session
            </AppText>
          </Pressable>
        </View>
      </View>
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
  endButton: {
    minHeight: 52,
    borderRadius: radius.md,
    borderWidth: 1.5,
    borderColor: "rgba(255,255,255,0.7)",
    alignItems: "center",
    justifyContent: "center",
  },
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
