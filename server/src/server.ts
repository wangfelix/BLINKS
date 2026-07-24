import express from "express";
import http from "http";
import { WebSocketServer, WebSocket } from "ws";
import fs from "fs";
import path from "path";
import { URL } from "url";

import {
  AuthenticatedRequest,
  hashPassword,
  issueToken,
  participantFromAuthHeader,
  requireAuth,
  requireAuthWithCookieFallback,
  verifyPassword,
  verifyUserPassword,
} from "./auth";
import { getUser, initAuthDb, updatePasswordHash } from "./auth-db";
import {
  ActivityRow,
  ActivityWriteInput,
  closeFillingChunks,
  closeIdleChunks,
  countFramesOnDay,
  exportFramesCsv,
  listChunksOnDay,
  getFrameDeletionTarget,
  getFrameStatusByPath,
  getParticipant,
  getReconstruction,
  initDb,
  insertFrame,
  latestFrameDay,
  listActivities,
  listFrames,
  listFramesOnDay,
  listSessions,
  maxFrameIndex,
  parseArm,
  pinReconstructionRound,
  replaceActivities,
  setPushToken,
  softDeleteFrameRow,
  upsertParticipantProfile,
} from "./db";
import { segmentDay } from "./segmentation";
import { startPushScheduler } from "./push";
import {
  currentLocalHour,
  dayKeyFromEpochMs,
  timeOfDayToMinutes,
  todayKey,
} from "./time";

// ===========================================================================
// BLINKS ingestion + API server (BLE phone-relay architecture).
//
// The WebSocket client is the participant's PHONE (blinks-edge-app), not the
// ESP32: the camera has no WiFi and talks BLE to the phone, which relays each
// JPEG over its KIT VPN to this server. The phone authenticates with a bearer
// token (issued at /api/login) on the upgrade request and declares the session
// it is writing into, so BLE/WS reconnects continue the same session.
//
//   WS /ingest?session=<epochSeconds>&device=<cameraId>
//     per frame: JSON text {"t":<captureEpochMs>,"n":<cameraFrameCounter>}
//                followed by the binary JPEG
//
// Capture timestamps are PHONE-stamped (header-receipt time, within ~100 ms of
// true capture): the ESP32 has no clock. `device` is the camera's BLE MAC with
// colons stripped, supplied by the phone.
//
// The old MAC-based /assign model is gone: identity comes from login, and a
// participant can only ever read or delete their own frames.
// ===========================================================================

const PORT = Number(process.env.CAMERA_PORT ?? 3000);
const RECORDINGS_DIR =
  process.env.RECORDINGS_DIR ?? path.join(__dirname, "..", "recordings");
const DATA_DIR = process.env.DATA_DIR ?? path.join(__dirname, "..", "data");
const PAUSED_PATH = path.join(RECORDINGS_DIR, "paused.json");
const MAX_BATCH_DELETE_FRAMES = 500;

// DRM: where the reconstruction website lives (linked from the app + pushes),
// and the local hour from which TODAY's reconstruction opens (past days are
// always available; the gate is enforced server-side).
const WEB_URL = process.env.WEB_URL ?? "http://blinks.win.kit.edu";
const AVAILABLE_FROM_HOUR = Number(process.env.DRM_AVAILABLE_FROM_HOUR ?? 19);
const DRM_DEV_MODE = process.env.DRM_DEV_MODE === "1";

function ensureDir(dir: string): void {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

// Strip anything that is not a safe identifier character, preventing a
// malformed segment from escaping the recordings directory.
function sanitize(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]/g, "");
}

function looksLikeJpeg(buffer: Buffer): boolean {
  if (buffer.length < 4) return false;
  const soi = buffer[0] === 0xff && buffer[1] === 0xd8;
  const eoi =
    buffer[buffer.length - 2] === 0xff && buffer[buffer.length - 1] === 0xd9;
  return soi && eoi;
}

ensureDir(RECORDINGS_DIR);
ensureDir(DATA_DIR);

if (DRM_DEV_MODE) {
  console.warn(
    "DRM DEV MODE ENABLED: evening availability and round-order gates are bypassed",
  );
}

// Frame metadata lives next to the JPEGs (rsynced together for analysis);
// credentials live in their own DB outside the recordings tree (see auth-db).
initDb(path.join(RECORDINGS_DIR, "recordings.db"));
initAuthDb(process.env.AUTH_DB_PATH ?? path.join(DATA_DIR, "auth.db"));

// --- Pause state (participant -> paused) -----------------------------------
// The app pauses the camera directly over BLE; this server-side state is the
// defense-in-depth gate that drops any frame still in flight (or raced around
// the BLE control write) so a paused participant's images never reach disk.
let pausedParticipants = new Set<string>();

function loadPaused(): void {
  try {
    if (fs.existsSync(PAUSED_PATH)) {
      const arr: string[] = JSON.parse(fs.readFileSync(PAUSED_PATH, "utf8"));
      pausedParticipants = new Set(arr);
    }
  } catch (err) {
    console.error("Failed to load paused.json:", err);
  }
}

