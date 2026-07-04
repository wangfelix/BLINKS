import { apiClient } from "@/application/api/api-client";

// Shape returned by GET /api/profile (server/src/server.ts). Keep in sync
// with the server when the API changes. studyDurationDays is derived from the
// participant's DRM condition plan length; drmWebUrl points at the evening
// reconstruction website.
export interface ParticipantProfile {
  username: string;
  occupation: string | null;
  workDescription: string | null;
  studyDurationDays: number;
  drmWebUrl: string;
}

export interface ProfileUpdateInput {
  occupation: string;
  workDescription: string;
}

export const fetchProfile = () =>
  apiClient.get<ParticipantProfile>("/api/profile");

export const updateProfile = (input: ProfileUpdateInput) =>
  apiClient.put<{ ok: true }>("/api/profile", input);
