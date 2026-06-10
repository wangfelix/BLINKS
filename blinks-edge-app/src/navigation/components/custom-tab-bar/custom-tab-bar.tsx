import { BottomTabBarProps } from "@react-navigation/bottom-tabs";
import { View } from "react-native";
import { Gesture, GestureDetector } from "react-native-gesture-handler";
import { useSharedValue, withSpring } from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { scheduleOnRN } from "react-native-worklets";

import { TabBarBackground } from "@/navigation/components/custom-tab-bar/components/tab-bar-background";
import { TabBarItem } from "@/navigation/components/custom-tab-bar/components/tab-bar-item";
import { TabBarSelectionPill } from "@/navigation/components/custom-tab-bar/components/tab-bar-selection-pill";
import { useCustomTabBarModel } from "@/navigation/components/custom-tab-bar/model/use-custom-tab-bar-model";
import {
  SPRING_CONFIG,
  TAB_BAR_BOTTOM_MARGIN,
  TAB_BAR_HORIZONTAL_MARGIN,
  TAB_BAR_INNER_HORIZONTAL_PADDING,
} from "@/navigation/components/custom-tab-bar/utils/custom-tab-bar-constants";

// Floating pill tab bar, ported from the app-guards-isn sibling app: a
// draggable/tappable selection pill over a liquid-glass (iOS) or shadowed
// solid (Android) background.
export const CustomTabBar = (props: BottomTabBarProps) => {
  const { navigation, tabs, tabWidth, selectedIndex } =
    useCustomTabBarModel(props);
  const insets = useSafeAreaInsets();

  const pillTranslateX = useSharedValue(
    TAB_BAR_INNER_HORIZONTAL_PADDING + selectedIndex * tabWidth,
  );
  const dragStartIndex = useSharedValue(selectedIndex);
  const isPressed = useSharedValue(false);

  const getTargetX = (index: number) => {
    "worklet";
    return TAB_BAR_INNER_HORIZONTAL_PADDING + index * tabWidth;
  };

  const clampIndex = (index: number) => {
    "worklet";
    return Math.max(0, Math.min(tabs.length - 1, index));
  };

  const navigateToTab = (index: number) => {
    const tab = tabs[index];
    if (!tab) return;

    const event = navigation.emit({
      type: "tabPress",
      target: tab.key,
      canPreventDefault: true,
    });

    if (!event.defaultPrevented) {
      navigation.navigate(tab.name);
    }
  };

  // Snap pill to selected tab when selection changes externally
  pillTranslateX.value = withSpring(getTargetX(selectedIndex), SPRING_CONFIG);

  const panGesture = Gesture.Pan()
    .onStart(() => {
      dragStartIndex.value = selectedIndex;
      isPressed.value = true;
    })
    .onUpdate((event) => {
      const offsetFromStart = event.translationX;
      const startX = getTargetX(dragStartIndex.value);
      const newX = startX + offsetFromStart;
      const minX = getTargetX(0);
      const maxX = getTargetX(tabs.length - 1);
      pillTranslateX.value = Math.max(minX, Math.min(maxX, newX));
    })
    .onEnd(() => {
      const currentCenter =
        pillTranslateX.value - TAB_BAR_INNER_HORIZONTAL_PADDING + tabWidth / 2;
      const newIndex = clampIndex(Math.floor(currentCenter / tabWidth));
      pillTranslateX.value = withSpring(getTargetX(newIndex), SPRING_CONFIG);
      scheduleOnRN(navigateToTab, newIndex);
    })
    .onFinalize(() => {
      isPressed.value = false;
    });

  const tapGesture = Gesture.Tap()
    .onBegin(() => {
      isPressed.value = true;
    })
    .onEnd((event) => {
      const tappedIndex = clampIndex(
        Math.floor((event.x - TAB_BAR_INNER_HORIZONTAL_PADDING) / tabWidth),
      );
      pillTranslateX.value = withSpring(getTargetX(tappedIndex), SPRING_CONFIG);
      scheduleOnRN(navigateToTab, tappedIndex);
    })
    .onFinalize(() => {
      isPressed.value = false;
    });

  const composedGesture = Gesture.Race(panGesture, tapGesture);

  return (
    <View
      style={{
        position: "absolute",
        bottom: Math.max(insets.bottom, TAB_BAR_BOTTOM_MARGIN),
        left: TAB_BAR_HORIZONTAL_MARGIN,
        right: TAB_BAR_HORIZONTAL_MARGIN,
        overflow: "visible",
      }}
    >
      <GestureDetector gesture={composedGesture}>
        <TabBarBackground>
          <View pointerEvents="none" style={{ flexDirection: "row", flex: 1 }}>
            {tabs.map((tab) => {
              if (!tab.icon) return null;

              return (
                <TabBarItem
                  key={tab.key}
                  icon={tab.icon}
                  label={tab.label}
                  isFocused={tab.isFocused}
                />
              );
            })}
          </View>
        </TabBarBackground>
      </GestureDetector>

      <TabBarSelectionPill
        translateX={pillTranslateX}
        pillWidth={tabWidth}
        isPressed={isPressed}
      />
    </View>
  );
};
