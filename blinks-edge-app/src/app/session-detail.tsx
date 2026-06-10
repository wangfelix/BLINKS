import { Stack } from "expo-router";
import { ImageSquareIcon } from "phosphor-react-native";
import { FlatList, RefreshControl, StyleSheet, View } from "react-native";

import { EmptyState } from "@/application/components/empty-state";
import { colors, spacing } from "@/application/theme/theme";
import { FrameListItem } from "@/history/components/frame-list-item";
import { useSessionDetailModel } from "@/history/model/use-session-detail-model";

const SessionDetailScreen = () => {
  const {
    screenTitle,
    frames,
    isLoading,
    isRefetching,
    refetch,
    confirmDeleteFrame,
    deletingFrameIndex,
  } = useSessionDetailModel();

  return (
    <View style={styles.container}>
      <Stack.Screen options={{ title: screenTitle }} />
      <FlatList
        data={frames}
        keyExtractor={(frame) => String(frame.frameIndex)}
        renderItem={({ item }) => (
          <FrameListItem
            frame={item}
            onDelete={() => confirmDeleteFrame(item)}
            isDeleting={deletingFrameIndex === item.frameIndex}
          />
        )}
        contentContainerStyle={styles.listContent}
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
  );
};

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.background },
  listContent: {
    padding: spacing.xl,
    gap: spacing.md,
  },
});

export default SessionDetailScreen;
