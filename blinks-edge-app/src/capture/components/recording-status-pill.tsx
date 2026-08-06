import { useEffect } from "react";
import { StyleSheet, View } from "react-native";
import Animated, {
  cancelAnimation,
  useAnimatedStyle,
  useSharedValue,
  withRepeat,
  withTiming,
} from "react-native-reanimated";

import { AppText } from "@/application/components/app-text";
import { colors, radius, spacing } from "@/application/theme/theme";

interface RecordingStatusPillProps {
  isPaused: boolean;
  isTestSession?: boolean;
}

export const RecordingStatusPill = ({
  isPaused,
  isTestSession = false,
}: RecordingStatusPillProps) => {
  const pulse = useSharedValue(1);

  useEffect(() => {
    if (isPaused) {
      cancelAnimation(pulse);
      pulse.value = 1;
      return;
    }
    pulse.value = withRepeat(withTiming(0.25, { duration: 700 }), -1, true);
    return () => cancelAnimation(pulse);
  }, [isPaused, pulse]);

  const dotStyle = useAnimatedStyle(() => ({ opacity: pulse.value }));

  return (
    <View style={styles.pill}>
      <Animated.View style={[styles.dot, dotStyle]} />
      <AppText variant="label" color={colors.textOnAccent}>
        {isTestSession
          ? isPaused
            ? "TEST PAUSED"
            : "TEST RECORDING"
          : isPaused
            ? "PAUSED"
            : "RECORDING"}
      </AppText>
    </View>
  );
};

const styles = StyleSheet.create({
  pill: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
    backgroundColor: "rgba(0,0,0,0.25)",
    borderRadius: radius.pill,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm,
    alignSelf: "center",
  },
  dot: {
    width: 10,
    height: 10,
    borderRadius: 5,
    backgroundColor: "#FFFFFF",
  },
});
