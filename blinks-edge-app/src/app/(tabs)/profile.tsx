import { SignOutIcon, UserCircleIcon } from "phosphor-react-native";
import { StyleSheet, View } from "react-native";

import { AppButton } from "@/application/components/app-button";
import { AppCard } from "@/application/components/app-card";
import { AppText } from "@/application/components/app-text";
import { AppTextInput } from "@/application/components/app-text-input";
import { ScreenContainer } from "@/application/components/screen-container";
import { colors, spacing } from "@/application/theme/theme";
import { useCustomTabBarHeight } from "@/navigation/components/custom-tab-bar/utils/custom-tab-bar-hooks";
import { useProfileModel } from "@/profile/model/use-profile-model";

const ProfileScreen = () => {
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
    <ScreenContainer scrollable bottomSpacing={tabBarHeight}>
      <AppText variant="title">Profile</AppText>

      <AppCard style={styles.identityCard}>
        <UserCircleIcon size={48} color={colors.primary} weight="fill" />
        <View style={styles.identityText}>
          <AppText variant="heading">{username ?? "—"}</AppText>
          <AppText variant="caption">Study participant</AppText>
        </View>
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
  passwordCard: { gap: spacing.lg },
});

export default ProfileScreen;
