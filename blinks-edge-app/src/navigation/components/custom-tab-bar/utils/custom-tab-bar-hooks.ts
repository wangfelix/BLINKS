import { useSafeAreaInsets } from "react-native-safe-area-context";

import {
  TAB_BAR_BOTTOM_MARGIN,
  TAB_BAR_HEIGHT,
} from "@/navigation/components/custom-tab-bar/utils/custom-tab-bar-constants";

// Total height the floating tab bar occupies, for padding scroll content.
export const useCustomTabBarHeight = () => {
  const insets = useSafeAreaInsets();

  return TAB_BAR_HEIGHT + Math.max(insets.bottom, TAB_BAR_BOTTOM_MARGIN);
};
