import { StyleSheet, View } from "react-native";

import { AppButton } from "@/application/components/app-button";
import { AppCard } from "@/application/components/app-card";
import { AppText } from "@/application/components/app-text";
import { AppTextInput } from "@/application/components/app-text-input";
import { colors, spacing } from "@/application/theme/theme";
import { useOccupationModel } from "@/profile/model/use-occupation-model";

// Inline card on the Profile tab showing the participant's occupation + work
// description (the AI assistant's classification context) with an edit flow.
export const OccupationCard = () => {
  const {
    occupation,
    workDescription,
    isLoading,
    isEditing,
    occupationDraft,
    setOccupationDraft,
    workDescriptionDraft,
    setWorkDescriptionDraft,
    validationError,
    isSaving,
    startEditing,
    cancelEditing,
    saveEdits,
  } = useOccupationModel();

  return (
    <AppCard style={styles.card}>
      <AppText variant="subheading">About your work</AppText>

      {isEditing ? (
        <>
          <AppTextInput
            label="Occupation"
            value={occupationDraft}
            onChangeText={setOccupationDraft}
            placeholder="e.g. PhD student"
            autoCapitalize="sentences"
          />
          <AppTextInput
            label="What your work consists of"
            value={workDescriptionDraft}
            onChangeText={setWorkDescriptionDraft}
            placeholder="e.g. writing papers, analyzing data, meetings"
            autoCapitalize="sentences"
            multiline
            errorMessage={validationError}
          />
          <View style={styles.buttonRow}>
            <AppButton
              label="Cancel"
              onPress={cancelEditing}
              variant="secondary"
              disabled={isSaving}
              style={styles.rowButton}
            />
            <AppButton
              label="Save"
              onPress={saveEdits}
              loading={isSaving}
              style={styles.rowButton}
            />
          </View>
        </>
      ) : (
        <>
          <View style={styles.valueBlock}>
            <AppText variant="label">Occupation</AppText>
            <AppText variant="body" color={occupation ? undefined : colors.textMuted}>
              {occupation ?? (isLoading ? "Loading…" : "Not set yet")}
            </AppText>
          </View>
          <View style={styles.valueBlock}>
            <AppText variant="label">What your work consists of</AppText>
            <AppText
              variant="body"
              color={workDescription ? undefined : colors.textMuted}
            >
              {workDescription ?? (isLoading ? "Loading…" : "Not set yet")}
            </AppText>
          </View>
          <AppButton label="Edit" onPress={startEditing} variant="secondary" />
        </>
      )}
    </AppCard>
  );
};

const styles = StyleSheet.create({
  card: { gap: spacing.lg },
  valueBlock: { gap: spacing.xs },
  buttonRow: { flexDirection: "row", gap: spacing.md },
  rowButton: { flex: 1 },
});
