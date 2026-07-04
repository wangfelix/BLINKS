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
  aggregateFrameDays,
  deleteFrameRow,
  exportFramesCsv,
  getFrameFilePath,
  getFrameStatusByPath,
  getParticipant,
  getReconstruction,
  initDb,
  pinReconstructionCondition,
  insertFrame,
  listActivities,
  listFrames,
  listFramesOnDay,
  listSessions,
  maxFrameIndex,
  parseConditionPlan,
  replaceActivities,
  setPushToken,
  upsertParticipantProfile,
} from "./db";
import { segmentDay } from "./segmentation";
import { startPushScheduler } from "./push";
import { currentLocalHour, dayKeyFromEpochMs, todayKey } from "./time";

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

// DRM: where the reconstruction website lives (linked from the app + pushes),
// and the local hour from which TODAY's reconstruction opens (past days are
// always available; the gate is enforced server-side).
const WEB_URL = process.env.WEB_URL ?? "http://blinks.win.kit.edu";
const AVAILABLE_FROM_HOUR = Number(process.env.DRM_AVAILABLE_FROM_HOUR ?? 19);

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

// GDPR-relevant: deletes the JPEG from disk AND the index row.
app.delete(
  "/api/sessions/:device/:session/frames/:frameIndex",
  requireAuth,
  (req: AuthenticatedRequest, res) => {
    const participant = req.participant!;
    const device = sanitize(req.params.device);
    const session = Number(req.params.session);
    const frameIndex = Number(req.params.frameIndex);
    if (!device || !Number.isInteger(session) || !Number.isInteger(frameIndex)) {
      res.status(400).json({ error: "invalid device, session, or frameIndex" });
      return;
    }

    const filePath = getFrameFilePath(participant, device, session, frameIndex);
    if (filePath === undefined) {
      res.status(404).json({ error: "frame not found" });
      return;
    }

    deleteFrameRow(participant, device, session, frameIndex);
    fs.unlink(path.join(RECORDINGS_DIR, filePath), (err) => {
      if (err && err.code !== "ENOENT") {
        console.error(`Failed to delete ${filePath}:`, err);
      }
    });
    console.log(
      `Deleted frame: ${participant}/${device}/${session}/#${frameIndex}`,
    );
    res.json({ ok: true });
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
  const plan = parseConditionPlan(participant?.condition_plan);
  res.json({
    username: req.participant!,
    occupation: participant?.occupation ?? null,
    workDescription: participant?.work_description ?? null,
    studyDurationDays: plan.length,
    drmWebUrl: WEB_URL,
  });
});

