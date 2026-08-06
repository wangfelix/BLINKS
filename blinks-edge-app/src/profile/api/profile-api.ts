import { apiClient } from "@/application/api/api-client";
import type { CameraFormFactor } from "@/study-settings/types/camera-form-factor";

// Shape returned by GET /api/profile (server/src/server.ts). Keep in sync
// with the server when the API changes. wakeTime/bedTime are the participant's
// usual schedule ("HH:MM", 24-hour) from onboarding — the bedtime drives the
// server's fallback push reminder; drmWebUrl points at the evening
// reconstruction website.
export interface ParticipantProfile {
  username: string;
  occupation: string | null;
  workDescription: string | null;
  wakeTime: string | null;
  bedTime: string | null;
  cameraFormFactor: CameraFormFactor | null;
  drmWebUrl: string;
}

export interface ProfileUpdateInput {
  occupation: string;
  workDescription: string;
  wakeTime: string;
  bedTime: string;
}

// Mirrors the server's HH:MM validation (24-hour clock).
export const isValidTimeOfDay = (value: string): boolean =>
  /^([01]\d|2[0-3]):[0-5]\d$/.test(value);

export const fetchProfile = () =>
  apiClient.get<ParticipantProfile>("/api/profile");

export const updateProfile = (input: ProfileUpdateInput) =>
  apiClient.put<{ ok: true }>("/api/profile", input);
