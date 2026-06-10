import { apiClient } from "@/application/api/api-client";

interface LoginResponse {
  token: string;
  username: string;
}

export const login = (username: string, password: string) =>
  apiClient.post<LoginResponse>(
    "/api/login",
    { username, password },
    { skipUnauthorizedHandling: true },
  );

export const changePassword = (currentPassword: string, newPassword: string) =>
  apiClient.post<{ ok: true }>("/api/change-password", {
    currentPassword,
    newPassword,
  });