function persistPaused(): void {
  try {
    fs.writeFileSync(
      PAUSED_PATH,
      JSON.stringify(Array.from(pausedParticipants), null, 2),
    );
  } catch (err) {
    console.error("Failed to persist paused.json:", err);
  }
}

loadPaused();

const app = express();
app.use(express.json());

app.get("/health", (_req, res) => {
  res.json({ status: "ok", time: new Date().toISOString() });
});

// --- Auth -------------------------------------------------------------------

app.post("/api/login", async (req, res) => {
  const { username, password } = req.body as {
    username?: string;
    password?: string;
  };
  if (typeof username !== "string" || typeof password !== "string") {
    res.status(400).json({ error: "username and password are required" });
    return;
  }
  const cleanUsername = sanitize(username);
  const passwordOk = await verifyUserPassword(cleanUsername, password);
  if (!cleanUsername || !passwordOk) {
    res.status(401).json({ error: "wrong username or password" });
    return;
  }
  const token = issueToken(cleanUsername);
  console.log(`Login: ${cleanUsername}`);
  res.json({ token, username: cleanUsername });
});

app.post(
  "/api/change-password",
  requireAuth,
  async (req: AuthenticatedRequest, res) => {
    const participant = req.participant!;
    const { currentPassword, newPassword } = req.body as {
      currentPassword?: string;
      newPassword?: string;
    };
    if (
      typeof currentPassword !== "string" ||
      typeof newPassword !== "string"
    ) {
      res
        .status(400)
        .json({ error: "currentPassword and newPassword are required" });
      return;
    }
    if (newPassword.length < 8) {
      res
        .status(400)
        .json({ error: "the new password needs at least 8 characters" });
      return;
    }
    const user = getUser(participant);
    if (!user || !(await verifyPassword(user.password_hash, currentPassword))) {
      res.status(403).json({ error: "current password is incorrect" });
      return;
    }
    updatePasswordHash(participant, await hashPassword(newPassword));
    console.log(`Password changed: ${participant}`);
    res.json({ ok: true });
  },
);

// --- Participant read/edit API (each participant sees only their own data) --

app.get("/api/sessions", requireAuth, (req: AuthenticatedRequest, res) => {
  const sessions = listSessions(req.participant!).map((row) => ({
    device: row.device,
    session: row.session,
    startedAtMs: row.started_at_ms,
    endedAtMs: row.ended_at_ms,
    frameCount: row.frame_count,
    deletedFrameCount: row.deleted_frame_count,
  }));
  res.json({ sessions });
});

app.get(
  "/api/sessions/:device/:session/frames",
  requireAuth,
  (req: AuthenticatedRequest, res) => {
    const device = sanitize(req.params.device);
    const session = Number(req.params.session);
    if (!device || !Number.isInteger(session)) {
      res.status(400).json({ error: "invalid device or session" });
      return;
    }
    // Deliberately NO vlm_* fields: the mobile app must never receive VLM
    // output (anti-leak for the DRM control condition — labels exist only on
    // the reconstruction website, and only on assisted days).
    const frames = listFrames(req.participant!, device, session).map((row) => ({
      frameIndex: row.frame_index,
      captureEpochMs: row.capture_epoch_ms,
      imageUrl: `/frames/${row.file_path}`,
    }));
    res.json({ frames });
  },
);

interface DeleteFramesResult {
  ok: boolean;
  requestedCount: number;
  deletedCount: number;
  alreadyDeletedCount: number;
  failedFrameIndexes?: number[];
}

// Deletes files synchronously before marking their rows. Node's request
// handler cannot interleave another request between these synchronous steps,
// and failed unlinks leave the row active so a retry can try again. ENOENT is
// accepted: the file is already gone, and the retained row can still be
// safely soft-deleted.
const deleteFrames = (
  participant: string,
  device: string,
  session: number,
  frameIndexes: number[],
):
  | { status: 200 | 500; body: DeleteFramesResult }
  | { status: 404; body: { error: string; missingFrameIndexes: number[] } } => {
  const targets = frameIndexes.map((frameIndex) => ({
    frameIndex,
    target: getFrameDeletionTarget(participant, device, session, frameIndex),
  }));
  const missingFrameIndexes = targets
    .filter(({ target }) => target === undefined)
    .map(({ frameIndex }) => frameIndex);
  if (missingFrameIndexes.length > 0) {
    return {
      status: 404,
      body: { error: "one or more frames were not found", missingFrameIndexes },
    };
  }

  let deletedCount = 0;
  let alreadyDeletedCount = 0;
  const failedFrameIndexes: number[] = [];
  const recordingsRoot = path.resolve(RECORDINGS_DIR);

  for (const { frameIndex, target } of targets) {
    if (target!.deletedAt !== null) {
      alreadyDeletedCount += 1;
      continue;
    }

    try {
      const absolutePath = path.resolve(RECORDINGS_DIR, target!.filePath);
      if (
        absolutePath !== recordingsRoot &&
        !absolutePath.startsWith(`${recordingsRoot}${path.sep}`)
      ) {
        throw new Error("frame path escaped recordings directory");
      }
      try {
        fs.unlinkSync(absolutePath);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }

      if (softDeleteFrameRow(participant, device, session, frameIndex)) {
        deletedCount += 1;
        console.log(
          `Deleted frame file and retained row: ${participant}/${device}/${session}/#${frameIndex}`,
        );
      } else {
        alreadyDeletedCount += 1;
      }
    } catch (error) {
      failedFrameIndexes.push(frameIndex);
      console.error(
        `Failed to delete frame ${participant}/${device}/${session}/#${frameIndex}:`,
        error,
      );
    }
  }

  const body: DeleteFramesResult = {
    ok: failedFrameIndexes.length === 0,
    requestedCount: frameIndexes.length,
    deletedCount,
    alreadyDeletedCount,
    ...(failedFrameIndexes.length > 0 ? { failedFrameIndexes } : {}),
  };
  return { status: failedFrameIndexes.length > 0 ? 500 : 200, body };
};

