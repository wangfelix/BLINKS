import { BottomTabBarProps } from "@react-navigation/bottom-tabs";
import { useMemo } from "react";
import { useWindowDimensions } from "react-native";

import { bottomTabConfig } from "@/navigation/bottom-tab-config";
import {
  TAB_BAR_HORIZONTAL_MARGIN,
  TAB_BAR_INNER_HORIZONTAL_PADDING,
} from "@/navigation/components/custom-tab-bar/utils/custom-tab-bar-constants";

export const useCustomTabBarModel = (props: BottomTabBarProps) => {
  const { state, navigation } = props;
  const { width: screenWidth } = useWindowDimensions();

  // ---- STATE ----

  const tabBarWidth = screenWidth - TAB_BAR_HORIZONTAL_MARGIN * 2;
  const tabWidth =
    (tabBarWidth - TAB_BAR_INNER_HORIZONTAL_PADDING * 2) / state.routes.length;
  const selectedIndex = state.index;

  const tabs = useMemo(
    () =>
      state.routes.map((route, index) => {
        const config = bottomTabConfig.find((tab) => tab.key === route.name);

        return {
          key: route.key,
          name: route.name,
          icon: config?.icon,
          label: config?.label ?? route.name,
          isFocused: state.index === index,
        };
      }),
    [state],
  );

  // ---- RETURN ----

  return {
    state,
    navigation,
    tabs,
    tabWidth,
    tabBarWidth,
    selectedIndex,
  };
};
