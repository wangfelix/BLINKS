import {
  isLiquidGlassSupported,
  LiquidGlassView,
} from "@callstack/liquid-glass";
import { ReactNode } from "react";
import { useColorScheme, View, ViewStyle } from "react-native";

import {
  TAB_BAR_BORDER_RADIUS,
  TAB_BAR_HEIGHT,
  TAB_BAR_INNER_HORIZONTAL_PADDING,
  TAB_BAR_INNER_VERTICAL_PADDING,
} from "@/navigation/components/custom-tab-bar/utils/custom-tab-bar-constants";

interface TabBarBackgroundProps {
  children: ReactNode;
}

// iOS 26+ renders the pill with native liquid glass; everywhere else (the
// study's Android phones) falls back to a shadowed solid pill.
export const TabBarBackground = ({ children }: TabBarBackgroundProps) => {
  const isDarkMode = useColorScheme() === "dark";

  const containerStyle: ViewStyle = {
    height: TAB_BAR_HEIGHT,
    borderRadius: TAB_BAR_BORDER_RADIUS,
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: TAB_BAR_INNER_HORIZONTAL_PADDING,
    paddingVertical: TAB_BAR_INNER_VERTICAL_PADDING,
  };

  if (isLiquidGlassSupported) {
    return (
      <LiquidGlassView
        effect="regular"
        interactive={true}
        style={{ ...containerStyle, overflow: "visible" }}
      >
        {children}
      </LiquidGlassView>
    );
  }

  return (
    <View
      style={{
        ...containerStyle,
        overflow: "hidden",
        backgroundColor: isDarkMode ? "#1e1e1e" : "#f5f5f5",
        shadowColor: "#000",
        shadowOffset: { width: 0, height: 4 },
        shadowOpacity: 0.25,
        shadowRadius: 12,
        elevation: 10,
      }}
    >
      {children}
    </View>
  );
};