// GDPR-relevant: delete the JPEG bytes while retaining a soft-deleted audit
// row. Repeating a successful deletion is idempotent.
app.delete(
  "/api/sessions/:device/:session/frames/:frameIndex",
  requireAuth,
  (req: AuthenticatedRequest, res) => {
    const device = sanitize(req.params.device);
    const session = Number(req.params.session);
    const frameIndex = Number(req.params.frameIndex);
    if (
      !device ||
      !Number.isInteger(session) ||
      !Number.isSafeInteger(frameIndex) ||
      frameIndex < 1
    ) {
      res.status(400).json({ error: "invalid device, session, or frameIndex" });
      return;
    }

    const result = deleteFrames(req.participant!, device, session, [frameIndex]);
    res.status(result.status).json(result.body);
  },
);

// Bounded, participant-scoped batch deletion. Duplicates are collapsed and a
// repeated request succeeds without changing counts or chunk bookkeeping.
app.delete(
  "/api/sessions/:device/:session/frames",
  requireAuth,
  (req: AuthenticatedRequest, res) => {
    const device = sanitize(req.params.device);
    const session = Number(req.params.session);
    const rawFrameIndexes = req.body?.frameIndexes;
    if (
      !device ||
      !Number.isInteger(session) ||
      !Array.isArray(rawFrameIndexes) ||
      rawFrameIndexes.length < 1 ||
      rawFrameIndexes.length > MAX_BATCH_DELETE_FRAMES ||
      !rawFrameIndexes.every(
        (value) => Number.isSafeInteger(value) && value >= 1,
      )
    ) {
      res.status(400).json({
        error: `frameIndexes must contain 1-${MAX_BATCH_DELETE_FRAMES} positive integers`,
      });
      return;
    }

    const frameIndexes = [...new Set<number>(rawFrameIndexes)];
    const result = deleteFrames(
      req.participant!,
      device,
      session,
      frameIndexes,
    );
    res.status(result.status).json(result.body);
  },
);

// Serves the JPEG bytes. Not express.static: every request must prove the
// requested path belongs to the authenticated participant (these are images
// of people and their homes). Cookie fallback (blinks_token) is for the DRM
// website's <img> tags only; all JSON APIs remain header-authenticated.
app.get("/frames/*", requireAuthWithCookieFallback, (req: AuthenticatedRequest, res) => {
  const relativePath = decodeURIComponent(req.path.slice("/frames/".length));
  const normalized = path.normalize(relativePath);
  if (
    normalized.startsWith("..") ||
    path.isAbsolute(normalized) ||
    !normalized.startsWith(`${req.participant!}${path.sep}`)
  ) {
    res.status(403).json({ error: "forbidden" });
    return;
  }
  // Serving gate: never hand back a frame whose face has not been blurred yet.
  // Anonymization happens in place shortly after ingestion (face-blur worker);
  // until face_status='done' the image is withheld, even from its owner.
  if (getFrameStatusByPath(req.participant!, normalized) !== "done") {
    res.status(404).json({ error: "frame not available yet" });
    return;
  }
  res.sendFile(normalized, { root: RECORDINGS_DIR }, (err) => {
    if (err && !res.headersSent) res.status(404).json({ error: "not found" });
  });
});

// On-demand CSV export from the DB, for the authenticated participant's own
// sessions (analysis on the VM reads the SQLite file directly instead).
app.get("/api/export.csv", requireAuth, (req: AuthenticatedRequest, res) => {
  const participant = req.participant!;
  const device = sanitize(String(req.query.device ?? ""));
  const session = Number(req.query.session);
  if (!device || !Number.isFinite(session)) {
    res
      .status(400)
      .json({ error: "query params 'device' and 'session' are required" });
    return;
  }
  const csv = exportFramesCsv({ participant, device, session });
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader(
    "Content-Disposition",
    `attachment; filename="${participant}-${device}-${session}-frames.csv"`,
  );
  res.send(csv);
});

// --- DRM: profile + push registration ----------------------------------------

app.get("/api/profile", requireAuth, (req: AuthenticatedRequest, res) => {
  const participant = getParticipant(req.participant!);
  // Deliberately no arm here: the participant must never learn (or be able to
  // infer before round 2 unlocks) which study arm they are in.
  res.json({
    username: req.participant!,
    occupation: participant?.occupation ?? null,
    workDescription: participant?.work_description ?? null,
    wakeTime: participant?.wake_time ?? null,
    bedTime: participant?.bed_time ?? null,
    drmWebUrl: WEB_URL,
  });
});

