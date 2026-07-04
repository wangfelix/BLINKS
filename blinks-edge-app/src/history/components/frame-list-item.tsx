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
}: FrameListItemProps) => (
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
  textColumn: { flex: 1, alignItems: "flex-start" },
  deleteButton: { padding: spacing.sm },
});
