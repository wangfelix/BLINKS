import { apiClient } from "@/application/api/api-client";

export const registerPushToken = (expoPushToken: string) =>
  apiClient.post<{ ok: true }>("/api/register-push", { expoPushToken });
