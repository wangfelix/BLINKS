import { WarningIcon } from "phosphor-react-native";
import { Modal, StyleSheet, View } from "react-native";

import { AppButton } from "@/application/components/app-button";
import { AppText } from "@/application/components/app-text";
import { colors, radius, spacing } from "@/application/theme/theme";

interface EndSessionConfirmationModalProps {
  visible: boolean;
  isEnding: boolean;
  isTestSession: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}

export const EndSessionConfirmationModal = ({
  visible,
  isEnding,
  isTestSession,
  onCancel,
  onConfirm,
}: EndSessionConfirmationModalProps) => (
  <Modal
    transparent
    visible={visible}
    animationType="fade"
    statusBarTranslucent
    onRequestClose={isEnding ? undefined : onCancel}
  >
    <View style={styles.overlay}>
      <View
        accessibilityViewIsModal
        accessibilityRole="alert"
        style={styles.card}
      >
        <View style={styles.warningIcon}>
          <WarningIcon size={32} color={colors.danger} weight="fill" />
        </View>

        <View style={styles.messageBlock}>
          <AppText variant="heading" style={styles.centeredText}>
            {isTestSession ? "End test session?" : "End session permanently?"}
          </AppText>
          <AppText color={colors.textSecondary} style={styles.centeredText}>
            {isTestSession
              ? "This stops only the lab test. It will not affect the main recording session."
              : "You cannot resume recording or start another session after ending this one. Only end it when you are finished for the day."}
          </AppText>
        </View>

        <View style={styles.buttonColumn}>
          <AppButton
            label="Keep recording"
            onPress={onCancel}
            disabled={isEnding}
          />
          <AppButton
            label={
              isEnding
                ? "Ending session…"
                : isTestSession
                  ? "End test session"
                  : "End session permanently"
            }
            onPress={onConfirm}
            variant="danger"
            loading={isEnding}
          />
        </View>
      </View>
    </View>
  </Modal>
);

const styles = StyleSheet.create({
  overlay: {
    flex: 1,
    backgroundColor: "rgba(24, 24, 27, 0.58)",
    alignItems: "center",
    justifyContent: "center",
    padding: spacing.xl,
  },
  card: {
    width: "100%",
    maxWidth: 400,
    borderRadius: radius.lg,
    backgroundColor: colors.surface,
    padding: spacing.xl,
    gap: spacing.xl,
    shadowColor: "#000000",
    shadowOpacity: 0.24,
    shadowRadius: 18,
    shadowOffset: { width: 0, height: 8 },
    elevation: 8,
  },
  warningIcon: {
    alignSelf: "center",
    width: 64,
    height: 64,
    borderRadius: radius.pill,
    backgroundColor: colors.dangerMuted,
    alignItems: "center",
    justifyContent: "center",
  },
  messageBlock: { gap: spacing.sm },
  centeredText: { textAlign: "center" },
  buttonColumn: { gap: spacing.md },
});
