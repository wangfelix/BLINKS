import { IconProps } from "phosphor-react-native";
import { ComponentType } from "react";
import { Text, View } from "react-native";

import {
  ACTIVE_TAB_COLOR,
  INACTIVE_TAB_COLOR,
} from "@/navigation/components/custom-tab-bar/utils/custom-tab-bar-constants";

interface TabBarItemProps {
  icon: ComponentType<IconProps>;
  label: string;
  isFocused: boolean;
}

export const TabBarItem = ({ icon: Icon, label, isFocused }: TabBarItemProps) => {
  const color = isFocused ? ACTIVE_TAB_COLOR : INACTIVE_TAB_COLOR;

  return (
    <View style={{ flex: 1, alignItems: "center", justifyContent: "center", gap: 2 }}>
      <Icon weight={isFocused ? "fill" : "regular"} color={color} size={24} />
      <Text style={{ fontSize: 10, fontWeight: "600", color }} numberOfLines={1}>
        {label}
      </Text>
    </View>
  );
};
