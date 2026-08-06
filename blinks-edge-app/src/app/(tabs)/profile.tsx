import { useRouter } from "expo-router";
import {
  CaretRightIcon,
  GearSixIcon,
  SignOutIcon,
  UserCircleIcon,
} from "phosphor-react-native";
import { StyleSheet, View } from "react-native";

import { AppButton } from "@/application/components/app-button";
import { AppCard } from "@/application/components/app-card";
import { AppText } from "@/application/components/app-text";
import { AppTextInput } from "@/application/components/app-text-input";
import { ScreenContainer } from "@/application/components/screen-container";
import { colors, spacing } from "@/application/theme/theme";
import { useCustomTabBarHeight } from "@/navigation/components/custom-tab-bar/utils/custom-tab-bar-hooks";
import { OccupationCard } from "@/profile/components/occupation-card";
import { useProfileModel } from "@/profile/model/use-profile-model";

const ProfileScreen = () => {
  const router = useRouter();
  const tabBarHeight = useCustomTabBarHeight();
  const {
    username,
    currentPassword,
    setCurrentPassword,
    newPassword,
    setNewPassword,
    confirmPassword,
    setConfirmPassword,
    validationError,
    isChangingPassword,
    submitPasswordChange,
    confirmSignOut,
  } = useProfileModel();

  return (
    <ScreenContainer scrollable keyboardAware>
      <AppText variant="title">Profile</AppText>

      <AppCard style={styles.identityCard}>
        <UserCircleIcon size={48} color={colors.primary} weight="fill" />
        <View style={styles.identityText}>
          <AppText variant="heading">{username ?? "—"}</AppText>
          <AppText variant="caption">Study participant</AppText>
        </View>
      </AppCard>

      <OccupationCard />

      <AppCard
        onPress={() => router.push("/study-settings")}
        style={styles.settingsCard}
      >
        <GearSixIcon size={28} color={colors.primary} weight="fill" />
        <View style={styles.settingsText}>
          <AppText variant="subheading">Study Settings</AppText>
          <AppText variant="caption">Device setup options</AppText>
        </View>
        <CaretRightIcon size={20} color={colors.textMuted} />
      </AppCard>

      <AppCard style={styles.passwordCard}>
        <AppText variant="subheading">Change password</AppText>
        <AppTextInput
          label="Current password"
          value={currentPassword}
          onChangeText={setCurrentPassword}
          secureTextEntry
          autoComplete="current-password"
        />
        <AppTextInput
          label="New password"
          value={newPassword}
          onChangeText={setNewPassword}
          secureTextEntry
          autoComplete="new-password"
        />
        <AppTextInput
          label="Repeat new password"
          value={confirmPassword}
          onChangeText={setConfirmPassword}
          secureTextEntry
          autoComplete="new-password"
          errorMessage={validationError}
        />
        <AppButton
          label="Update password"
          onPress={submitPasswordChange}
          loading={isChangingPassword}
          variant="secondary"
        />
      </AppCard>

      <AppButton
        label="Sign out"
        onPress={confirmSignOut}
        variant="danger"
        icon={<SignOutIcon size={20} color={colors.danger} />}
      />
      <View
        collapsable={false}
        pointerEvents="none"
        style={{ height: tabBarHeight + spacing.xl }}
      />
    </ScreenContainer>
  );
};

const styles = StyleSheet.create({
  identityCard: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.lg,
  },
  identityText: { gap: spacing.xs },
  settingsCard: {
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.md,
  },
  settingsText: { flex: 1, gap: spacing.xs },
  passwordCard: { gap: spacing.lg },
});

export default ProfileScreen;
