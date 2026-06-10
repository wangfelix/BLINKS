import { Text, TextProps, TextStyle } from "react-native";

import { typography } from "@/application/theme/theme";

type TextVariant = keyof typeof typography;

interface AppTextProps extends TextProps {
  variant?: TextVariant;
  color?: string;
}

export const AppText = ({
  variant = "body",
  color,
  style,
  ...textProps
}: AppTextProps) => {
  const colorStyle: TextStyle | undefined = color ? { color } : undefined;
  return <Text style={[typography[variant], colorStyle, style]} {...textProps} />;
};
