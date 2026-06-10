import { StyleSheet, View } from "react-native";

import { AppText } from "@/application/components/app-text";
import { colors, radius, spacing } from "@/application/theme/theme";

interface MetadataRow {
  label: string;
  value: string;
}

interface RecordingMetadataCardProps {
  rows: MetadataRow[];
}

export const RecordingMetadataCard = ({ rows }: RecordingMetadataCardProps) => (
  <View style={styles.card}>
    {rows.map((row) => (
      <View key={row.label} style={styles.row}>
        <AppText variant="caption" color="rgba(255,255,255,0.75)">
          {row.label}
        </AppText>
        <AppText
          variant="subheading"
          color={colors.textOnAccent}
          numberOfLines={1}
          style={styles.value}
        >
          {row.value}
        </AppText>
      </View>
    ))}
  </View>
);

const styles = StyleSheet.create({
  card: {
    backgroundColor: "rgba(255,255,255,0.14)",
    borderRadius: radius.lg,
    padding: spacing.xl,
    gap: spacing.lg,
  },
  row: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: spacing.lg,
  },
  value: { flexShrink: 1, textAlign: "right" },
});
