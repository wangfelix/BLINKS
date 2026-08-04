import {
  HouseIcon,
  ImageSquareIcon,
  IconProps,
  UserCircleIcon,
} from "phosphor-react-native";
import { ComponentType } from "react";

export interface BottomTabConfigEntry {
  // Expo Router route name inside app/(tabs)/.
  key: string;
  label: string;
  icon: ComponentType<IconProps>;
}

export const bottomTabConfig: BottomTabConfigEntry[] = [
  { key: "index", label: "Dashboard", icon: HouseIcon },
  { key: "history", label: "Photos", icon: ImageSquareIcon },
  { key: "profile", label: "Profile", icon: UserCircleIcon },
];