app.put("/api/profile", requireAuth, (req: AuthenticatedRequest, res) => {
  const { occupation, workDescription, wakeTime, bedTime } = req.body as {
    occupation?: unknown;
    workDescription?: unknown;
    wakeTime?: unknown;
    bedTime?: unknown;
  };
  if (
    typeof occupation !== "string" ||
    typeof workDescription !== "string" ||
    typeof wakeTime !== "string" ||
    typeof bedTime !== "string"
  ) {
    res.status(400).json({
      error: "occupation, workDescription, wakeTime and bedTime are required",
    });
    return;
  }
  // The bedtime drives the fallback push reminder, so it must parse.
  if (
    timeOfDayToMinutes(wakeTime.trim()) === undefined ||
    timeOfDayToMinutes(bedTime.trim()) === undefined
  ) {
    res
      .status(400)
      .json({ error: "wakeTime and bedTime must be HH:MM (24-hour)" });
    return;
  }
  // Upserts only the profile fields; arm is provisioning state and is never
  // clobbered here.
  upsertParticipantProfile(
    req.participant!,
    occupation.trim(),
    workDescription.trim(),
    wakeTime.trim(),
    bedTime.trim(),
  );
  res.json({ ok: true });
});

app.post("/api/register-push", requireAuth, (req: AuthenticatedRequest, res) => {
  const { expoPushToken } = req.body as { expoPushToken?: unknown };
  if (typeof expoPushToken !== "string" || expoPushToken.trim().length === 0) {
    res.status(400).json({ error: "expoPushToken is required" });
    return;
  }
  setPushToken(req.participant!, expoPushToken.trim());
  res.json({ ok: true });
});

// --- DRM: two-round reconstruction API ----------------------------------------
//
// Single-day, two-round design: each participant reconstructs ONE field day
// (the "study day" = their latest local date with >=1 frame, pinned on first
// open) in two sequential rounds the same evening. Round 1 is always SELF
// (from memory — no frames, no VLM output). Round 2 unlocks only after round
// 1 is SUBMITTED (server-enforced, so the VLM proposals can never contaminate
// the from-memory recall) and its mode depends on the provisioning-time arm:
// main -> assisted (frames + VLM segmentation), control -> self again (pure
// second-attempt baseline). Reconstructing TODAY only opens at
// AVAILABLE_FROM_HOUR local time (a past study day is always available).

const CATEGORY_LABELS = new Set(["work", "break", "other"]);

const isDayAvailable = (day: string): boolean => {
  const today = todayKey();
  if (day < today) return true;
  if (day > today) return false;
  return currentLocalHour() >= AVAILABLE_FROM_HOUR;
};

// The study day: pinned by round 1's reconstruction row once that round was
// first opened; before that, the latest frame day. Undefined = no frames yet.
const resolveStudyDay = (participant: string): string | undefined =>
  getReconstruction(participant, 1)?.day ?? latestFrameDay(participant);

// Round 1 is always self; round 2's mode derives from the provisioning-time
// arm (pinned onto the reconstruction row when round 2 is first opened).
const modeForRound = (participant: string, round: number): string =>
  round === 1
    ? "self"
    : parseArm(getParticipant(participant)?.arm) === "main"
      ? "assisted"
      : "self";

const toActivityJson = (row: ActivityRow) => ({
  id: row.id,
  position: row.position,
  startMs: row.start_ms,
  endMs: row.end_ms,
  rawLabel: row.raw_label,
  categoryLabel: row.category_label,
  source: row.source,
  vlmRawLabel: row.vlm_raw_label,
  vlmCategory: row.vlm_category,
  workloadRating: row.workload_rating,
  recoveryRating: row.recovery_rating,
});

// Hard ceiling well above any real day (a 16 h day at 30 s frames segments
// into far fewer activities); protects the propagation loop from abuse.
const MAX_ACTIVITIES_PER_ROUND = 300;