app.put("/api/profile", requireAuth, (req: AuthenticatedRequest, res) => {
  const { occupation, workDescription } = req.body as {
    occupation?: unknown;
    workDescription?: unknown;
  };
  if (typeof occupation !== "string" || typeof workDescription !== "string") {
    res
      .status(400)
      .json({ error: "occupation and workDescription are required" });
    return;
  }
  // Upserts only the profile fields; condition_plan is provisioning state and
  // is never clobbered here.
  upsertParticipantProfile(
    req.participant!,
    occupation.trim(),
    workDescription.trim(),
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

// --- DRM: day reconstruction API ---------------------------------------------
//
// A "study day" is a local calendar date (YYYY-MM-DD, study TZ) with >=1
// frame; day number i is its 1-based position among the participant's days
// and maps to a condition via the per-participant plan:
// plan[min(i-1, plan.length-1)]. Reconstructing TODAY only opens at
// AVAILABLE_FROM_HOUR local time (past days are always available) — enforced
// here, not just in the web UI.

const DAY_KEY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const CATEGORY_LABELS = new Set(["work", "break", "other"]);

const isDayAvailable = (day: string): boolean => {
  const today = todayKey();
  if (day < today) return true;
  if (day > today) return false;
  return currentLocalHour() >= AVAILABLE_FROM_HOUR;
};

// A day's condition: a stored reconstruction pins it (stable even if the plan
// is later adjusted); otherwise it derives from the day's position in the
// participant's recorded days. Undefined = the participant has no frames on
// that day and never started a reconstruction for it.
const resolveDayCondition = (
  participant: string,
  day: string,
): string | undefined => {
  const reconstruction = getReconstruction(participant, day);
  if (reconstruction) return reconstruction.condition;
  const dayIndex = aggregateFrameDays(participant).findIndex(
    (aggregate) => aggregate.day === day,
  );
  if (dayIndex === -1) return undefined;
  const plan = parseConditionPlan(getParticipant(participant)?.condition_plan);
  return plan[Math.min(dayIndex, plan.length - 1)];
};

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
});

// Hard ceiling well above any real day (a 16 h day at 30 s frames segments
// into far fewer activities); protects the propagation loop from abuse.
const MAX_ACTIVITIES_PER_DAY = 300;

// Validates the replace-all activities body shared by draft PUT and submit.
// requireLabels (submit) additionally demands a non-empty rawLabel AND a
// categoryLabel on every activity. Every span must lie within the submitted
// local day and spans must not overlap — the submit propagation stamps
// user_corrected_* onto frames by time range, so an out-of-day span could
// otherwise rewrite another (even already-submitted) day's ground truth.
const parseActivityInputs = (
  body: unknown,
  day: string,
  requireLabels: boolean,
): { activities?: ActivityWriteInput[]; error?: string } => {
  const list = (body as { activities?: unknown } | undefined)?.activities;
  if (!Array.isArray(list)) return { error: "activities array is required" };
  if (list.length > MAX_ACTIVITIES_PER_DAY) {
    return { error: `too many activities (max ${MAX_ACTIVITIES_PER_DAY})` };
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
    if (requireLabels && trimmedLabel === null) {
      return { error: `activity ${index}: rawLabel is required to submit` };
    }
    if (requireLabels && (categoryLabel === null || categoryLabel === undefined)) {
      return { error: `activity ${index}: categoryLabel is required to submit` };
    }
    // VLM-proposal provenance, echoed by the web client so it survives span
    // edits (the DB-side exact-span fallback only covers unchanged spans).
    // Client-supplied, but it can only distort the participant's own
    // label-quality bookkeeping; the frame-level vlm_* columns stay VLM-owned.
    const vlmRawLabel =
      typeof entry.vlmRawLabel === "string" && entry.vlmRawLabel.length > 0
        ? entry.vlmRawLabel
        : null;
    const vlmCategory = CATEGORY_LABELS.has(entry.vlmCategory as string)
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

// One entry per study day, newest first, with condition + availability so the
// website can render the day picker without any client-side study logic.
app.get(
  "/api/reconstruction/days",
  requireAuth,
  (req: AuthenticatedRequest, res) => {
    const participant = req.participant!;
    const plan = parseConditionPlan(getParticipant(participant)?.condition_plan);
    const days = aggregateFrameDays(participant)
      .map((aggregate, index) => {
        const reconstruction = getReconstruction(participant, aggregate.day);
        return {
          day: aggregate.day,
          dayNumber: index + 1,
          condition:
            reconstruction?.condition ?? plan[Math.min(index, plan.length - 1)],
          frameCount: aggregate.frameCount,
          vlmPendingCount: aggregate.vlmPendingCount,
          status: reconstruction?.status ?? "none",
          available: isDayAvailable(aggregate.day),
          availableFromHour: AVAILABLE_FROM_HOUR,
        };
      })
      .reverse();
    res.json({ days });
  },
);

app.get(
  "/api/reconstruction/:day",
  requireAuth,
  (req: AuthenticatedRequest, res) => {
    const participant = req.participant!;
    const day = req.params.day;
    if (!DAY_KEY_PATTERN.test(day)) {
      res.status(400).json({ error: "day must be YYYY-MM-DD" });
      return;
    }
    const condition = resolveDayCondition(participant, day);
    if (condition === undefined) {
      res.status(404).json({ error: "no frames recorded on that day" });
      return;
    }
    // The evening gate applies to reads too (404-for-unknown-day first, then
    // 403-for-gated): before AVAILABLE_FROM_HOUR a premature GET would not
    // only show today's assisted frames + VLM labels early, it would also
    // bootstrap (and freeze) the segmentation on a partial day.
    if (!isDayAvailable(day)) {
      res.status(403).json({
        error: `reconstruction for ${day} opens at ${AVAILABLE_FROM_HOUR}:00`,
      });
      return;
    }
    // Pin the condition on first open (INSERT OR IGNORE) so it can never flip
    // afterwards: the unpinned derivation depends on the day's position among
    // the participant's frame days, which frame deletion could renumber.
    pinReconstructionCondition(participant, day, condition);

    let reconstruction = getReconstruction(participant, day);
    let activities = listActivities(participant, day);
    const dayFrames = listFramesOnDay(participant, day);
    const servedFrames = dayFrames.filter((f) => f.face_status === "done");
    // face_status='failed' frames can never become VLM-done — do not let them
    // hold the day in "still processing" forever (mirrors aggregateFrameDays).
    const vlmPendingCount = dayFrames.filter(
      (f) =>
        (f.vlm_status === "pending" || f.vlm_status === "processing") &&
        f.face_status !== "failed",
    ).length;

    // Assisted days bootstrap themselves: once the VLM pass is complete and
    // no activities are stored, the initial segmentation is generated,
    // persisted as a draft, and returned. While labels are still processing
    // the day stays empty (the website shows "labels still processing").
    // Keyed on empty activities + not submitted (NOT on the reconstructions
    // row, which pin-on-open creates eagerly); side effect: an assisted draft
    // deliberately emptied by the participant re-proposes on reload, which is
    // the self-healing behavior we want pre-submit.
    if (
      condition === "assisted" &&
      reconstruction?.status !== "submitted" &&
      activities.length === 0 &&
      vlmPendingCount === 0 &&
      servedFrames.length > 0
    ) {
      const segments = segmentDay(
        servedFrames.map((frame) => ({
          captureEpochMs: frame.capture_epoch_ms,
          vlmLabel: frame.vlm_status === "done" ? frame.vlm_label : null,
          vlmCategory:
            frame.vlm_status === "done" &&
            frame.vlm_category !== null &&
            CATEGORY_LABELS.has(frame.vlm_category)
              ? frame.vlm_category
              : null,
        })),
      );
      replaceActivities({
        participant,
        day,
        condition,
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
      reconstruction = getReconstruction(participant, day);
      activities = listActivities(participant, day);
      console.log(
        `Generated initial segmentation: ${participant}/${day} (${activities.length} activities)`,
      );
    }

    const payload: Record<string, unknown> = {
      day,
      condition,
      status: reconstruction?.status ?? "none",
      activities: activities.map(toActivityJson),
    };
    // Frames (and thus VLM output) go ONLY to assisted days — on control days
    // the participant reconstructs from memory alone, so leaking them here
    // would contaminate the condition (enforced server-side, not just in UI).
    if (condition === "assisted") {
      payload.frames = servedFrames.map((frame) => ({
        captureEpochMs: frame.capture_epoch_ms,
        imageUrl: `/frames/${frame.file_path}`,
        vlmLabel: frame.vlm_label,
        vlmCategory: frame.vlm_category,
      }));
    }
    res.json(payload);
  },
);

// Shared guard for draft saves and submissions; responds and returns
// undefined when the day is malformed, gated, unknown, or already locked.
const guardReconstructionWrite = (
  req: AuthenticatedRequest,
  res: express.Response,
): { day: string; condition: string } | undefined => {
  const day = req.params.day;
  if (!DAY_KEY_PATTERN.test(day)) {
    res.status(400).json({ error: "day must be YYYY-MM-DD" });
    return undefined;
  }
  if (!isDayAvailable(day)) {
    res.status(403).json({
      error: `reconstruction for ${day} opens at ${AVAILABLE_FROM_HOUR}:00`,
    });
    return undefined;
  }
  const condition = resolveDayCondition(req.participant!, day);
  if (condition === undefined) {
    res.status(404).json({ error: "no frames recorded on that day" });
    return undefined;
  }
  if (getReconstruction(req.participant!, day)?.status === "submitted") {
    res.status(409).json({ error: "this day is already submitted" });
    return undefined;
  }
  return { day, condition };
};

// Replace-all draft save.
app.put(
  "/api/reconstruction/:day",
  requireAuth,
  (req: AuthenticatedRequest, res) => {
    const guard = guardReconstructionWrite(req, res);
    if (!guard) return;
    const { activities, error } = parseActivityInputs(req.body, guard.day, false);
    if (!activities) {
      res.status(400).json({ error: error! });
      return;
    }
    replaceActivities({
      participant: req.participant!,
      day: guard.day,
      condition: guard.condition,
      activities,
      submit: false,
    });
    res.json({ ok: true });
  },
);

// Atomic save + lock + propagation of the labels onto the frames in each
// activity's span (the per-frame label-quality ground truth).
app.post(
  "/api/reconstruction/:day/submit",
  requireAuth,
  (req: AuthenticatedRequest, res) => {
    const guard = guardReconstructionWrite(req, res);
    if (!guard) return;
    const { activities, error } = parseActivityInputs(req.body, guard.day, true);
    if (!activities) {
      res.status(400).json({ error: error! });
      return;
    }
    const { submittedAt } = replaceActivities({
      participant: req.participant!,
      day: guard.day,
      condition: guard.condition,
      activities,
      submit: true,
    });
    console.log(
      `Reconstruction submitted: ${req.participant}/${guard.day} (${activities.length} activities)`,
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

server.listen(PORT, () => {
  console.log(`BLINKS server listening on http://0.0.0.0:${PORT}`);
  console.log(`Health:  http://localhost:${PORT}/health`);
  console.log(`Ingest:  ws://localhost:${PORT}/ingest (bearer token required)`);
  console.log(`Recordings directory: ${RECORDINGS_DIR}`);
});
