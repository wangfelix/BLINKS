import { Image } from "expo-image";
import { CheckIcon } from "phosphor-react-native";
import { Pressable, StyleSheet, View } from "react-native";

import { AppText } from "@/application/components/app-text";
import { formatTimeOfDay } from "@/application/utils/format-time";
import { colors, radius, spacing } from "@/application/theme/theme";
import { getFrameImageSource } from "@/history/utils/frame-image-source";
import { SessionFrame } from "@/sessions/types/session-types";

interface FrameListItemProps {
  frame: SessionFrame;
  size: number;
  onOpen: () => void;
  selectionMode: boolean;
  isSelected: boolean;
  onToggleSelection: () => void;
}

export const FrameListItem = ({
  frame,
  size,
  onOpen,
  selectionMode,
  isSelected,
  onToggleSelection,
}: FrameListItemProps) => {
  const formattedTime = formatTimeOfDay(frame.captureEpochMs);

  return (
    <Pressable
      onPress={selectionMode ? onToggleSelection : onOpen}
      accessibilityRole={selectionMode ? "checkbox" : "button"}
      accessibilityLabel={
        selectionMode
          ? `Select photo captured at ${formattedTime}`
          : `View photo captured at ${formattedTime}`
      }
      accessibilityState={selectionMode ? { checked: isSelected } : undefined}
      style={({ pressed }) => [
        styles.tile,
        { width: size, height: size * 0.75 },
        pressed && styles.pressedTile,
      ]}
    >
      <Image
        source={getFrameImageSource(frame)}
        style={StyleSheet.absoluteFill}
        contentFit="cover"
        cachePolicy="memory-disk"
        recyclingKey={`${frame.frameIndex}`}
      />
      <View style={styles.timeChip}>
        <AppText variant="caption" style={styles.timeLabel}>
          {formattedTime}
        </AppText>
      </View>
      {selectionMode ? (
        <View style={[styles.checkbox, isSelected && styles.checkedCheckbox]}>
          {isSelected ? (
            <CheckIcon size={16} color={colors.textOnAccent} weight="bold" />
          ) : null}
        </View>
      ) : null}
      {isSelected ? <View pointerEvents="none" style={styles.selectionRing} /> : null}
    </Pressable>
  );
};

const styles = StyleSheet.create({
  tile: {
    overflow: "hidden",
    borderRadius: radius.sm,
    backgroundColor: colors.surfaceMuted,
  },
  pressedTile: { opacity: 0.82 },
  timeChip: {
    position: "absolute",
    left: spacing.xs,
    bottom: spacing.xs,
    paddingHorizontal: spacing.sm,
    paddingVertical: 3,
    borderRadius: radius.pill,
    backgroundColor: "rgba(24, 24, 27, 0.78)",
  },
  timeLabel: { color: colors.textOnAccent },
  checkbox: {
    position: "absolute",
    top: spacing.xs,
    right: spacing.xs,
    width: 28,
    height: 28,
    borderRadius: radius.pill,
    borderWidth: 2,
    borderColor: colors.surface,
    backgroundColor: "rgba(24, 24, 27, 0.58)",
    alignItems: "center",
    justifyContent: "center",
    zIndex: 2,
  },
  checkedCheckbox: {
    backgroundColor: colors.primary,
    borderColor: colors.primary,
  },
  selectionRing: {
    ...StyleSheet.absoluteFillObject,
    borderWidth: 3,
    borderColor: colors.primary,
    borderRadius: radius.sm,
  },
});
