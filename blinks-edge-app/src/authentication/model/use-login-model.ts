import { useMutation } from "@tanstack/react-query";
import { useState } from "react";

import { isApiError } from "@/application/api/api-error";
import { useAuth } from "@/authentication/context/auth-context";

export const useLoginModel = () => {
  const { signIn } = useAuth();

  // ---- STATE ----

  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");

  const loginMutation = useMutation({
    mutationFn: () => signIn(username.trim(), password),
  });

  const errorMessage = loginMutation.isError
    ? isApiError(loginMutation.error) && loginMutation.error.status === 401
      ? "Wrong username or password."
      : loginMutation.error.message
    : null;

  // ---- ACTIONS ----

  const submit = () => {
    if (!username.trim() || !password) return;
    loginMutation.mutate();
  };

  // ---- RETURN ----

  return {
    username,
    setUsername,
    password,
    setPassword,
    errorMessage,
    isSubmitting: loginMutation.isPending,
    canSubmit: !!username.trim() && !!password,
    submit,
  };
};
