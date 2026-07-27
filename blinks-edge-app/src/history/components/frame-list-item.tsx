import { Image } from "expo-image";
import { CheckIcon, TrashIcon } from "phosphor-react-native";
import { ActivityIndicator, Pressable, StyleSheet, View } from "react-native";

import { AppText } from "@/application/components/app-text";
import { formatTimeOfDay } from "@/application/utils/format-time";
import { colors, radius, spacing } from "@/application/theme/theme";
import { getFrameImageSource } from "@/history/utils/frame-image-source";
import { SessionFrame } from "@/sessions/types/session-types";

interface FrameListItemProps {
  frame: SessionFrame;
  onOpen: () => void;
  onDelete: () => void;
  isDeleting: boolean;
  selectionMode: boolean;
  isSelected: boolean;
  onToggleSelection: () => void;
}

export const FrameListItem = ({
  frame,
  onOpen,
  onDelete,
  isDeleting,
  selectionMode,
  isSelected,
  onToggleSelection,
}: FrameListItemProps) => {
  const formattedTime = formatTimeOfDay(frame.captureEpochMs);
  const thumbnail = (
    <Image
      source={getFrameImageSource(frame)}
      style={styles.thumbnail}
      contentFit="cover"
      transition={150}
    />
  );

  return (
    <Pressable
      onPress={selectionMode ? onToggleSelection : undefined}
      accessibilityRole={selectionMode ? "checkbox" : undefined}
      accessibilityState={selectionMode ? { checked: isSelected } : undefined}
      style={({ pressed }) => [
        styles.row,
        isSelected && styles.selectedRow,
        pressed && selectionMode && styles.pressedRow,
      ]}
    >
      {selectionMode ? (
        <View style={[styles.checkbox, isSelected && styles.checkedCheckbox]}>
          {isSelected ? (
            <CheckIcon size={16} color={colors.textOnAccent} weight="bold" />
          ) : null}
        </View>
      ) : null}
      {selectionMode ? (
        thumbnail
      ) : (
        <Pressable
          onPress={onOpen}
          accessibilityRole="button"
          accessibilityLabel={`View image captured at ${formattedTime}`}
          style={({ pressed }) => [
            styles.thumbnailButton,
            pressed && styles.pressedThumbnail,
          ]}
        >
          {thumbnail}
        </Pressable>
      )}
      <View style={styles.textColumn}>
        <AppText variant="subheading">{formattedTime}</AppText>
      </View>
      {!selectionMode ? (
        <Pressable
          onPress={onDelete}
          disabled={isDeleting}
          hitSlop={spacing.sm}
          accessibilityLabel="Delete image"
          style={({ pressed }) => [
            styles.deleteButton,
            pressed && { opacity: 0.6 },
          ]}
        >
          {isDeleting ? (
            <ActivityIndicator size="small" color={colors.danger} />
          ) : (
            <TrashIcon size={22} color={colors.danger} />
          )}
        </Pressable>
      ) : null}
    </Pressable>
  );
};

const styles = StyleSheet.create({
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.md,
    backgroundColor: colors.surface,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
  },
  selectedRow: { backgroundColor: colors.primaryMuted },
  pressedRow: { opacity: 0.8 },
  checkbox: {
    width: 24,
    height: 24,
    borderRadius: radius.sm,
    borderWidth: 2,
    borderColor: colors.textMuted,
    alignItems: "center",
    justifyContent: "center",
  },
  checkedCheckbox: {
    backgroundColor: colors.primary,
    borderColor: colors.primary,
  },
  thumbnail: {
    width: 72,
    height: 54,
    borderRadius: radius.sm,
    backgroundColor: colors.surfaceMuted,
  },
  thumbnailButton: {
    borderRadius: radius.sm,
    overflow: "hidden",
  },
  pressedThumbnail: { opacity: 0.7 },
  textColumn: { flex: 1, alignItems: "flex-start" },
  deleteButton: { padding: spacing.sm },
});
