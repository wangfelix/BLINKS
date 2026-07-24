import { Image } from "expo-image";
import { CheckIcon, TrashIcon } from "phosphor-react-native";
import { ActivityIndicator, Pressable, StyleSheet, View } from "react-native";

import { AppText } from "@/application/components/app-text";
import { appConfig } from "@/application/config/app-config";
import { formatTimeOfDay } from "@/application/utils/format-time";
import { colors, radius, spacing } from "@/application/theme/theme";
import { sessionHolder } from "@/authentication/storage/session-holder";
import { SessionFrame } from "@/sessions/types/session-types";

interface FrameListItemProps {
  frame: SessionFrame;
  onDelete: () => void;
  isDeleting: boolean;
  selectionMode: boolean;
  isSelected: boolean;
  onToggleSelection: () => void;
}

export const FrameListItem = ({
  frame,
  onDelete,
  isDeleting,
  selectionMode,
  isSelected,
  onToggleSelection,
}: FrameListItemProps) => (
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
    <Image
      source={{
        uri: `${appConfig.serverUrl}${frame.imageUrl}`,
        headers: { Authorization: `Bearer ${sessionHolder.getToken() ?? ""}` },
      }}
      style={styles.thumbnail}
      contentFit="cover"
      transition={150}
    />
    <View style={styles.textColumn}>
      <AppText variant="subheading">
        {formatTimeOfDay(frame.captureEpochMs)}
      </AppText>
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
  textColumn: { flex: 1, alignItems: "flex-start" },
  deleteButton: { padding: spacing.sm },
});
