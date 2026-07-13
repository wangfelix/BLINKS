import { StyleSheet, View } from "react-native";

import { AppButton } from "@/application/components/app-button";
import { AppCard } from "@/application/components/app-card";
import { AppText } from "@/application/components/app-text";
import { AppTextInput } from "@/application/components/app-text-input";
import { colors, spacing } from "@/application/theme/theme";
import { useOccupationModel } from "@/profile/model/use-occupation-model";

// Inline card on the Profile tab showing the participant's occupation + work
// description (the AI assistant's classification context) and their usual
// wake/bed times (the bedtime drives the evening fallback reminder), with an
// edit flow.
export const OccupationCard = () => {
  const {
    occupation,
    workDescription,
    wakeTime,
    bedTime,
    isLoading,
    isEditing,
    occupationDraft,
    setOccupationDraft,
    workDescriptionDraft,
    setWorkDescriptionDraft,
    wakeTimeDraft,
    setWakeTimeDraft,
    bedTimeDraft,
    setBedTimeDraft,
    validationError,
    isSaving,
    startEditing,
    cancelEditing,
    saveEdits,
  } = useOccupationModel();

  const displayValue = (value: string | null): string =>
    value ?? (isLoading ? "Loading…" : "Not set yet");

  return (
    <AppCard style={styles.card}>
      <AppText variant="subheading">About you</AppText>

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
          />
          <View style={styles.timeRow}>
            <View style={styles.timeField}>
              <AppTextInput
                label="Usual wake-up time"
                value={wakeTimeDraft}
                onChangeText={setWakeTimeDraft}
                placeholder="07:30"
                keyboardType="numbers-and-punctuation"
                maxLength={5}
              />
            </View>
            <View style={styles.timeField}>
              <AppTextInput
                label="Usual bedtime"
                value={bedTimeDraft}
                onChangeText={setBedTimeDraft}
                placeholder="23:00"
                keyboardType="numbers-and-punctuation"
                maxLength={5}
                errorMessage={validationError}
              />
            </View>
          </View>
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
              {displayValue(occupation)}
            </AppText>
          </View>
          <View style={styles.valueBlock}>
            <AppText variant="label">What your work consists of</AppText>
            <AppText
              variant="body"
              color={workDescription ? undefined : colors.textMuted}
            >
              {displayValue(workDescription)}
            </AppText>
          </View>
          <View style={styles.timeRow}>
            <View style={[styles.valueBlock, styles.timeField]}>
              <AppText variant="label">Usual wake-up time</AppText>
              <AppText variant="body" color={wakeTime ? undefined : colors.textMuted}>
                {displayValue(wakeTime)}
              </AppText>
            </View>
            <View style={[styles.valueBlock, styles.timeField]}>
              <AppText variant="label">Usual bedtime</AppText>
              <AppText variant="body" color={bedTime ? undefined : colors.textMuted}>
                {displayValue(bedTime)}
              </AppText>
            </View>
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
  timeRow: { flexDirection: "row", gap: spacing.md },
  timeField: { flex: 1 },
});
