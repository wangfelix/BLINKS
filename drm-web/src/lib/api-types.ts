// Mirror of the DRM reconstruction API contract.
// The SOURCE OF TRUTH is server/src/server.ts (repo root ../server) — if the
// server changes a response shape, update this file in the same change.

export type CategoryLabel = "work" | "break" | "other";

export type Condition = "control" | "assisted";

export type ReconstructionStatus = "none" | "draft" | "submitted";

export type ActivitySource = "vlm" | "user";

export interface LoginResponse {
  token: string;
  username: string;
}

/** One entry of GET /api/reconstruction/days */
export interface ReconstructionDay {
  day: string; // local calendar date key, YYYY-MM-DD in the study timezone
  dayNumber: number; // 1-based position among the participant's recorded days
  condition: Condition;
  frameCount: number;
  vlmPendingCount: number; // frames of that day with vlm_status IN ('pending','processing')
  status: ReconstructionStatus;
  available: boolean; // today is gated until availableFromHour (server-enforced)
  availableFromHour: number;
}

export interface ReconstructionDaysResponse {
  days: ReconstructionDay[]; // sorted day desc
}

/** Stored activity row as returned by GET /api/reconstruction/:day */
export interface Activity {
  id: number | null;
  position: number;
  startMs: number;
  endMs: number;
  rawLabel: string | null;
  categoryLabel: CategoryLabel | null;
  source: ActivitySource;
  vlmRawLabel: string | null;
  vlmCategory: string | null;
}

/** Frame of an assisted day (never present for control days). */
export interface Frame {
  captureEpochMs: number;
  imageUrl: string; // relative, e.g. /frames/<file_path>; auth via blinks_token cookie
  vlmLabel: string | null;
  vlmCategory: string | null;
}

export interface ReconstructionResponse {
  day: string;
  condition: Condition;
  status: ReconstructionStatus;
  activities: Activity[];
  /** Present ONLY for condition 'assisted' (anti-leak, enforced server-side). */
  frames?: Frame[];
}

/** Payload row for PUT /api/reconstruction/:day and POST .../submit. */
export interface ActivityInput {
  startMs: number;
  endMs: number;
  rawLabel: string | null;
  categoryLabel: CategoryLabel | null;
  source: ActivitySource;
  /**
   * Echo of the original VLM proposal this row derives from (null for
   * user-added rows). The server keeps a span-matching fallback, but only the
   * client can carry provenance across boundary edits — without the echo,
   * editing a time span would silently drop the row's VLM proposal from the
   * label-quality analysis.
   */
  vlmRawLabel: string | null;
  vlmCategory: CategoryLabel | null;
}

export interface OkResponse {
  ok: true;
}

export interface SubmitResponse {
  ok: true;
  submittedAt: number;
}

export interface ApiErrorBody {
  error: string;
}
