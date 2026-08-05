import express, { NextFunction, Response } from "express";
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
  requireActiveStudy,
  requireAdmin,
  requireAdminWithCookieFallback,
  requireAuth,
  requireCompletedOnboarding,
  requireAuthWithCookieFallback,
  verifyPassword,
  verifyUserPassword,
} from "./auth";
import {
  completeOnboarding,
  completeStudy,
  deleteParticipantUser,
  getUser,
  initAuthDb,
  insertUser,
  isStudyComplete,
  markPasswordChanged,
} from "./auth-db";
import {
  ActivityRow,
  ActivityWriteInput,
  closeFillingChunksForSession,
  closeIdleChunks,
  countFramesOnDay,
  createVlmProposal,
  ensureParticipant,
  exportAdminTableCsv,
  exportFramesCsv,
  getAdminFrameAvailabilityByPath,
  getAdminParticipantCount,
  getAdminTableColumns,
  getAdminTableCounts,
  getActivityList,
  listChunksOnDay,
  getFrameDeletionTarget,
  getFrameStatusByPath,
  getParticipant,
  getRoundResponseList,
  initDb,
  insertFrame,
  isAdminTableName,
  latestFrameDay,
  listActivities,
  listActivitiesByKind,
  listAdminPhotoParticipants,
  listAdminPhotos,
  listAdminPhotoSessions,
  listAdminTableRows,
  listFrames,
  listFramesOnDay,
  listPhotoFramesOnDay,
  listPausedParticipants,
  listSessions,
  latestRecordingEvent,
  markRoundResponseOpened,
  markVlmProposalViewed,
  maxFrameIndex,
  pinRoundResponseList,
  recordRecordingEvent,
  RecordingEventConflictError,
  RecordingEventInput,
  RecordingEventType,
  replaceActivities,
  setPushToken,
  softDeleteFrameRow,
  upsertParticipantProfile,
} from "./db";
import { ACTIVITY_LABEL_SET } from "./activity-vocabulary";
import { injectIncorrectAnnotations } from "./incorrect-annotation-injection";
import { segmentDay } from "./segmentation";
import { getPushSchedulerStatus, startPushScheduler } from "./push";
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
const HOST = process.env.CAMERA_HOST ?? "0.0.0.0";
const RECORDINGS_DIR =
  process.env.RECORDINGS_DIR ?? path.join(__dirname, "..", "recordings");
const DATA_DIR = process.env.DATA_DIR ?? path.join(__dirname, "..", "data");
const MAX_BATCH_DELETE_FRAMES = 500;

// DRM: where the reconstruction website lives (linked from the app + pushes),
// and the local hour from which TODAY's reconstruction opens (past days are
// always available; the gate is enforced server-side).
const WEB_URL = process.env.WEB_URL ?? "https://blinks.win.kit.edu";
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
// It is rebuilt from the latest append-only recording event on server start.
const pausedParticipants = new Set(listPausedParticipants());

const app = express();
app.use(express.json());

app.get("/health", (_req, res) => {
  res.json({
    status: "ok",
    time: new Date().toISOString(),
    pushScheduler: getPushSchedulerStatus(),
  });
});

// --- Auth -------------------------------------------------------------------

const onboardingJson = (user: NonNullable<ReturnType<typeof getUser>>) => ({
  username: user.username,
  mustChangePassword: user.must_change_password === 1,
  onboardingCompletedAt: user.onboarding_completed_at,
  completed:
    user.must_change_password === 0 && user.onboarding_completed_at !== null,
});

const studyCompletionJson = (
  user: NonNullable<ReturnType<typeof getUser>>,
) => ({
  completedAt: user.study_completed_at,
  completed: user.study_completed_at !== null,
});

const studyStatusJson = (participant: string) => {
  const user = getUser(participant)!;
  return {
    username: participant,
    ...studyCompletionJson(user),
    canManagePhotos:
      getRoundResponseList(participant, 1)?.status === "submitted",
  };
};

// Photos are deliberately hidden until the participant has submitted the
// memory-only Self DRM round. This is authoritative for every mobile/web
// listing, image response, and deletion path so a client-side bug or direct
// URL cannot contaminate unaided recall.
const requirePhotoAccess = (
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
): void => {
  const participant = req.participant;
  if (
    !participant ||
    getRoundResponseList(participant, 1)?.status !== "submitted"
  ) {
    res.status(403).json({
      error: "step 1 must be submitted first",
      code: "photo_access_locked",
    });
    return;
  }
  next();
};

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
  if (
    !cleanUsername ||
    !passwordOk ||
    getUser(cleanUsername)?.role !== "participant"
  ) {
    res.status(401).json({ error: "wrong username or password" });
    return;
  }
  const token = issueToken(cleanUsername);
  const user = getUser(cleanUsername)!;
  console.log(`Login: ${cleanUsername}`);
  res.json({
    token,
    username: cleanUsername,
    onboarding: onboardingJson(user),
    study: studyCompletionJson(user),
  });
});

