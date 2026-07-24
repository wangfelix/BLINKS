import { ReactNode } from "react";
import { ScrollView, StyleSheet, View } from "react-native";
import { KeyboardAwareScrollView } from "react-native-keyboard-aware-scroll-view";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { colors, spacing } from "@/application/theme/theme";

interface ScreenContainerProps {
  children: ReactNode;
  scrollable?: boolean;
  keyboardAware?: boolean;
  // Extra bottom padding so content scrolls clear of the floating tab bar.
  bottomSpacing?: number;
}

export const ScreenContainer = ({
  children,
  scrollable = false,
  keyboardAware = false,
  bottomSpacing = 0,
}: ScreenContainerProps) => {
  const insets = useSafeAreaInsets();
  const containerStyle = [styles.container, { paddingTop: insets.top + spacing.lg }];

  if (scrollable && keyboardAware) {
    return (
      <KeyboardAwareScrollView
        style={[styles.background, { backgroundColor: colors.background }]}
        contentContainerStyle={[
          containerStyle,
          { paddingBottom: bottomSpacing + spacing.xl },
        ]}
        automaticallyAdjustKeyboardInsets
        enableOnAndroid
        extraScrollHeight={spacing.lg}
        keyboardShouldPersistTaps="handled"
        showsVerticalScrollIndicator={false}
      >
        {children}
      </KeyboardAwareScrollView>
    );
  }

  if (scrollable) {
    return (
      <ScrollView
        style={[styles.background, { backgroundColor: colors.background }]}
        contentContainerStyle={[
          containerStyle,
          { paddingBottom: bottomSpacing + spacing.xl },
        ]}
        showsVerticalScrollIndicator={false}
      >
        {children}
      </ScrollView>
    );
  }

  return (
    <View
      style={[
        styles.background,
        containerStyle,
        { backgroundColor: colors.background, paddingBottom: bottomSpacing },
      ]}
    >
      {children}
    </View>
  );
};

const styles = StyleSheet.create({
  background: { flex: 1 },
  container: {
    paddingHorizontal: spacing.xl,
    gap: spacing.lg,
  },
});
