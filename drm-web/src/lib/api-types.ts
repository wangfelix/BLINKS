// Mirror of the DRM reconstruction API contract (single-day, two-round).
// The SOURCE OF TRUTH is server/src/server.ts (repo root ../server) — if the
// server changes a response shape, update this file in the same change.

export type CategoryLabel = "work" | "break" | "other";

/** How a round is edited: 'self' = from memory, 'assisted' = frames + VLM. */
export type RoundMode = "self" | "assisted";

export type ReconstructionStatus = "none" | "draft" | "submitted";

export type ActivitySource = "vlm" | "user";

/**
 * 7-point Likert experience rating (1 = Not at all, 7 = Very much). Work
 * activities rate mental demand, breaks rate mental recovery.
 */
export type ExperienceRating = 1 | 2 | 3 | 4 | 5 | 6 | 7;

export interface LoginResponse {
  token: string;
  username: string;
}

/** One entry of GET /api/reconstruction/state's rounds array. */
export interface RoundState {
  round: 1 | 2;
  /** null while round 2 is still locked (the mode would reveal the arm). */
  mode: RoundMode | null;
  status: ReconstructionStatus;
  /** Round 2 stays locked until round 1 is submitted (server-enforced). */
  locked: boolean;
}

/** GET /api/reconstruction/state */
export interface StudyStateResponse {
  /** The pinned study day (YYYY-MM-DD, study TZ); null before any frames. */
  day: string | null;
  frameCount: number;
  /** The evening gate: today's day opens at availableFromHour (server-enforced). */
  available: boolean;
  availableFromHour: number;
  rounds: RoundState[];
}

/** Stored activity row as returned by GET /api/reconstruction/round/:round */
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
  workloadRating: ExperienceRating | null;
  recoveryRating: ExperienceRating | null;
}

/** Frame of the assisted round (never present for self rounds). */
export interface Frame {
  captureEpochMs: number;
  imageUrl: string; // relative, e.g. /frames/<file_path>; auth via blinks_token cookie
  vlmLabel: string | null;
  vlmCategory: string | null;
}

export interface RoundResponse {
  round: 1 | 2;
  mode: RoundMode;
  day: string;
  status: ReconstructionStatus;
  activities: Activity[];
  /** Present ONLY for mode 'assisted' (anti-leak, enforced server-side). */
  frames?: Frame[];
  /** Present ONLY for mode 'assisted': frames still awaiting VLM labels. */
  vlmPendingCount?: number;
}

/** Payload row for PUT /api/reconstruction/round/:round and POST .../submit. */
export interface ActivityInput {
  startMs: number;
  endMs: number;
  rawLabel: string | null;
  categoryLabel: CategoryLabel | null;
  source: ActivitySource;
  /**
   * Echo of the original VLM proposal this row derives from (null for
   * user-added rows and everything on self rounds). The server keeps a
   * span-matching fallback, but only the client can carry provenance across
   * boundary edits — without the echo, editing a time span would silently
   * drop the row's VLM proposal from the label-quality analysis.
   */
  vlmRawLabel: string | null;
  vlmCategory: CategoryLabel | null;
  /** Required on submit for category 'work' (mental demand, 1-7). */
  workloadRating: ExperienceRating | null;
  /** Required on submit for category 'break' (mental recovery, 1-7). */
  recoveryRating: ExperienceRating | null;
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
