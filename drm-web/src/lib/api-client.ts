// Typed fetch wrapper for the BLINKS server API.
//
// API base: same-origin in production (Apache routes /api, /frames, /ingest,
// /health to the Node server on :3000 and everything else to this app on
// :3001). For local development set NEXT_PUBLIC_API_URL=http://localhost:3000.
//
// Auth: bearer token from localStorage on every JSON request. The token is
// ALSO mirrored into a `blinks_token` cookie because <img> tags cannot send
// an Authorization header — the server accepts the cookie for GET /frames/*
// (images) only; JSON APIs stay header-only (CSRF hygiene).

import type {
  ActivityInput,
  LoginResponse,
  OkResponse,
  ProfileResponse,
  RoundResponse,
  StudyStateResponse,
  SubmitResponse,
} from "@/lib/api-types";

export const API_BASE = process.env.NEXT_PUBLIC_API_URL ?? "";

const TOKEN_STORAGE_KEY = "blinks_token";
const TOKEN_COOKIE_NAME = "blinks_token";

export class ApiError extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = "ApiError";
    this.status = status;
  }
}

export const getStoredToken = (): string | null => {
  if (typeof window === "undefined") return null;
  return window.localStorage.getItem(TOKEN_STORAGE_KEY);
};

export const storeToken = (token: string): void => {
  window.localStorage.setItem(TOKEN_STORAGE_KEY, token);
  // Cookie is read by the server for /frames/* image requests only.
  const oneYearSeconds = 60 * 60 * 24 * 365;
  document.cookie = `${TOKEN_COOKIE_NAME}=${encodeURIComponent(token)}; path=/; SameSite=Lax; Max-Age=${oneYearSeconds}`;
};

export const clearStoredToken = (): void => {
  window.localStorage.removeItem(TOKEN_STORAGE_KEY);
  document.cookie = `${TOKEN_COOKIE_NAME}=; path=/; SameSite=Lax; Max-Age=0`;
};

/** Absolute src for an authenticated frame image (cookie carries the token). */
export const frameImageSrc = (imageUrl: string): string =>
  `${API_BASE}${imageUrl}`;

interface ApiFetchOptions {
  method?: "GET" | "POST" | "PUT" | "DELETE";
  body?: unknown;
  /** Skip the clear-token-and-redirect on 401 (used by the login call). */
  skipAuthRedirect?: boolean;
}

const apiFetch = async <T>(
  path: string,
  options: ApiFetchOptions = {},
): Promise<T> => {
  const { method = "GET", body, skipAuthRedirect = false } = options;
  const headers: Record<string, string> = {};
  const token = getStoredToken();
  if (token) headers["Authorization"] = `Bearer ${token}`;
  if (body !== undefined) headers["Content-Type"] = "application/json";

  const response = await fetch(`${API_BASE}${path}`, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });

  if (response.status === 401 && !skipAuthRedirect) {
    clearStoredToken();
    if (typeof window !== "undefined") window.location.href = "/";
    throw new ApiError("Your session has expired. Please sign in again.", 401);
  }

  if (!response.ok) {
    let message = `Request failed (${response.status})`;
    try {
      const errorBody = (await response.json()) as { error?: string };
      if (typeof errorBody.error === "string") message = errorBody.error;
    } catch {
      // Non-JSON error body; keep the generic message.
    }
    throw new ApiError(message, response.status);
  }

  return (await response.json()) as T;
};

// --- Endpoint wrappers -------------------------------------------------------

export const login = (username: string, password: string) =>
  apiFetch<LoginResponse>("/api/login", {
    method: "POST",
    body: { username, password },
    skipAuthRedirect: true,
  });

export const getProfile = () => apiFetch<ProfileResponse>("/api/profile");

export const getStudyState = () =>
  apiFetch<StudyStateResponse>("/api/reconstruction/state");

export const getRound = (round: 1 | 2) =>
  apiFetch<RoundResponse>(`/api/reconstruction/round/${round}`);

export const saveRoundDraft = (round: 1 | 2, activities: ActivityInput[]) =>
  apiFetch<OkResponse>(`/api/reconstruction/round/${round}`, {
    method: "PUT",
    body: { activities },
  });

export const submitRound = (round: 1 | 2, activities: ActivityInput[]) =>
  apiFetch<SubmitResponse>(`/api/reconstruction/round/${round}/submit`, {
    method: "POST",
    body: { activities },
  });