// Validates the replace-all activities body shared by draft PUT and submit.
// requireLabels (submit) additionally demands a non-empty rawLabel AND a
// categoryLabel on every activity, plus the category's experience rating
// (work -> workloadRating, break -> recoveryRating; both 7-point Likert).
// Every span must lie within the pinned study day and spans must not
// overlap — the assisted submit propagation stamps user_corrected_* onto
// frames by time range, so an out-of-day span could otherwise rewrite frames
// outside the study day. On SELF rounds every activity must be user-sourced
// and carries no VLM provenance (there is no VLM proposal the participant
// could have seen).
const parseActivityInputs = (
  body: unknown,
  day: string,
  requireLabels: boolean,
  mode: string,
): { activities?: ActivityWriteInput[]; error?: string } => {
  const list = (body as { activities?: unknown } | undefined)?.activities;
  if (!Array.isArray(list)) return { error: "activities array is required" };
  if (list.length > MAX_ACTIVITIES_PER_ROUND) {
    return { error: `too many activities (max ${MAX_ACTIVITIES_PER_ROUND})` };
  }

  const activities: ActivityWriteInput[] = [];
  for (const [index, item] of list.entries()) {
    const entry = item as {
      startMs?: unknown;
      endMs?: unknown;
      rawLabel?: unknown;
      categoryLabel?: unknown;
      source?: unknown;
      vlmRawLabel?: unknown;
      vlmCategory?: unknown;
      workloadRating?: unknown;
      recoveryRating?: unknown;
    };
    const { startMs, endMs, rawLabel, categoryLabel, source } = entry;
    if (
      typeof startMs !== "number" ||
      typeof endMs !== "number" ||
      !Number.isFinite(startMs) ||
      !Number.isFinite(endMs) ||
      endMs < startMs
    ) {
      return { error: `activity ${index}: invalid startMs/endMs` };
    }
    if (
      dayKeyFromEpochMs(startMs) !== day ||
      dayKeyFromEpochMs(endMs) !== day
    ) {
      return { error: `activity ${index}: span must lie within ${day}` };
    }
    if (rawLabel !== null && rawLabel !== undefined && typeof rawLabel !== "string") {
      return { error: `activity ${index}: rawLabel must be a string or null` };
    }
    const trimmedLabel =
      typeof rawLabel === "string" && rawLabel.trim().length > 0
        ? rawLabel.trim()
        : null;
    if (
      categoryLabel !== null &&
      categoryLabel !== undefined &&
      !CATEGORY_LABELS.has(categoryLabel as string)
    ) {
      return {
        error: `activity ${index}: categoryLabel must be work, break, other, or null`,
      };
    }
    if (source !== "vlm" && source !== "user") {
      return { error: `activity ${index}: source must be 'vlm' or 'user'` };
    }
    if (mode !== "assisted" && source !== "user") {
      return { error: `activity ${index}: source must be 'user' on a self round` };
    }
    if (requireLabels && trimmedLabel === null) {
      return { error: `activity ${index}: rawLabel is required to submit` };
    }
    if (requireLabels && (categoryLabel === null || categoryLabel === undefined)) {
      return { error: `activity ${index}: categoryLabel is required to submit` };
    }

    // Experience ratings: 7-point Likert, integer 1-7 or null. Both fields are
    // stored as sent (a draft keeps an earlier answer when the participant
    // flips the category back and forth); submit requires the rating that
    // matches the final category.
    const parseRating = (
      value: unknown,
      field: string,
    ): { rating?: number | null; error?: string } => {
      if (value === null || value === undefined) return { rating: null };
      if (!Number.isInteger(value) || (value as number) < 1 || (value as number) > 7) {
        return { error: `activity ${index}: ${field} must be an integer 1-7 or null` };
      }
      return { rating: value as number };
    };
    const workload = parseRating(entry.workloadRating, "workloadRating");
    if (workload.error) return { error: workload.error };
    const recovery = parseRating(entry.recoveryRating, "recoveryRating");
    if (recovery.error) return { error: recovery.error };
    if (requireLabels && categoryLabel === "work" && workload.rating === null) {
      return {
        error: `activity ${index}: workloadRating (1-7) is required to submit a work activity`,
      };
    }
    if (requireLabels && categoryLabel === "break" && recovery.rating === null) {
      return {
        error: `activity ${index}: recoveryRating (1-7) is required to submit a break activity`,
      };
    }
    // VLM-proposal provenance, echoed by the web client so it survives span
    // edits (the DB-side exact-span fallback only covers unchanged spans).
    // Client-supplied, but it can only distort the participant's own
    // label-quality bookkeeping; the frame-level vlm_* columns stay VLM-owned.
    // Self rounds never carry provenance (no proposal was ever shown).
    const vlmRawLabel =
      mode === "assisted" &&
      typeof entry.vlmRawLabel === "string" &&
      entry.vlmRawLabel.length > 0
        ? entry.vlmRawLabel
        : null;
    const vlmCategory =
      mode === "assisted" && CATEGORY_LABELS.has(entry.vlmCategory as string)
        ? (entry.vlmCategory as string)
        : null;
    activities.push({
      start_ms: startMs,
      end_ms: endMs,
      raw_label: trimmedLabel,
      category_label: (categoryLabel as string | null | undefined) ?? null,
      source,
      vlm_raw_label: vlmRawLabel,
      vlm_category: vlmCategory,
      workload_rating: workload.rating ?? null,
      recovery_rating: recovery.rating ?? null,
    });
  }

  // Overlap check: sharing a boundary instant is allowed (adjacent activities
  // touch), a true overlap is not (it would double-stamp frames on submit).
  const sortedByStart = [...activities].sort((a, b) => a.start_ms - b.start_ms);
  for (let i = 1; i < sortedByStart.length; i++) {
    if (sortedByStart[i].start_ms < sortedByStart[i - 1].end_ms) {
      return { error: "activities must not overlap in time" };
    }
  }
  return { activities };
};

