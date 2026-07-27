import { StatusBar } from "expo-status-bar";
import { TrashIcon, XIcon } from "phosphor-react-native";
import {
  ActivityIndicator,
  Modal,
  Pressable,
  StyleSheet,
  View,
} from "react-native";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AppText } from "@/application/components/app-text";
import { colors, radius, spacing } from "@/application/theme/theme";
import { ZoomableImage } from "@/history/components/zoomable-image";
import { getFrameImageSource } from "@/history/utils/frame-image-source";
import { SessionFrame } from "@/sessions/types/session-types";

interface FullScreenImageViewerProps {
  frame: SessionFrame;
  onClose: () => void;
  onDelete: () => void;
  isDeleting: boolean;
}

export const FullScreenImageViewer = ({
  frame,
  onClose,
  onDelete,
  isDeleting,
}: FullScreenImageViewerProps) => {
  const insets = useSafeAreaInsets();

  return (
    <Modal
      visible
      animationType="fade"
      statusBarTranslucent
      onRequestClose={onClose}
    >
      <StatusBar style="light" />
      <GestureHandlerRootView style={styles.gestureRoot}>
        <View style={styles.container}>
          <ZoomableImage source={getFrameImageSource(frame)} />
          <Pressable
            onPress={onClose}
            hitSlop={spacing.sm}
            accessibilityRole="button"
            accessibilityLabel="Close image preview"
            style={({ pressed }) => [
              styles.closeButton,
              { top: insets.top + spacing.lg },
              pressed && styles.pressedButton,
            ]}
          >
            <XIcon size={24} color={colors.textOnAccent} weight="bold" />
          </Pressable>
          <View
            pointerEvents="box-none"
            style={[
              styles.deleteButtonContainer,
              { bottom: insets.bottom + spacing.xl },
            ]}
          >
            <Pressable
              onPress={onDelete}
              disabled={isDeleting}
              accessibilityRole="button"
              accessibilityLabel="Delete photo"
              accessibilityState={{ disabled: isDeleting, busy: isDeleting }}
              style={({ pressed }) => [
                styles.deleteButton,
                pressed && styles.pressedButton,
                isDeleting && styles.disabledButton,
              ]}
            >
              {isDeleting ? (
                <ActivityIndicator size="small" color={colors.danger} />
              ) : (
                <TrashIcon size={22} color={colors.danger} />
              )}
              <AppText variant="subheading" color={colors.danger}>
                {isDeleting ? "Deleting..." : "Delete photo"}
              </AppText>
            </Pressable>
          </View>
        </View>
      </GestureHandlerRootView>
    </Modal>
  );
};

const styles = StyleSheet.create({
  gestureRoot: { flex: 1 },
  container: { flex: 1, backgroundColor: "#000000" },
  closeButton: {
    position: "absolute",
    right: spacing.lg,
    width: 44,
    height: 44,
    borderRadius: radius.pill,
    backgroundColor: "rgba(24, 24, 27, 0.72)",
    alignItems: "center",
    justifyContent: "center",
    zIndex: 1,
    elevation: 4,
  },
  deleteButtonContainer: {
    position: "absolute",
    left: 0,
    right: 0,
    alignItems: "center",
    zIndex: 1,
    elevation: 4,
  },
  deleteButton: {
    minHeight: 52,
    paddingHorizontal: spacing.xl,
    borderRadius: radius.pill,
    backgroundColor: colors.surfaceMuted,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: spacing.sm,
    shadowColor: "#000000",
    shadowOpacity: 0.2,
    shadowRadius: 10,
    shadowOffset: { width: 0, height: 4 },
  },
  pressedButton: { opacity: 0.65 },
  disabledButton: { opacity: 0.7 },
});
