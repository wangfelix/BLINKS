// Mirror of the DRM reconstruction API contract (single-day, two-round).
// The SOURCE OF TRUTH is server/src/server.ts (repo root ../server) — if the
// server changes a response shape, update this file in the same change.

export type CategoryLabel = "work" | "break" | "other";

export type ActivityLabel =
  | "computer_or_monitor_use"
  | "watching_video"
  | "paper_reading_writing"
  | "handheld_device_use"
  | "remote_meeting"
  | "phone_call"
  | "in_person_interaction"
  | "tools_or_materials"
  | "eating_drinking"
  | "food_preparation"
  | "cleaning_household"
  | "assisting_person_animal"
  | "personal_care"
  | "walking_or_movement"
  | "no_task_engagement"
  | "other"
  | "unclear";

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
  onboarding: OnboardingStatusResponse;
  study: StudyCompletionResponse;
}

export interface StudyCompletionResponse {
  completedAt: number | null;
  completed: boolean;
}

export interface StudyStatusResponse extends StudyCompletionResponse {
  username: string;
  canManagePhotos: boolean;
}

export interface StudyCompletionMutationResponse extends StudyStatusResponse {
  ok: true;
}

/** First-run state stored with the authenticated user in auth.db. */
export interface OnboardingStatusResponse {
  username: string;
  mustChangePassword: boolean;
  onboardingCompletedAt: number | null;
  completed: boolean;
}

export interface OnboardingMutationResponse extends OnboardingStatusResponse {
  ok: true;
}

/** GET /api/profile */
export interface ProfileResponse {
  username: string;
  occupation: string | null;
  workDescription: string | null;
  wakeTime: string | null;
  bedTime: string | null;
  drmWebUrl: string;
}

/** One entry of GET /api/reconstruction/state's rounds array. */
export interface RoundState {
  round: 1 | 2;
  status: ReconstructionStatus;
  /** Round 2 stays locked until round 1 is submitted (server-enforced). */
  locked: boolean;
}

/** GET /api/reconstruction/state */
export interface StudyStateResponse {
  /** The pinned study day (YYYY-MM-DD, study TZ); null before any frames. */
  day: string | null;
  /**
   * Epoch extent of that day. The study day is anchored on the recording
   * session, so a recording that ran past local midnight makes the day longer
   * than its calendar date; never re-derive these from `day`. Null with `day`.
   */
  dayStartMs: number | null;
  dayEndMs: number | null;
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
  rawLabel: ActivityLabel | null;
  categoryLabel: CategoryLabel | null;
  source: ActivitySource;
  /** Opaque link to the immutable proposal row; null for participant-added rows. */
  proposalActivityId: number | null;
  /** Returned only when the server runs with DRM_DEV_MODE=1. */
  isIncorrectAnnotationInjected?: boolean;
  workloadRating: ExperienceRating | null;
  recoveryRating: ExperienceRating | null;
}

/** Frame of the assisted round (never present for self rounds). */
export interface Frame {
  device: string;
  session: number;
  frameIndex: number;
  captureEpochMs: number;
  // Deleted frames remain as timestamped audit tombstones. Their path is
  // cleared server-side, so the client receives no image URL.
  imageUrl: string | null;
  deletedAt: number | null;
}

/** GET /api/photos, available only after Step 1 is submitted. */
export interface PhotoDayResponse {
  day: string;
  frames: Frame[];
}

export interface RoundResponse {
  round: 1 | 2;
  day: string;
  /** Epoch extent of the study day; see StudyStateResponse.dayStartMs. */
  dayStartMs: number;
  dayEndMs: number;
  status: ReconstructionStatus;
  activities: Activity[];
  /** Present ONLY for round 2 (anti-leak, enforced server-side). */
  frames?: Frame[];
  /** Present ONLY for round 2: frames still awaiting VLM labels. */
  vlmPendingCount?: number;
  /** Present ONLY for round 2: true after the app's end-session event. */
  recordingEnded?: boolean;
}

/** Payload row for PUT /api/reconstruction/round/:round and POST .../submit. */
export interface ActivityInput {
  startMs: number;
  endMs: number;
  rawLabel: ActivityLabel | null;
  categoryLabel: CategoryLabel | null;
  source: ActivitySource;
  /** Opaque immutable-proposal link carried across boundary edits. */
  proposalActivityId: number | null;
  /** Required on submit for category 'work' (mental demand, 1-7). */
  workloadRating: ExperienceRating | null;
  /** Required on submit for category 'break' (mental recovery, 1-7). */
  recoveryRating: ExperienceRating | null;
}

export interface OkResponse {
  ok: true;
}

export interface DeleteFramesResponse {
  ok: boolean;
  requestedCount: number;
  deletedCount: number;
  alreadyDeletedCount: number;
  failedFrameIndexes?: number[];
}

export interface SubmitResponse {
  ok: true;
  submittedAt: number;
}

export interface ApiErrorBody {
  error: string;
  code?: string;
}