// The whole evening at a glance: the pinned/derived study day and both
// rounds' status, so the website can render the linear two-step flow without
// any client-side study logic. Round 2's mode is revealed ONLY once round 1
// is submitted — before that a control participant could infer their arm.
app.get(
  "/api/reconstruction/state",
  requireAuth,
  (req: AuthenticatedRequest, res) => {
    const participant = req.participant!;
    const round1 = getReconstruction(participant, 1);
    const round2 = getReconstruction(participant, 2);
    const day = resolveStudyDay(participant) ?? null;
    const round1Submitted = round1?.status === "submitted";
    const round2Unlocked = DRM_DEV_MODE || round1Submitted;
    res.json({
      day,
      frameCount: day === null ? 0 : countFramesOnDay(participant, day),
      available: day !== null && (DRM_DEV_MODE || isDayAvailable(day)),
      availableFromHour: AVAILABLE_FROM_HOUR,
      rounds: [
        {
          round: 1,
          mode: "self",
          status: round1?.status ?? "none",
          locked: false,
        },
        {
          round: 2,
          mode: round2Unlocked
            ? (round2?.mode ?? modeForRound(participant, 2))
            : null,
          status: round2?.status ?? "none",
          locked: !round2Unlocked,
        },
      ],
    });
  },
);

// Shared guard for round reads and writes. Responds and returns undefined
// when the round is malformed, there is no study day yet, the evening gate is
// closed, round 2 is still locked behind round 1 (the fixed-order invariant,
// enforced here and not just in the UI), or — writes only — the round is
// already submitted.
const guardRound = (
  req: AuthenticatedRequest,
  res: express.Response,
  forWrite: boolean,
): { round: number; day: string; mode: string } | undefined => {
  const round = Number(req.params.round);
  if (round !== 1 && round !== 2) {
    res.status(400).json({ error: "round must be 1 or 2" });
    return undefined;
  }
  const participant = req.participant!;
  const existing = getReconstruction(participant, round);
  const day = existing?.day ?? resolveStudyDay(participant);
  if (day === undefined) {
    res.status(404).json({ error: "no frames recorded yet" });
    return undefined;
  }
  // The evening gate applies to reads too: before AVAILABLE_FROM_HOUR a
  // premature GET would not only show a partial day, it would also pin the
  // study day (and later bootstrap the segmentation) on a half-finished day.
  if (!DRM_DEV_MODE && !isDayAvailable(day)) {
    res.status(403).json({
      error: `the reconstruction opens at ${AVAILABLE_FROM_HOUR}:00`,
    });
    return undefined;
  }
  if (
    !DRM_DEV_MODE &&
    round === 2 &&
    getReconstruction(participant, 1)?.status !== "submitted"
  ) {
    res.status(403).json({ error: "step 1 must be submitted first" });
    return undefined;
  }
  const mode = existing?.mode ?? modeForRound(participant, round);
  if (forWrite && existing?.status === "submitted") {
    res.status(409).json({ error: "this step is already submitted" });
    return undefined;
  }
  return { round, day, mode };
};

app.get(
  "/api/reconstruction/round/:round",
  requireAuth,
  (req: AuthenticatedRequest, res) => {
    const guard = guardRound(req, res, false);
    if (!guard) return;
    const participant = req.participant!;
    const { round, day, mode } = guard;

    // Pin mode + study day on first open (INSERT OR IGNORE) so neither can
    // shift afterwards (new frames the next morning, frame deletion, or an
    // arm change mid-evening).
    pinReconstructionRound(participant, round, mode, day);

    let reconstruction = getReconstruction(participant, round);
    let activities = listActivities(participant, round);

    const payload: Record<string, unknown> = {
      round,
      mode,
      day,
      status: reconstruction?.status ?? "none",
    };

    // Frames and VLM output go ONLY to the assisted round — on self rounds
    // the participant reconstructs from memory alone, so leaking them here
    // would contaminate the design (round 1 recall AND the control arm's
    // second attempt). Enforced server-side, not just in UI.
    if (mode === "assisted") {
      const dayFrames = listFramesOnDay(participant, day);
      const servedFrames = dayFrames.filter((f) => f.face_status === "done");
      // Pending = frames whose 5-minute chunk is not terminal yet (filling /
      // ready / processing). Legacy frames without a chunk are frozen, and
      // face_status='failed' frames can never feed a chunk's VLM input — do
      // not let either hold the round in "still processing" forever.
      const vlmPendingCount = dayFrames.filter(
        (f) =>
          f.chunk_status !== null &&
          f.chunk_status !== "done" &&
          f.chunk_status !== "failed" &&
          f.face_status !== "failed",
      ).length;

      // The assisted round bootstraps itself: once the VLM pass is complete
      // and no activities are stored, the initial segmentation is generated,
      // persisted as a draft, and returned. While labels are still processing
      // the round stays empty (the website shows "still processing"). Keyed
      // on empty activities + not submitted (NOT on the reconstructions row,
      // which pin-on-open creates eagerly); side effect: an assisted draft
      // deliberately emptied by the participant re-proposes on reload, which
      // is the self-healing behavior we want pre-submit.
      if (
        reconstruction?.status !== "submitted" &&
        activities.length === 0 &&
        vlmPendingCount === 0 &&
        servedFrames.length > 0
      ) {
        // Segmentation runs on the day's CHUNKS: consecutive same-label
        // windows group into one activity, with activity bounds at the real
        // first/last frame times inside the grouped windows. Failed or
        // unlabeled chunks come in as null/null (segmentDay merges them into
        // a labeled neighbor); chunks with no servable frame are skipped.
        const dayChunks = listChunksOnDay(participant, day);
        const segments = segmentDay(
          dayChunks
            .filter(
              (chunk) =>
                chunk.first_frame_ms !== null && chunk.last_frame_ms !== null,
            )
            .map((chunk) => ({
              firstFrameMs: chunk.first_frame_ms!,
              lastFrameMs: chunk.last_frame_ms!,
              vlmLabel: chunk.status === "done" ? chunk.vlm_label : null,
              vlmCategory:
                chunk.status === "done" &&
                chunk.vlm_category !== null &&
                CATEGORY_LABELS.has(chunk.vlm_category)
                  ? chunk.vlm_category
                  : null,
            })),
        );
        replaceActivities({
          participant,
          round,
          mode,
          day,
          submit: false,
          activities: segments.map((segment) => ({
            start_ms: segment.startMs,
            end_ms: segment.endMs,
            raw_label: segment.rawLabel,
            category_label: segment.categoryLabel,
            source: "vlm",
            // The generated proposal IS the VLM's proposal: record it for the
            // label-quality analysis (user edits later diverge from these).
            vlm_raw_label: segment.rawLabel,
            vlm_category: segment.categoryLabel,
          })),
        });
        reconstruction = getReconstruction(participant, round);
        activities = listActivities(participant, round);
        console.log(
          `Generated initial segmentation: ${participant}/round ${round} (${activities.length} activities)`,
        );
      }

      payload.status = reconstruction?.status ?? "none";
      payload.vlmPendingCount = vlmPendingCount;
      payload.frames = servedFrames.map((frame) => ({
        captureEpochMs: frame.capture_epoch_ms,
        imageUrl: `/frames/${frame.file_path}`,
        vlmLabel: frame.vlm_label,
        vlmCategory: frame.vlm_category,
      }));
    }

    payload.activities = activities.map(toActivityJson);
    res.json(payload);
  },
);

