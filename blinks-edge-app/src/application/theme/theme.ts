import { TextStyle } from "react-native";

export const colors = {
  background: "#F6F6F8",
  surface: "#FFFFFF",
  surfaceMuted: "#EFEFF2",
  border: "#E4E4E7",
  textPrimary: "#18181B",
  textSecondary: "#52525B",
  textMuted: "#A1A1AA",
  textOnAccent: "#FFFFFF",
  primary: "#4F46E5",
  primaryPressed: "#4338CA",
  primaryMuted: "#EEF2FF",
  danger: "#DC2626",
  dangerMuted: "#FEF2F2",
  success: "#16A34A",
  successMuted: "#F0FDF4",
  // Full-screen recording view backgrounds (animated between on pause/resume).
  recordingActive: "#15803D",
  recordingPaused: "#52525B",
} as const;

export const spacing = {
  xs: 4,
  sm: 8,
  md: 12,
  lg: 16,
  xl: 24,
  xxl: 32,
} as const;

export const radius = {
  sm: 8,
  md: 12,
  lg: 16,
  pill: 999,
} as const;

export const typography = {
  title: { fontSize: 28, fontWeight: "700", color: colors.textPrimary },
  heading: { fontSize: 20, fontWeight: "600", color: colors.textPrimary },
  subheading: { fontSize: 16, fontWeight: "600", color: colors.textPrimary },
  body: { fontSize: 16, fontWeight: "400", color: colors.textPrimary },
  caption: { fontSize: 13, fontWeight: "400", color: colors.textSecondary },
  label: { fontSize: 14, fontWeight: "600", color: colors.textSecondary },
} as const satisfies Record<string, TextStyle>;

export const theme = { colors, spacing, radius, typography } as const;
