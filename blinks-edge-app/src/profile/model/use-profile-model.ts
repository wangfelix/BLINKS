import { useMutation } from "@tanstack/react-query";
import { useState } from "react";
import { Alert } from "react-native";

import { isApiError } from "@/application/api/api-error";
import { changePassword } from "@/authentication/api/auth-api";
import { useAuth } from "@/authentication/context/auth-context";

const MIN_PASSWORD_LENGTH = 8;

export const useProfileModel = () => {
  const { username, signOut } = useAuth();

  // ---- STATE ----

  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [validationError, setValidationError] = useState<string | null>(null);

  const changePasswordMutation = useMutation({
    mutationFn: () => changePassword(currentPassword, newPassword),
    onSuccess: () => {
      setCurrentPassword("");
      setNewPassword("");
      setConfirmPassword("");
      setValidationError(null);
      Alert.alert("Password changed", "Your password has been updated.");
    },
    onError: (error) => {
      setValidationError(
        isApiError(error) && error.status === 403
          ? "The current password is incorrect."
          : "Changing the password failed. Try again.",
      );
    },
  });

  // ---- ACTIONS ----

  const submitPasswordChange = () => {
    if (!currentPassword || !newPassword || !confirmPassword) {
      setValidationError("Fill in all three fields.");
      return;
    }
    if (newPassword.length < MIN_PASSWORD_LENGTH) {
      setValidationError(
        `The new password needs at least ${MIN_PASSWORD_LENGTH} characters.`,
      );
      return;
    }
    if (newPassword !== confirmPassword) {
      setValidationError("The new passwords do not match.");
      return;
    }
    setValidationError(null);
    changePasswordMutation.mutate();
  };

  const confirmSignOut = () => {
    Alert.alert("Sign out?", "You will need your password to sign back in.", [
      { text: "Cancel", style: "cancel" },
      { text: "Sign out", style: "destructive", onPress: () => void signOut() },
    ]);
  };

  // ---- RETURN ----

  return {
    username,
    currentPassword,
    setCurrentPassword,
    newPassword,
    setNewPassword,
    confirmPassword,
    setConfirmPassword,
    validationError,
    isChangingPassword: changePasswordMutation.isPending,
    submitPasswordChange,
    confirmSignOut,
  };
};