// Replace-all draft save.
app.put(
  "/api/reconstruction/round/:round",
  requireAuth,
  (req: AuthenticatedRequest, res) => {
    const guard = guardRound(req, res, true);
    if (!guard) return;
    const { activities, error } = parseActivityInputs(
      req.body,
      guard.day,
      false,
      guard.mode,
    );
    if (!activities) {
      res.status(400).json({ error: error! });
      return;
    }
    replaceActivities({
      participant: req.participant!,
      round: guard.round,
      mode: guard.mode,
      day: guard.day,
      activities,
      submit: false,
    });
    res.json({ ok: true });
  },
);

// Atomic save + lock; the ASSISTED round additionally propagates the labels
// onto the frames in each activity's span (the per-frame label-quality
// ground truth). Submitting round 1 unlocks round 2.
app.post(
  "/api/reconstruction/round/:round/submit",
  requireAuth,
  (req: AuthenticatedRequest, res) => {
    const guard = guardRound(req, res, true);
    if (!guard) return;
    const { activities, error } = parseActivityInputs(
      req.body,
      guard.day,
      true,
      guard.mode,
    );
    if (!activities) {
      res.status(400).json({ error: error! });
      return;
    }
    const { submittedAt } = replaceActivities({
      participant: req.participant!,
      round: guard.round,
      mode: guard.mode,
      day: guard.day,
      activities,
      submit: true,
    });
    console.log(
      `Reconstruction round ${guard.round} (${guard.mode}) submitted: ${req.participant}/${guard.day} (${activities.length} activities)`,
    );
    res.json({ ok: true, submittedAt });
  },
);

// --- Pause / resume (participant from token) --------------------------------

app.post("/api/pause", requireAuth, (req: AuthenticatedRequest, res) => {
  pausedParticipants.add(req.participant!);
  persistPaused();
  console.log(`Paused participant ${req.participant}`);
  res.json({ ok: true, paused: true });
});

app.post("/api/resume", requireAuth, (req: AuthenticatedRequest, res) => {
  pausedParticipants.delete(req.participant!);
  persistPaused();
  console.log(`Resumed participant ${req.participant}`);
  res.json({ ok: true, paused: false });
});

// The app's explicit End-session signal (Stop, not Pause): the day's
// recording is over, so the trailing still-filling 5-minute chunk can go to
// the VLM immediately instead of waiting for the idle sweep. The sweep stays
// as the fallback for crashes / lost connectivity, and any frame that still
// straggles in lands in its (now 'ready') chunk before the VLM worker samples
// the frames at claim time.
app.post(
  "/api/recording/ended",
  requireAuth,
  (req: AuthenticatedRequest, res) => {
    const closedChunks = closeFillingChunks(req.participant!);
    if (closedChunks > 0) {
      console.log(
        `Recording ended: ${req.participant} — closed ${closedChunks} chunk(s) for VLM`,
      );
    }
    res.json({ ok: true, closedChunks });
  },
);

// --- WebSocket ingestion (the phone is the client) ---------------------------

