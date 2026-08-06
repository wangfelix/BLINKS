import { apiClient } from "@/application/api/api-client";
import type { CameraFormFactor } from "@/study-settings/types/camera-form-factor";

export const updateCameraFormFactor = (cameraFormFactor: CameraFormFactor) =>
  apiClient.put<{ ok: true; cameraFormFactor: CameraFormFactor }>(
    "/api/study-settings/camera-form-factor",
    { cameraFormFactor },
  );
