import { Stack } from "expo-router";
import { ImageSquareIcon } from "phosphor-react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import {
  FlatList,
  Pressable,
  RefreshControl,
  StyleSheet,
  View,
} from "react-native";

import { AppButton } from "@/application/components/app-button";
import { AppText } from "@/application/components/app-text";
import { EmptyState } from "@/application/components/empty-state";
import { colors, radius, spacing } from "@/application/theme/theme";
import { FrameListItem } from "@/history/components/frame-list-item";
import { FullScreenImageViewer } from "@/history/components/full-screen-image-viewer";
import { useSessionDetailModel } from "@/history/model/use-session-detail-model";

const FLOATING_ACTION_HEIGHT = 52;

const SessionDetailScreen = () => {
  const insets = useSafeAreaInsets();
  const {
    screenTitle,
    frames,
    isLoading,
    isRefetching,
    refetch,
    confirmDeleteFrame,
    previewFrame,
    openFramePreview,
    closeFramePreview,
    deletingFrameIndex,
    isSelectionMode,
    selectedFrameIndexes,
    selectedCount,
    enterSelectionMode,
    exitSelectionMode,
    toggleFrameSelection,
    confirmDeleteSelected,
    isDeletingSelection,
  } = useSessionDetailModel();

  return (
    <View style={styles.container}>
      <Stack.Screen options={{ title: screenTitle }} />
      <View style={styles.toolbar}>
        {isSelectionMode ? (
          <>
            <AppText variant="label">{selectedCount} selected</AppText>
            <Pressable
              onPress={exitSelectionMode}
              disabled={isDeletingSelection}
              hitSlop={spacing.sm}
            >
              <AppText variant="subheading" style={styles.cancelLabel}>
                Cancel
              </AppText>
            </Pressable>
          </>
        ) : (
          <AppButton
            label="Choose Multiple"
            variant="secondary"
            onPress={enterSelectionMode}
            disabled={frames.length === 0}
            style={styles.chooseButton}
          />
        )}
      </View>

      <View style={styles.listSurface}>
        <FlatList
          data={frames}
          keyExtractor={(frame) => String(frame.frameIndex)}
          extraData={{ isSelectionMode, selectedFrameIndexes }}
          renderItem={({ item }) => (
            <FrameListItem
              frame={item}
              onOpen={() => openFramePreview(item)}
              onDelete={() => confirmDeleteFrame(item)}
              isDeleting={deletingFrameIndex === item.frameIndex}
              selectionMode={isSelectionMode}
              isSelected={selectedFrameIndexes.has(item.frameIndex)}
              onToggleSelection={() =>
                toggleFrameSelection(item.frameIndex)
              }
            />
          )}
          ItemSeparatorComponent={() => <View style={styles.separator} />}
          contentContainerStyle={[
            frames.length === 0 && styles.emptyListContent,
            isSelectionMode && {
              paddingBottom:
                FLOATING_ACTION_HEIGHT +
                insets.bottom +
                spacing.xl * 2,
            },
          ]}
          ListEmptyComponent={
            isLoading ? null : (
              <EmptyState
                icon={<ImageSquareIcon size={40} color={colors.textMuted} />}
                title="No frames"
                message="This session has no remaining images."
              />
            )
          }
          refreshControl={
            <RefreshControl
              refreshing={isRefetching}
              onRefresh={() => void refetch()}
              tintColor={colors.primary}
            />
          }
          showsVerticalScrollIndicator={false}
        />
      </View>

      {isSelectionMode ? (
        <View
          style={[
            styles.selectionOverlay,
            { bottom: insets.bottom + spacing.xl },
          ]}
        >
          <AppButton
            label={`Delete Selected (${selectedCount})`}
            variant="danger"
            onPress={confirmDeleteSelected}
            disabled={selectedCount === 0}
            loading={isDeletingSelection}
            style={styles.deleteSelectedButton}
          />
        </View>
      ) : null}

      {previewFrame ? (
        <FullScreenImageViewer
          frame={previewFrame}
          onClose={closeFramePreview}
          onDelete={() => confirmDeleteFrame(previewFrame)}
          isDeleting={deletingFrameIndex === previewFrame.frameIndex}
        />
      ) : null}
    </View>
  );
};

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.background },
  toolbar: {
    minHeight: 60,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  chooseButton: {
    minHeight: 44,
    marginLeft: "auto",
  },
  cancelLabel: { color: colors.primary },
  listSurface: {
    flex: 1,
    marginHorizontal: spacing.md,
    marginBottom: spacing.xl,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.lg,
    overflow: "hidden",
  },
  separator: { height: 1, backgroundColor: colors.border },
  emptyListContent: { flexGrow: 1, justifyContent: "center" },
  selectionOverlay: {
    position: "absolute",
    left: spacing.xl,
    right: spacing.xl,
    zIndex: 10,
    elevation: 8,
    borderRadius: radius.pill,
    backgroundColor: colors.dangerMuted,
    shadowColor: "#000000",
    shadowOpacity: 0.18,
    shadowRadius: 12,
    shadowOffset: { width: 0, height: 6 },
  },
  deleteSelectedButton: { borderRadius: radius.pill },
});

export default SessionDetailScreen;
