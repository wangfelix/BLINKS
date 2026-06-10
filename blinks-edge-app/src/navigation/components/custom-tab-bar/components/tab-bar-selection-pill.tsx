import { useColorScheme, View } from "react-native";
import Animated, {
  SharedValue,
  useAnimatedStyle,
  withTiming,
} from "react-native-reanimated";

import {
  TAB_BAR_HEIGHT,
  TAB_BAR_INNER_VERTICAL_PADDING,
} from "@/navigation/components/custom-tab-bar/utils/custom-tab-bar-constants";

interface TabBarSelectionPillProps {
  translateX: SharedValue<number>;
  pillWidth: number;
  isPressed: SharedValue<boolean>;
}

export const TabBarSelectionPill = ({
  translateX,
  pillWidth,
  isPressed,
}: TabBarSelectionPillProps) => {
  const isDarkMode = useColorScheme() === "dark";

  const pillHeight = TAB_BAR_HEIGHT - TAB_BAR_INNER_VERTICAL_PADDING * 2;

  const animatedStyle = useAnimatedStyle(() => ({
    transform: [
      { translateX: translateX.value },
      { scale: withTiming(isPressed.value ? 1.15 : 1, { duration: 200 }) },
    ],
  }));

  return (
    <Animated.View
      pointerEvents="none"
      style={[
        {
          overflow: "visible",
          position: "absolute",
          top: TAB_BAR_INNER_VERTICAL_PADDING,
          left: 0,
        },
        animatedStyle,
      ]}
    >
      <View
        style={{
          width: pillWidth,
          height: pillHeight,
          borderRadius: pillHeight / 2,
          backgroundColor: isDarkMode
            ? "rgba(255,255,255,0.12)"
            : "rgba(0,0,0,0.08)",
        }}
      />
    </Animated.View>
  );
};