const server = http.createServer(app);
const wss = new WebSocketServer({ server });

wss.on("connection", (ws: WebSocket, req) => {
  const requestUrl = new URL(req.url ?? "", `http://${req.headers.host}`);

  if (requestUrl.pathname !== "/ingest") {
    console.error(`Rejected WS connection with path: ${requestUrl.pathname}`);
    ws.close(1008, "unknown path");
    return;
  }

  const participant = participantFromAuthHeader(req.headers.authorization);
  if (!participant) {
    console.error("Rejected WS connection: invalid or missing token");
    ws.close(1008, "unauthorized");
    return;
  }

  const device = sanitize(requestUrl.searchParams.get("device") ?? "");
  const session = Number(requestUrl.searchParams.get("session"));
  if (!device || !Number.isInteger(session) || session <= 0) {
    console.error(
      `Rejected WS connection for ${participant}: bad device/session params`,
    );
    ws.close(1008, "device and session query params required");
    return;
  }

  const sessionDir = path.join(
    RECORDINGS_DIR,
    participant,
    device,
    String(session),
  );
  const imagesDir = path.join(sessionDir, "images");
  ensureDir(imagesDir);

  // Continue numbering across reconnects within the same declared session.
  let frameNumber = maxFrameIndex(participant, device, session);
  let pendingMeta: { t: number; n: number | null } | null = null;

  console.log(
    `Phone connected: participant=${participant} device=${device} session=${session} (resuming at frame ${frameNumber})`,
  );

  ws.on("message", (data: Buffer, isBinary: boolean) => {
    if (!isBinary) {
      const text = data.toString();
      if (text === "heartbeat") return;

      // Frame metadata arrives as JSON just before its binary frame.
      try {
        const meta = JSON.parse(text);
        if (typeof meta.t === "number") {
          pendingMeta = {
            t: meta.t,
            n: Number.isFinite(meta.n) ? Number(meta.n) : null,
          };
          return;
        }
      } catch {
        // not JSON, fall through to control logging
      }
      console.log(`[${participant}/${device}] control: ${text}`);
      return;
    }

    // Defense in depth: never persist a frame for a paused participant, no
    // matter what the phone or camera did with the pause state.
    if (pausedParticipants.has(participant)) {
      pendingMeta = null;
      console.log(
        `[${participant}/${device}] dropped frame: participant is paused`,
      );
      return;
    }

    const buffer = data;
    frameNumber += 1;
    const receivedEpochMs = Date.now();

    const captureEpochMs = pendingMeta?.t ?? null;
    const cameraFrame = pendingMeta?.n ?? null;
    pendingMeta = null;

    // Use the capture time for the filename when available, else receipt time.
    const stamp = captureEpochMs ?? receivedEpochMs;

    const jpegOk = looksLikeJpeg(buffer);
    if (!jpegOk) {
      console.warn(
        `[${participant}/${device}] frame ${frameNumber} does not look like a complete JPEG (${buffer.length} bytes)`,
      );
    }

    const fileName = `frame-${String(frameNumber).padStart(6, "0")}-${stamp}.jpg`;
    const filePath = path.join(imagesDir, fileName);

    fs.writeFile(filePath, buffer, (err) => {
      if (err) console.error(`Failed to write ${fileName}:`, err);
    });

    insertFrame({
      participant,
      device,
      session,
      frame_index: frameNumber,
      capture_epoch_ms: captureEpochMs ?? receivedEpochMs,
      received_epoch_ms: receivedEpochMs,
      file_path: path.relative(RECORDINGS_DIR, filePath),
      device_frame: cameraFrame,
      byte_length: buffer.length,
      jpeg_ok: jpegOk ? 1 : 0,
    });
  });

  ws.on("close", () => {
    console.log(
      `Phone disconnected: ${participant}/${device} session=${session} (at frame ${frameNumber})`,
    );
  });

  ws.on("error", (err) => {
    console.error(`WebSocket error for ${participant}/${device}:`, err);
  });
});

startPushScheduler();

// Chunk idle sweep: a session's LAST 5-minute window never sees a later
// frame, so it is closed once no new frame has arrived for CHUNK_IDLE_CLOSE_MS
// (server receipt time — a delayed catch-up upload keeps its chunk open while
// frames are still streaming in). 60 s tick, same cadence as the push loop.
const CHUNK_IDLE_CLOSE_MS = Number(
  process.env.CHUNK_IDLE_CLOSE_MS ?? 10 * 60 * 1000,
);
setInterval(() => {
  try {
    const closed = closeIdleChunks(CHUNK_IDLE_CLOSE_MS);
    if (closed > 0) {
      console.log(`Chunk idle sweep: closed ${closed} chunk(s) for VLM`);
    }
  } catch (err) {
    console.error("Chunk idle sweep failed:", err);
  }
}, 60_000);

server.listen(PORT, () => {
  console.log(`BLINKS server listening on http://0.0.0.0:${PORT}`);
  console.log(`Health:  http://localhost:${PORT}/health`);
  console.log(`Ingest:  ws://localhost:${PORT}/ingest (bearer token required)`);
  console.log(`Recordings directory: ${RECORDINGS_DIR}`);
});