// --- Research administration ----------------------------------------------

app.post("/api/admin/login", async (req, res) => {
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
  if (!cleanUsername || !passwordOk || getUser(cleanUsername)?.role !== "admin") {
    res.status(401).json({ error: "wrong administrator username or password" });
    return;
  }
  const token = issueToken(cleanUsername);
  console.log(`Admin login: ${cleanUsername}`);
  res.json({ token, username: cleanUsername, role: "admin" });
});

app.get(
  "/api/admin/status",
  requireAdmin,
  (req: AuthenticatedRequest, res) => {
    res.json({ username: req.participant!, role: "admin" });
  },
);

app.get(
  "/api/admin/overview",
  requireAdmin,
  (_req: AuthenticatedRequest, res) => {
    const sessions = listAdminPhotoSessions();
    res.json({
      tableCounts: getAdminTableCounts(),
      participantCount: getAdminParticipantCount(),
      sessionCount: sessions.length,
      availablePhotoCount: sessions.reduce(
        (sum, session) => sum + session.available_frame_count,
        0,
      ),
    });
  },
);

app.get(
  "/api/admin/tables/:table.csv",
  requireAdmin,
  (req: AuthenticatedRequest, res) => {
    const table = req.params.table;
    if (!isAdminTableName(table)) {
      res.status(404).json({ error: "unknown admin table" });
      return;
    }
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="blinks-${table}.csv"`,
    );
    res.send(exportAdminTableCsv(table));
  },
);

const adminPagination = (req: AuthenticatedRequest) => {
  const page = Math.max(1, Math.floor(Number(req.query.page) || 1));
  const pageSize = Math.min(
    200,
    Math.max(1, Math.floor(Number(req.query.pageSize) || 50)),
  );
  return { page, pageSize, offset: (page - 1) * pageSize };
};

app.get(
  "/api/admin/tables/:table",
  requireAdmin,
  (req: AuthenticatedRequest, res) => {
    const table = req.params.table;
    if (!isAdminTableName(table)) {
      res.status(404).json({ error: "unknown admin table" });
      return;
    }
    const search = String(req.query.search ?? "").trim();
    const column = String(req.query.column ?? "").trim();
    if (search.length > 200) {
      res.status(400).json({ error: "table search is limited to 200 characters" });
      return;
    }
    if (column !== "" && !getAdminTableColumns(table).includes(column)) {
      res.status(400).json({ error: "unknown admin table column" });
      return;
    }
    const { page, pageSize, offset } = adminPagination(req);
    res.json({
      ...listAdminTableRows(table, {
        limit: pageSize,
        offset,
        search,
        column: column || undefined,
      }),
      page,
      pageSize,
    });
  },
);

app.get(
  "/api/admin/photo-filters",
  requireAdmin,
  (_req: AuthenticatedRequest, res) => {
    res.json({
      participants: listAdminPhotoParticipants(),
      sessions: listAdminPhotoSessions(),
    });
  },
);

app.get(
  "/api/admin/photos",
  requireAdmin,
  (req: AuthenticatedRequest, res) => {
    const participant = String(req.query.participant ?? "").trim();
    if (!participant || sanitize(participant) !== participant) {
      res.status(400).json({ error: "a valid participant query is required" });
      return;
    }
    const rawSession = req.query.session;
    const session = rawSession === undefined ? undefined : Number(rawSession);
    if (session !== undefined && !Number.isSafeInteger(session)) {
      res.status(400).json({ error: "session must be an integer" });
      return;
    }
    const { page, pageSize, offset } = adminPagination(req);
    const result = listAdminPhotos({
      participant,
      session,
      limit: pageSize,
      offset,
    });
    res.json({
      participant,
      session: session ?? null,
      page,
      pageSize,
      total: result.total,
      frames: result.rows.map((row) => ({
        participant: row.participant,
        device: row.device,
        session: row.session,
        frameIndex: row.frame_index,
        captureEpochMs: row.capture_epoch_ms,
        faceStatus: row.face_status,
        deletedAt: row.deleted_at,
        imageUrl:
          row.face_status === "done" && row.deleted_at === null
            ? `/api/admin/frame-files/${row.file_path
                .split("/")
                .map(encodeURIComponent)
                .join("/")}`
            : null,
      })),
    });
  },
);

app.post(
  "/api/admin/participants",
  requireAdmin,
  async (req: AuthenticatedRequest, res) => {
    const { username, password } = req.body as {
      username?: unknown;
      password?: unknown;
    };
    if (typeof username !== "string" || typeof password !== "string") {
      res.status(400).json({ error: "participant ID and password are required" });
      return;
    }
    const participant = username.trim();
    if (!participant || sanitize(participant) !== participant) {
      res.status(400).json({
        error: "participant ID may only contain letters, digits, '-' and '_'",
      });
      return;
    }
    if (password.length < 8) {
      res.status(400).json({ error: "the temporary password needs at least 8 characters" });
      return;
    }
    if (getUser(participant)) {
      res.status(409).json({ error: "an account with this ID already exists" });
      return;
    }
    let authUserInserted = false;
    try {
      insertUser(participant, await hashPassword(password));
      authUserInserted = true;
      ensureParticipant(participant);
    } catch (error) {
      if (authUserInserted) deleteParticipantUser(participant);
      else if (getUser(participant)) {
        res.status(409).json({ error: "an account with this ID already exists" });
        return;
      }
      console.error(`Admin participant creation failed for ${participant}:`, error);
      res.status(500).json({ error: "the participant could not be created" });
      return;
    }
    console.log(`Participant created by ${req.participant}: ${participant}`);
    res.status(201).json({
      ok: true,
      username: participant,
      mustChangePassword: true,
    });
  },
);

// Cookie auth exists only for this read-only image route because <img> cannot
// attach the admin bearer header. The database lookup still enforces that the
// normalized path is a live, face-anonymized frame.
app.get(
  "/api/admin/frame-files/*",
  requireAdminWithCookieFallback,
  (req: AuthenticatedRequest, res) => {
    const relativePath = decodeURIComponent(
      req.path.slice("/api/admin/frame-files/".length),
    );
    const normalized = path.normalize(relativePath);
    if (
      normalized.startsWith("..") ||
      path.isAbsolute(normalized) ||
      normalized === "."
    ) {
      res.status(403).json({ error: "forbidden" });
      return;
    }
    const availability = getAdminFrameAvailabilityByPath(normalized);
    if (
      availability?.face_status !== "done" ||
      availability.deleted_at !== null
    ) {
      res.status(404).json({ error: "frame not available" });
      return;
    }
    res.sendFile(normalized, { root: RECORDINGS_DIR }, (error) => {
      if (error && !res.headersSent) {
        res.status(404).json({ error: "not found" });
      }
    });
  },
);

app.get("/api/onboarding", requireAuth, (req: AuthenticatedRequest, res) => {
  const user = getUser(req.participant!);
  if (!user) {
    res.status(404).json({ error: "user not found" });
    return;
  }
  res.json(onboardingJson(user));
});

// First-run-only password change. Possession of the freshly issued bearer
// token proves the participant just authenticated with the lab-provided
// password, so asking for it a second time adds no value. Once this mandatory
// change is complete, this endpoint closes and normal password changes still
// require the current password below.
app.post(
  "/api/onboarding/password",
  requireAuth,
  async (req: AuthenticatedRequest, res) => {
    const participant = req.participant!;
    const { newPassword } = req.body as { newPassword?: unknown };
    if (typeof newPassword !== "string") {
      res.status(400).json({ error: "newPassword is required" });
      return;
    }
    if (newPassword.length < 8) {
      res
        .status(400)
        .json({ error: "the new password needs at least 8 characters" });
      return;
    }
    const user = getUser(participant);
    if (!user) {
      res.status(404).json({ error: "user not found" });
      return;
    }
    if (user.must_change_password !== 1) {
      res
        .status(409)
        .json({ error: "the initial password was already changed" });
      return;
    }
    if (await verifyPassword(user.password_hash, newPassword)) {
      res
        .status(400)
        .json({
          error: "choose a password different from the initial password",
        });
      return;
    }
    markPasswordChanged(participant, await hashPassword(newPassword));
    const updatedUser = getUser(participant)!;
    console.log(`Initial password changed: ${participant}`);
    res.json({ ok: true, ...onboardingJson(updatedUser) });
  },
);

app.post(
  "/api/onboarding/complete",
  requireAuth,
  (req: AuthenticatedRequest, res) => {
    const participant = req.participant!;
    const completedAt = completeOnboarding(participant);
    if (completedAt === undefined) {
      res.status(409).json({ error: "change the initial password first" });
      return;
    }
    const user = getUser(participant)!;
    console.log(`Onboarding completed: ${participant}`);
    res.json({ ok: true, ...onboardingJson(user) });
  },
);

app.get("/api/study/status", requireAuth, (req: AuthenticatedRequest, res) => {
  res.json(studyStatusJson(req.participant!));
});

app.post(
  "/api/study/complete",
  requireAuth,
  requireCompletedOnboarding,
  (req: AuthenticatedRequest, res) => {
    const participant = req.participant!;
    if (getRoundResponseList(participant, 2)?.status !== "submitted") {
      res.status(409).json({
        error: "submit both reconstruction steps before completing the study",
      });
      return;
    }
    const wasAlreadyComplete = isStudyComplete(participant);
    if (completeStudy(participant) === undefined) {
      res.status(404).json({ error: "user not found" });
      return;
    }
    if (!wasAlreadyComplete) {
      console.log(`Study completed: ${participant}`);
    }
    res.json({ ok: true, ...studyStatusJson(participant) });
  },
);

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
    markPasswordChanged(participant, await hashPassword(newPassword));
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
  requireCompletedOnboarding,
  requirePhotoAccess,
  (req: AuthenticatedRequest, res) => {
    const device = sanitize(req.params.device);
    const session = Number(req.params.session);
    if (!device || !Number.isInteger(session)) {
      res.status(400).json({ error: "invalid device or session" });
      return;
    }
    // Deliberately NO vlm_* fields: the mobile app must never receive VLM
    // output before the fixed-order assisted reconstruction website.
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
  requireCompletedOnboarding,
  requirePhotoAccess,
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
  requireCompletedOnboarding,
  requirePhotoAccess,
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
app.get(
  "/frames/*",
  requireAuthWithCookieFallback,
  requireCompletedOnboarding,
  requirePhotoAccess,
  (req: AuthenticatedRequest, res) => {
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
  },
);

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
  // Upserts only participant-entered profile fields.
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
// the from-memory recall). Round 2 is always assisted: its immutable
// vlm_proposal and editable assisted response are separate lists.
// Reconstructing TODAY only opens at
// AVAILABLE_FROM_HOUR local time (a past study day is always available).

const CATEGORY_LABELS = new Set(["work", "break", "other"]);

const isDayAvailable = (day: string): boolean => {
  const today = todayKey();
  if (day < today) return true;
  if (day > today) return false;
  return currentLocalHour() >= AVAILABLE_FROM_HOUR;
};

// The study day: pinned by round 1's response-list row once that round was
// first opened; before that, the latest frame day. Undefined = no frames yet.
const resolveStudyDay = (participant: string): string | undefined =>
  getRoundResponseList(participant, 1)?.day ?? latestFrameDay(participant);

const toActivityJson = (row: ActivityRow) => ({
  id: row.id,
  position: row.position,
  startMs: row.start_ms,
  endMs: row.end_ms,
  rawLabel: row.raw_label,
  categoryLabel: row.category_label,
  source: row.source,
  proposalActivityId: row.proposal_activity_id,
  workloadRating: row.workload_rating,
  recoveryRating: row.recovery_rating,
  // This flag is an analysis/manipulation detail. It reaches the browser only
  // in explicit developer mode so the study UI cannot reveal affected rows.
  ...(DRM_DEV_MODE
    ? {
        isIncorrectAnnotationInjected:
          row.is_incorrect_annotation_injected === 1,
      }
    : {}),
});

const toPhotoFrameJson = (
  row: ReturnType<typeof listPhotoFramesOnDay>[number],
) => ({
  device: row.device,
  session: row.session,
  frameIndex: row.frame_index,
  captureEpochMs: row.capture_epoch_ms,
  imageUrl: row.deleted_at === null ? `/frames/${row.file_path}` : null,
  deletedAt: row.deleted_at,
});

const parseStoredProbabilities = (
  value: string | null,
  allowedLabels: ReadonlySet<string>,
): Record<string, number> | null => {
  if (value === null) return null;
  try {
    const parsed = JSON.parse(value) as unknown;
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      Array.isArray(parsed)
    ) {
      return null;
    }
    const entries = Object.entries(parsed);
    if (
      entries.length !== allowedLabels.size ||
      entries.some(
        ([label, score]) =>
          !allowedLabels.has(label) ||
          typeof score !== "number" ||
          !Number.isFinite(score) ||
          score < 0 ||
          score > 1,
      )
    ) {
      return null;
    }
    return Object.fromEntries(entries);
  } catch {
    return null;
  }
};

const recordingEndedForFrames = (
  participant: string,
  dayFrames: ReturnType<typeof listFramesOnDay>,
): boolean => {
  const latestEvent = latestRecordingEvent(participant);
  return (
    latestEvent?.event_type === "end" &&
    dayFrames.some((frame) => frame.session === latestEvent.session)
  );
};

// Hard ceiling well above any real day (a 16 h day at 30 s frames segments
// into far fewer activities); bounds participant-controlled writes.
const MAX_ACTIVITIES_PER_ROUND = 300;

// Validates the replace-all activities body shared by draft PUT and submit.
// requireLabels (submit) additionally demands a supported activity enum AND a
// categoryLabel on every activity, plus the category's experience rating
// (work -> workloadRating, break -> recoveryRating; both 7-point Likert).
// Every span must lie within the pinned study day and spans must not overlap,
// preserving one unambiguous ordered reconstruction. On round 1 every
// activity must be user-sourced and carries no VLM provenance (there is no
// VLM proposal the participant could have seen).
const parseActivityInputs = (
  body: unknown,
  day: string,
  requireLabels: boolean,
  round: 1 | 2,
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
      proposalActivityId?: unknown;
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
    // Spans are half-open. A final 23:55-00:00 chunk therefore belongs fully
    // to the pinned day even though its exclusive end is next-day midnight.
    const lastIncludedMs = endMs > startMs ? endMs - 1 : endMs;
    if (
      dayKeyFromEpochMs(startMs) !== day ||
      dayKeyFromEpochMs(lastIncludedMs) !== day
    ) {
      return { error: `activity ${index}: span must lie within ${day}` };
    }
    if (
      rawLabel !== null &&
      rawLabel !== undefined &&
      !ACTIVITY_LABEL_SET.has(rawLabel as string)
    ) {
      return {
        error: `activity ${index}: rawLabel must be a supported activity enum or null`,
      };
    }
    const activityLabel =
      typeof rawLabel === "string" && ACTIVITY_LABEL_SET.has(rawLabel)
        ? rawLabel
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
    if (round === 1 && source !== "user") {
      return { error: `activity ${index}: source must be 'user' on a self round` };
    }
    if (requireLabels && activityLabel === null) {
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
    // Opaque link to the immutable proposal row. The DB verifies that it
    // belongs to this participant/round and derives all hidden VLM and
    // intervention provenance from that row; the client never supplies it.
    const proposalActivityId =
      round === 2 &&
      source === "vlm" &&
      Number.isSafeInteger(entry.proposalActivityId) &&
      (entry.proposalActivityId as number) > 0
        ? (entry.proposalActivityId as number)
        : null;
    activities.push({
      start_ms: startMs,
      end_ms: endMs,
      raw_label: activityLabel,
      category_label: (categoryLabel as string | null | undefined) ?? null,
      source,
      proposal_activity_id: proposalActivityId,
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

const roundTimingJson = (
  responseList:
    | {
        first_opened_at: number | null;
        first_draft_saved_at: number | null;
        last_draft_saved_at: number | null;
        submitted_at: number | null;
      }
    | undefined,
): Record<string, number | null> => ({
  firstOpenedAt: responseList?.first_opened_at ?? null,
  firstDraftSavedAt: responseList?.first_draft_saved_at ?? null,
  lastDraftSavedAt: responseList?.last_draft_saved_at ?? null,
  submittedAt: responseList?.submitted_at ?? null,
});

// The whole evening at a glance: the pinned/derived study day and both
// rounds' status, so the website can render the linear two-step flow without
// client-side workflow branching.
app.get(
  "/api/reconstruction/state",
  requireAuth,
  requireCompletedOnboarding,
  requireActiveStudy,
  (req: AuthenticatedRequest, res) => {
    const participant = req.participant!;
    const round1 = getRoundResponseList(participant, 1);
    const round2 = getRoundResponseList(participant, 2);
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
          status: round1?.status ?? "none",
          locked: false,
          ...roundTimingJson(round1),
        },
        {
          round: 2,
          status: round2?.status ?? "none",
          locked: !round2Unlocked,
          // A stale/dev-created round-2 row must not leak timing metadata
          // through the fixed-order gate.
          ...roundTimingJson(round2Unlocked ? round2 : undefined),
        },
      ],
    });
  },
);

// Full pinned-day photo audit for the navbar's Manage Photos dialog. Access
// starts only after Self DRM is submitted so photos cannot contaminate the
// from-memory round. Soft-deleted rows remain as timestamped tombstones, but
// their cleared file paths are never returned.
app.get(
  "/api/photos",
  requireAuth,
  requireCompletedOnboarding,
  requirePhotoAccess,
  (req: AuthenticatedRequest, res) => {
    const participant = req.participant!;
    const round1 = getRoundResponseList(participant, 1)!;
    res.json({
      day: round1.day,
      frames: listPhotoFramesOnDay(participant, round1.day).map((frame) =>
        toPhotoFrameJson(frame),
      ),
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
): { round: 1 | 2; day: string } | undefined => {
  const round = Number(req.params.round);
  if (round !== 1 && round !== 2) {
    res.status(400).json({ error: "round must be 1 or 2" });
    return undefined;
  }
  const participant = req.participant!;
  const existing = getRoundResponseList(participant, round);
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
    getRoundResponseList(participant, 1)?.status !== "submitted"
  ) {
    res.status(403).json({ error: "step 1 must be submitted first" });
    return undefined;
  }
  if (forWrite && existing?.status === "submitted") {
    res.status(409).json({ error: "this step is already submitted" });
    return undefined;
  }
  return { round, day };
};

app.get(
  "/api/reconstruction/round/:round",
  requireAuth,
  requireCompletedOnboarding,
  requireActiveStudy,
  (req: AuthenticatedRequest, res) => {
    const guard = guardRound(req, res, false);
    if (!guard) return;
    const participant = req.participant!;
    const { round, day } = guard;

    // Pin the response-list role + study day on first open (INSERT OR IGNORE)
    // so later frames or frame deletion cannot shift the seen round.
    pinRoundResponseList(participant, round, day);

    let responseList = getRoundResponseList(participant, round);
    let activities = listActivities(participant, round);
    let proposalPayload: Record<string, unknown> | undefined;

    const payload: Record<string, unknown> = {
      round,
      day,
      status: responseList?.status ?? "none",
    };

    // Frames and VLM output go ONLY to round 2. Round 1 is from memory, so
    // exposing either there would contaminate the fixed-order design.
    if (round === 2) {
      const dayFrames = listFramesOnDay(participant, day);
      const dayChunks = listChunksOnDay(participant, day);
      const recordingEnded =
        DRM_DEV_MODE || recordingEndedForFrames(participant, dayFrames);
      // Pending = frames whose 5-minute chunk is not terminal yet (filling /
      // ready / processing). Legacy frames without a chunk are frozen, and
      // face_status='failed' frames can never feed a chunk's VLM input — do
      // not let either hold the round in "still processing" forever.
      const pendingFrameCount = dayFrames.filter(
        (f) =>
          f.chunk_status !== null &&
          f.chunk_status !== "done" &&
          f.chunk_status !== "failed" &&
          f.face_status !== "failed",
      ).length;
      const nonTerminalChunkCount = dayChunks.filter(
        (chunk) => chunk.status !== "done" && chunk.status !== "failed",
      ).length;
      const vlmPendingCount = Math.max(
        pendingFrameCount,
        nonTerminalChunkCount,
      );

      // The assisted round bootstraps from two distinct lists:
      //   1. an immutable original VLM proposal, generated exactly once after
      //      the chunk pass completes;
      //   2. the editable assisted list used by the existing web API.
      // Draft saves replace only (2). If the participant empties that draft,
      // reload restores it from (1) without re-running segmentation.
      let proposalList = getActivityList(
        participant,
        round,
        "vlm_proposal",
      );
      if (
        proposalList === undefined &&
        recordingEnded &&
        vlmPendingCount === 0 &&
        dayChunks.length > 0
      ) {
        // Segmentation runs on the day's clock-aligned 5-minute CHUNKS.
        // Consecutive windows merge only when both their closed activity enum
        // and category match. Failed/unlabelled chunks each stay as a blank
        // proposal row so the participant can classify them; chunks with no
        // servable frame still appear, without exposing the failed image.
        const segments = segmentDay(
          dayChunks.map((chunk) => {
            const hasValidResult =
              chunk.status === "done" &&
              chunk.vlm_label !== null &&
              ACTIVITY_LABEL_SET.has(chunk.vlm_label) &&
              chunk.vlm_category !== null &&
              CATEGORY_LABELS.has(chunk.vlm_category);
            return {
              chunkStartMs: chunk.chunk_start_ms,
              chunkEndMs: chunk.chunk_end_ms,
              vlmLabel: hasValidResult ? chunk.vlm_label : null,
              vlmCategory: hasValidResult ? chunk.vlm_category : null,
              vlmActivityConfidence: hasValidResult
                ? chunk.vlm_activity_confidence
                : null,
              vlmActivityConfidences: hasValidResult
                ? parseStoredProbabilities(
                    chunk.vlm_activity_confidences_json,
                    ACTIVITY_LABEL_SET,
                  )
                : null,
              vlmCategoryConfidence: hasValidResult
                ? chunk.vlm_category_confidence
                : null,
              vlmCategoryConfidences: hasValidResult
                ? parseStoredProbabilities(
                    chunk.vlm_category_confidences_json,
                    CATEGORY_LABELS,
                  )
                : null,
            };
          }),
        );
        const preparedActivities = injectIncorrectAnnotations(segments);
        const proposalActivities = preparedActivities.map((segment) => ({
          start_ms: segment.startMs,
          end_ms: segment.endMs,
          raw_label: segment.rawLabel,
          category_label: segment.categoryLabel,
          source: "vlm" as const,
          vlm_mean_activity_confidence:
            segment.vlmMeanActivityConfidence,
          vlm_mean_activity_confidences_json:
            segment.vlmMeanActivityConfidences === null
              ? null
              : JSON.stringify(segment.vlmMeanActivityConfidences),
          vlm_mean_category_confidence:
            segment.vlmMeanCategoryConfidence,
          vlm_mean_category_confidences_json:
            segment.vlmMeanCategoryConfidences === null
              ? null
              : JSON.stringify(segment.vlmMeanCategoryConfidences),
          presented_raw_label: segment.presentedRawLabel,
          presented_category_label: segment.presentedCategoryLabel,
          is_incorrect_annotation_injected:
            segment.isIncorrectAnnotationInjected,
        }));
        const created = createVlmProposal({
          participant,
          round,
          day,
          activities: proposalActivities,
        });
        proposalList = getActivityList(participant, round, "vlm_proposal");
        if (created) {
          console.log(
            `Generated immutable VLM proposal: ${participant}/round ${round} (${proposalActivities.length} activities)`,
          );
        }
      }

      if (
        responseList?.status !== "submitted" &&
        activities.length === 0 &&
        proposalList !== undefined
      ) {
        const proposalActivities = listActivitiesByKind(
          participant,
          round,
          "vlm_proposal",
        );
        replaceActivities({
          participant,
          round,
          day,
          submit: false,
          activities: proposalActivities.map((activity) => ({
            start_ms: activity.start_ms,
            end_ms: activity.end_ms,
            raw_label:
              activity.presented_raw_label ?? activity.raw_label,
            category_label:
              activity.presented_category_label ?? activity.category_label,
            source: "vlm",
            proposal_activity_id: activity.id,
          })),
        });
        responseList = getRoundResponseList(participant, round);
        activities = listActivities(participant, round);
      }

      if (
        round === 2 &&
        vlmPendingCount === 0 &&
        proposalList !== undefined
      ) {
        proposalPayload = {
          id: proposalList.id,
          kind: proposalList.kind,
          immutable: proposalList.immutable === 1,
          proposalViewedAt: proposalList.proposal_viewed_at,
        };
        payload.vlmProposal = proposalPayload;
      }

      payload.status = responseList?.status ?? "none";
      payload.vlmPendingCount = vlmPendingCount;
      payload.recordingEnded =
        recordingEnded || proposalList !== undefined;
      payload.frames = listPhotoFramesOnDay(participant, day).map(
        toPhotoFrameJson,
      );
    }

    payload.activities = activities.map(toActivityJson);

    // These markers are written only after the successful response payload is
    // fully assembled. A pending assisted response counts as a round open, but
    // not as proposal exposure because it does not contain vlmProposal.
    if (proposalPayload !== undefined) {
      const proposalList = getActivityList(
        participant,
        round,
        "vlm_proposal",
      );
      if (proposalList === undefined) {
        throw new Error("VLM proposal disappeared before response");
      }
      proposalPayload.proposalViewedAt = markVlmProposalViewed(proposalList.id);
    }
    markRoundResponseOpened(participant, round);
    responseList = getRoundResponseList(participant, round);
    Object.assign(payload, roundTimingJson(responseList));
    res.json(payload);
  },
);

// Replace-all draft save.
app.put(
  "/api/reconstruction/round/:round",
  requireAuth,
  requireCompletedOnboarding,
  requireActiveStudy,
  (req: AuthenticatedRequest, res) => {
    const guard = guardRound(req, res, true);
    if (!guard) return;
    const { activities, error } = parseActivityInputs(
      req.body,
      guard.day,
      false,
      guard.round,
    );
    if (!activities) {
      res.status(400).json({ error: error! });
      return;
    }
    replaceActivities({
      participant: req.participant!,
      round: guard.round,
      day: guard.day,
      activities,
      submit: false,
      recordDraftSave: true,
    });
    const responseList = getRoundResponseList(
      req.participant!,
      guard.round,
    );
    res.json({ ok: true, ...roundTimingJson(responseList) });
  },
);

// Atomic save + lock. Original VLM and final participant labels remain in
// their separately identified lists. Submitting round 1 unlocks round 2.
app.post(
  "/api/reconstruction/round/:round/submit",
  requireAuth,
  requireCompletedOnboarding,
  requireActiveStudy,
  (req: AuthenticatedRequest, res) => {
    const guard = guardRound(req, res, true);
    if (!guard) return;
    const { activities, error } = parseActivityInputs(
      req.body,
      guard.day,
      true,
      guard.round,
    );
    if (!activities) {
      res.status(400).json({ error: error! });
      return;
    }
    const { submittedAt } = replaceActivities({
      participant: req.participant!,
      round: guard.round,
      day: guard.day,
      activities,
      submit: true,
    });
    console.log(
      `Reconstruction round ${guard.round} submitted: ${req.participant}/${guard.day} (${activities.length} activities)`,
    );
    const responseList = getRoundResponseList(
      req.participant!,
      guard.round,
    );
    res.json({
      ok: true,
      submittedAt,
      ...roundTimingJson(responseList),
    });
  },
);

// --- Recording lifecycle events + pause gate --------------------------------

interface RecordingEventPayload {
  eventId?: unknown;
  session?: unknown;
  clientEpochMs?: unknown;
  sequenceNumber?: unknown;
}

function parseRecordingEvent(
  body: unknown,
  eventType: RecordingEventType,
): { event?: RecordingEventInput; error?: string } {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return { error: "recording event body is required" };
  }
  const payload = body as RecordingEventPayload;
  if (
    typeof payload.eventId !== "string" ||
    payload.eventId.length < 1 ||
    payload.eventId.length > 96 ||
    !/^[a-zA-Z0-9._:-]+$/.test(payload.eventId)
  ) {
    return { error: "eventId must be 1-96 safe identifier characters" };
  }
  if (
    !Number.isSafeInteger(payload.session) ||
    (payload.session as number) <= 0
  ) {
    return { error: "session must be a positive integer" };
  }
  if (
    !Number.isSafeInteger(payload.clientEpochMs) ||
    (payload.clientEpochMs as number) <= 0
  ) {
    return { error: "clientEpochMs must be a positive integer" };
  }
  if (
    !Number.isSafeInteger(payload.sequenceNumber) ||
    (payload.sequenceNumber as number) < 0
  ) {
    return { error: "sequenceNumber must be a non-negative integer" };
  }
  return {
    event: {
      event_id: payload.eventId,
      session: payload.session as number,
      event_type: eventType,
      client_epoch_ms: payload.clientEpochMs as number,
      sequence_number: payload.sequenceNumber as number,
    },
  };
}

function syncPauseGate(participant: string): {
  paused: boolean;
  latestEventId: string | null;
} {
  const latest = latestRecordingEvent(participant);
  const paused = latest?.event_type === "pause";
  if (paused) {
    pausedParticipants.add(participant);
  } else {
    pausedParticipants.delete(participant);
  }
  return { paused, latestEventId: latest?.event_id ?? null };
}

function handleRecordingEvent(
  req: AuthenticatedRequest,
  res: Response,
  eventType: RecordingEventType,
): void {
  const { event, error } = parseRecordingEvent(req.body, eventType);
  if (!event) {
    res.status(400).json({ error });
    return;
  }

  const participant = req.participant!;
  try {
    const stored = recordRecordingEvent(participant, event);
    const { paused, latestEventId } = syncPauseGate(participant);
    const isLatestEvent = latestEventId === stored.event_id;
    const closedChunks =
      eventType === "end" && isLatestEvent
        ? closeFillingChunksForSession(participant, stored.session)
        : 0;

    console.log(
      `Recording ${eventType}: ${participant}/${stored.session} #${stored.sequence_number}`,
    );
    res.json({
      ok: true,
      eventId: stored.event_id,
      serverReceivedEpochMs: stored.server_received_epoch_ms,
      paused,
      ...(eventType === "end" ? { closedChunks } : {}),
    });
  } catch (eventError) {
    if (eventError instanceof RecordingEventConflictError) {
      res.status(409).json({ error: eventError.message });
      return;
    }
    throw eventError;
  }
}

app.post(
  "/api/recording/started",
  requireAuth,
  (req: AuthenticatedRequest, res) =>
    handleRecordingEvent(req, res, "start"),
);
app.post("/api/pause", requireAuth, (req: AuthenticatedRequest, res) =>
  handleRecordingEvent(req, res, "pause"),
);
app.post("/api/resume", requireAuth, (req: AuthenticatedRequest, res) =>
  handleRecordingEvent(req, res, "resume"),
);
app.post(
  "/api/recording/ended",
  requireAuth,
  (req: AuthenticatedRequest, res) =>
    handleRecordingEvent(req, res, "end"),
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

server.listen(PORT, HOST, () => {
  console.log(`BLINKS server listening on http://${HOST}:${PORT}`);
  console.log(`Health:  http://localhost:${PORT}/health`);
  console.log(`Ingest:  ws://localhost:${PORT}/ingest (bearer token required)`);
  console.log(`Recordings directory: ${RECORDINGS_DIR}`);
});
