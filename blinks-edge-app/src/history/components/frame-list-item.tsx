import { Image } from "expo-image";
import { TrashIcon } from "phosphor-react-native";
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
}

export const FrameListItem = ({
  frame,
  onDelete,
  isDeleting,
}: FrameListItemProps) => {
  const hasLabel = frame.vlmStatus === "done" && !!frame.vlmLabel;

  return (
    <View style={styles.row}>
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
        <View
          style={[styles.labelChip, !hasLabel && styles.labelChipPending]}
        >
          <AppText
            variant="caption"
            color={hasLabel ? colors.primary : colors.textMuted}
            numberOfLines={1}
          >
            {hasLabel ? frame.vlmLabel : "pending"}
          </AppText>
        </View>
      </View>
      <Pressable
        onPress={onDelete}
        disabled={isDeleting}
        hitSlop={spacing.sm}
        style={({ pressed }) => [styles.deleteButton, pressed && { opacity: 0.6 }]}
      >
        {isDeleting ? (
          <ActivityIndicator size="small" color={colors.danger} />
        ) : (
          <TrashIcon size={22} color={colors.danger} />
        )}
      </Pressable>
    </View>
  );
};

const styles = StyleSheet.create({
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.lg,
    backgroundColor: colors.surface,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.border,
    padding: spacing.md,
  },
  thumbnail: {
    width: 64,
    height: 48,
    borderRadius: radius.sm,
    backgroundColor: colors.surfaceMuted,
  },
  textColumn: { flex: 1, gap: spacing.xs, alignItems: "flex-start" },
  labelChip: {
    backgroundColor: colors.primaryMuted,
    borderRadius: radius.pill,
    paddingHorizontal: spacing.md,
    paddingVertical: 2,
    maxWidth: "100%",
  },
  labelChipPending: { backgroundColor: colors.surfaceMuted },
  deleteButton: { padding: spacing.sm },
});
