import { ImageSquareIcon } from "phosphor-react-native";
import { FlatList, RefreshControl, StyleSheet, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AppText } from "@/application/components/app-text";
import { EmptyState } from "@/application/components/empty-state";
import { colors, spacing } from "@/application/theme/theme";
import { SessionListItem } from "@/history/components/session-list-item";
import { useHistoryModel } from "@/history/model/use-history-model";
import { useCustomTabBarHeight } from "@/navigation/components/custom-tab-bar/utils/custom-tab-bar-hooks";

const HistoryScreen = () => {
  const insets = useSafeAreaInsets();
  const tabBarHeight = useCustomTabBarHeight();
  const { sessions, isLoading, isRefetching, refetch, openSession } =
    useHistoryModel();

  return (
    <View style={styles.container}>
      <FlatList
        data={sessions}
        keyExtractor={(session) => `${session.device}-${session.session}`}
        renderItem={({ item }) => (
          <SessionListItem session={item} onPress={() => openSession(item)} />
        )}
        contentContainerStyle={[
          styles.listContent,
          {
            paddingTop: insets.top + spacing.lg,
            paddingBottom: tabBarHeight + spacing.xl,
          },
        ]}
        ListHeaderComponent={
          <AppText variant="title" style={styles.title}>
            Photos
          </AppText>
        }
        ListEmptyComponent={
          isLoading ? null : (
            <EmptyState
              icon={<ImageSquareIcon size={40} color={colors.textMuted} />}
              title="No recording sessions yet"
              message="Your recording sessions will appear here after you start one from the Dashboard."
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
    paddingHorizontal: spacing.xl,
    gap: spacing.md,
  },
  title: { marginBottom: spacing.sm },
});

export default HistoryScreen;
