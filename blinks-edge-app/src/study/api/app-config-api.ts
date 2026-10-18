import { apiClient } from "@/application/api/api-client";
import type { AppConfigResponse } from "@/study/types/app-config";

export const fetchAppConfig = () =>
  apiClient.get<AppConfigResponse>("/api/app-config");
