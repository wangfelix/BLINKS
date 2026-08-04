import { Stack } from "expo-router";
import {
  ImageSquareIcon,
  LockSimpleIcon,
  WarningCircleIcon,
} from "phosphor-react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import {
  ActivityIndicator,
  FlatList,
  Pressable,
  RefreshControl,
  StyleSheet,
  useWindowDimensions,
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
const GRID_COLUMN_COUNT = 3;
const GRID_GAP = spacing.xs;

const SessionDetailScreen = () => {
  const insets = useSafeAreaInsets();
  const { width: windowWidth } = useWindowDimensions();
  const {
    screenTitle,
    frames,
    photoAccessState,
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
  const gridWidth = windowWidth - spacing.md * 2 - spacing.sm * 2;
  const tileSize =
    (gridWidth - GRID_GAP * (GRID_COLUMN_COUNT - 1)) / GRID_COLUMN_COUNT;

  const emptyState = (() => {
    if (isLoading) {
      return <ActivityIndicator size="large" color={colors.primary} />;
    }
    if (photoAccessState === "restricted") {
      return (
        <EmptyState
          icon={<LockSimpleIcon size={40} color={colors.textMuted} />}
          title="Photos available after Self DRM"
          message="To protect your memory-based reconstruction, photos stay hidden until you submit the first Self DRM round on the study website. Return here and refresh after submitting it."
        />
      );
    }
    if (photoAccessState === "error") {
      return (
        <EmptyState
          icon={<WarningCircleIcon size={40} color={colors.textMuted} />}
          title="Photo access unavailable"
          message="We could not check whether your photos are available. Pull down to try again."
        />
      );
    }
    return (
      <EmptyState
        icon={<ImageSquareIcon size={40} color={colors.textMuted} />}
        title="No photos"
        message="This session has no remaining photos."
      />
    );
  })();

  return (
    <View style={styles.container}>
      <Stack.Screen options={{ title: screenTitle }} />
      {photoAccessState === "available" ? (
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
      ) : null}

      <View style={styles.listSurface}>
        <FlatList
          data={frames}
          numColumns={GRID_COLUMN_COUNT}
          keyExtractor={(frame) => String(frame.frameIndex)}
          extraData={{ isSelectionMode, selectedFrameIndexes }}
          renderItem={({ item }) => (
            <FrameListItem
              frame={item}
              size={tileSize}
              onOpen={() => openFramePreview(item)}
              selectionMode={isSelectionMode}
              isSelected={selectedFrameIndexes.has(item.frameIndex)}
              onToggleSelection={() =>
                toggleFrameSelection(item.frameIndex)
              }
            />
          )}
          columnWrapperStyle={styles.gridRow}
          contentContainerStyle={[
            styles.gridContent,
            frames.length === 0 && styles.emptyListContent,
            isSelectionMode && {
              paddingBottom:
                FLOATING_ACTION_HEIGHT +
                insets.bottom +
                spacing.xl * 2,
            },
          ]}
          ListEmptyComponent={emptyState}
          refreshControl={
            <RefreshControl
              refreshing={isRefetching}
              onRefresh={() => void refetch()}
              tintColor={colors.primary}
            />
          }
          initialNumToRender={18}
          maxToRenderPerBatch={18}
          windowSize={7}
          removeClippedSubviews
          showsVerticalScrollIndicator={false}
        />
      </View>

      {photoAccessState === "available" && isSelectionMode ? (
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

      {photoAccessState === "available" && previewFrame ? (
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
  },
  gridContent: {
    paddingHorizontal: spacing.sm,
    paddingTop: spacing.xs,
    paddingBottom: spacing.xl,
  },
  gridRow: {
    gap: GRID_GAP,
    marginBottom: GRID_GAP,
  },
  emptyListContent: {
    flexGrow: 1,
    justifyContent: "center",
    paddingBottom: spacing.xxl,
  },
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
