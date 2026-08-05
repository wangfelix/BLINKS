import { API_BASE, ApiError } from "@/lib/api-client";

export const ADMIN_TABLES = [
  "frames",
  "chunks",
  "activity_lists",
  "activities",
] as const;
export type AdminTableName = (typeof ADMIN_TABLES)[number];
export type AdminCellValue = string | number | null;

export interface AdminLoginResponse {
  token: string;
  username: string;
  role: "admin";
}

export interface AdminStatusResponse {
  username: string;
  role: "admin";
}

export interface AdminOverviewResponse {
  tableCounts: Record<AdminTableName, number>;
  participantCount: number;
  sessionCount: number;
  availablePhotoCount: number;
}

export interface AdminTableResponse {
  table: AdminTableName;
  columns: string[];
  rows: Record<string, AdminCellValue>[];
  total: number;
  page: number;
  pageSize: number;
}

export interface AdminPhotoParticipant {
  participant: string;
  frame_count: number;
}

export interface AdminPhotoSession {
  participant: string;
  session: number;
  started_at_ms: number;
  ended_at_ms: number;
  frame_count: number;
  available_frame_count: number;
}

export interface AdminPhotoFiltersResponse {
  participants: AdminPhotoParticipant[];
  sessions: AdminPhotoSession[];
}

export interface AdminPhoto {
  participant: string;
  device: string;
  session: number;
  frameIndex: number;
  captureEpochMs: number;
  faceStatus: string;
  deletedAt: number | null;
  imageUrl: string | null;
}

export interface AdminPhotosResponse {
  participant: string;
  session: number | null;
  page: number;
  pageSize: number;
  total: number;
  frames: AdminPhoto[];
}

export interface CreateParticipantResponse {
  ok: true;
  username: string;
  mustChangePassword: true;
}

const ADMIN_TOKEN_STORAGE_KEY = "blinks_admin_token";
const ADMIN_TOKEN_COOKIE_NAME = "blinks_admin_token";

export const getStoredAdminToken = (): string | null => {
  if (typeof window === "undefined") return null;
  return window.localStorage.getItem(ADMIN_TOKEN_STORAGE_KEY);
};

export const storeAdminToken = (token: string): void => {
  window.localStorage.setItem(ADMIN_TOKEN_STORAGE_KEY, token);
  const oneDaySeconds = 60 * 60 * 24;
  document.cookie = `${ADMIN_TOKEN_COOKIE_NAME}=${encodeURIComponent(token)}; path=/; SameSite=Strict; Max-Age=${oneDaySeconds}`;
};

export const clearStoredAdminToken = (): void => {
  window.localStorage.removeItem(ADMIN_TOKEN_STORAGE_KEY);
  document.cookie = `${ADMIN_TOKEN_COOKIE_NAME}=; path=/; SameSite=Strict; Max-Age=0`;
};

interface AdminFetchOptions {
  method?: "GET" | "POST";
  body?: unknown;
  skipAuth?: boolean;
}

const errorFromResponse = async (response: Response): Promise<ApiError> => {
  let message = `Request failed (${response.status})`;
  try {
    const body = (await response.json()) as { error?: string };
    if (typeof body.error === "string") message = body.error;
  } catch {
    // Keep the generic HTTP error for non-JSON responses.
  }
  return new ApiError(message, response.status);
};

const adminFetch = async <T>(
  path: string,
  options: AdminFetchOptions = {},
): Promise<T> => {
  const headers: Record<string, string> = {};
  if (!options.skipAuth) {
    const token = getStoredAdminToken();
    if (token) headers.Authorization = `Bearer ${token}`;
  }
  if (options.body !== undefined) headers["Content-Type"] = "application/json";
  const response = await fetch(`${API_BASE}${path}`, {
    method: options.method ?? "GET",
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  if (!response.ok) {
    if (response.status === 401 && !options.skipAuth) clearStoredAdminToken();
    throw await errorFromResponse(response);
  }
  return (await response.json()) as T;
};

export const adminLogin = (username: string, password: string) =>
  adminFetch<AdminLoginResponse>("/api/admin/login", {
    method: "POST",
    body: { username, password },
    skipAuth: true,
  });

export const getAdminStatus = () =>
  adminFetch<AdminStatusResponse>("/api/admin/status");

export const getAdminOverview = () =>
  adminFetch<AdminOverviewResponse>("/api/admin/overview");

export const getAdminTable = (
  table: AdminTableName,
  page: number,
  pageSize: number,
  search = "",
  column: string | null = null,
) => {
  const params = new URLSearchParams({
    page: String(page),
    pageSize: String(pageSize),
  });
  if (search !== "") params.set("search", search);
  if (column !== null) params.set("column", column);
  return adminFetch<AdminTableResponse>(
    `/api/admin/tables/${table}?${params}`,
  );
};

export const getAdminPhotoFilters = () =>
  adminFetch<AdminPhotoFiltersResponse>("/api/admin/photo-filters");

export const getAdminPhotos = (
  participant: string,
  session: number | null,
  page: number,
  pageSize: number,
) => {
  const search = new URLSearchParams({
    participant,
    page: String(page),
    pageSize: String(pageSize),
  });
  if (session !== null) search.set("session", String(session));
  return adminFetch<AdminPhotosResponse>(`/api/admin/photos?${search}`);
};

export const createAdminParticipant = (username: string, password: string) =>
  adminFetch<CreateParticipantResponse>("/api/admin/participants", {
    method: "POST",
    body: { username, password },
  });

export const downloadAdminTable = async (
  table: AdminTableName,
): Promise<void> => {
  const token = getStoredAdminToken();
  const response = await fetch(`${API_BASE}/api/admin/tables/${table}.csv`, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });
  if (!response.ok) {
    if (response.status === 401) clearStoredAdminToken();
    throw await errorFromResponse(response);
  }
  const blob = await response.blob();
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `blinks-${table}.csv`;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
};

export const adminFrameImageSrc = (imageUrl: string): string =>
  `${API_BASE}${imageUrl}`;
