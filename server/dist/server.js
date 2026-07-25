"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = __importDefault(require("express"));
const http_1 = __importDefault(require("http"));
const ws_1 = require("ws");
const fs_1 = __importDefault(require("fs"));
const path_1 = __importDefault(require("path"));
const url_1 = require("url");
const auth_1 = require("./auth");
const auth_db_1 = require("./auth-db");
const db_1 = require("./db");
const segmentation_1 = require("./segmentation");
const push_1 = require("./push");
const time_1 = require("./time");
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
const RECORDINGS_DIR = process.env.RECORDINGS_DIR ?? path_1.default.join(__dirname, "..", "recordings");
const DATA_DIR = process.env.DATA_DIR ?? path_1.default.join(__dirname, "..", "data");
const PAUSED_PATH = path_1.default.join(RECORDINGS_DIR, "paused.json");
const MAX_BATCH_DELETE_FRAMES = 500;
// DRM: where the reconstruction website lives (linked from the app + pushes),
// and the local hour from which TODAY's reconstruction opens (past days are
// always available; the gate is enforced server-side).
const WEB_URL = process.env.WEB_URL ?? "http://blinks.win.kit.edu";
const AVAILABLE_FROM_HOUR = Number(process.env.DRM_AVAILABLE_FROM_HOUR ?? 19);
const DRM_DEV_MODE = process.env.DRM_DEV_MODE === "1";
function ensureDir(dir) {
    if (!fs_1.default.existsSync(dir)) {
        fs_1.default.mkdirSync(dir, { recursive: true });
    }
}
// Strip anything that is not a safe identifier character, preventing a
// malformed segment from escaping the recordings directory.
function sanitize(value) {
    return value.replace(/[^a-zA-Z0-9_-]/g, "");
}
function looksLikeJpeg(buffer) {
    if (buffer.length < 4)
        return false;
    const soi = buffer[0] === 0xff && buffer[1] === 0xd8;
    const eoi = buffer[buffer.length - 2] === 0xff && buffer[buffer.length - 1] === 0xd9;
    return soi && eoi;
}
ensureDir(RECORDINGS_DIR);
ensureDir(DATA_DIR);
if (DRM_DEV_MODE) {
    console.warn("DRM DEV MODE ENABLED: evening availability and round-order gates are bypassed");
}
// Frame metadata lives next to the JPEGs (rsynced together for analysis);
// credentials live in their own DB outside the recordings tree (see auth-db).
(0, db_1.initDb)(path_1.default.join(RECORDINGS_DIR, "recordings.db"));
(0, auth_db_1.initAuthDb)(process.env.AUTH_DB_PATH ?? path_1.default.join(DATA_DIR, "auth.db"));
// --- Pause state (participant -> paused) -----------------------------------
// The app pauses the camera directly over BLE; this server-side state is the
// defense-in-depth gate that drops any frame still in flight (or raced around
// the BLE control write) so a paused participant's images never reach disk.
let pausedParticipants = new Set();
function loadPaused() {
    try {
        if (fs_1.default.existsSync(PAUSED_PATH)) {
            const arr = JSON.parse(fs_1.default.readFileSync(PAUSED_PATH, "utf8"));
            pausedParticipants = new Set(arr);
        }
    }
    catch (err) {
        console.error("Failed to load paused.json:", err);
    }
}
function persistPaused() {
    try {
        fs_1.default.writeFileSync(PAUSED_PATH, JSON.stringify(Array.from(pausedParticipants), null, 2));
    }
    catch (err) {
        console.error("Failed to persist paused.json:", err);
    }
}
loadPaused();
const app = (0, express_1.default)();
app.use(express_1.default.json());
app.get("/health", (_req, res) => {
    res.json({ status: "ok", time: new Date().toISOString() });
});
// --- Auth -------------------------------------------------------------------
app.post("/api/login", async (req, res) => {
    const { username, password } = req.body;
    if (typeof username !== "string" || typeof password !== "string") {
        res.status(400).json({ error: "username and password are required" });
        return;
    }
    const cleanUsername = sanitize(username);
    const passwordOk = await (0, auth_1.verifyUserPassword)(cleanUsername, password);
    if (!cleanUsername || !passwordOk) {
        res.status(401).json({ error: "wrong username or password" });
        return;
    }
    const token = (0, auth_1.issueToken)(cleanUsername);
    console.log(`Login: ${cleanUsername}`);
    res.json({ token, username: cleanUsername });
});
app.post("/api/change-password", auth_1.requireAuth, async (req, res) => {
    const participant = req.participant;
    const { currentPassword, newPassword } = req.body;
    if (typeof currentPassword !== "string" ||
        typeof newPassword !== "string") {
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
    const user = (0, auth_db_1.getUser)(participant);
    if (!user || !(await (0, auth_1.verifyPassword)(user.password_hash, currentPassword))) {
        res.status(403).json({ error: "current password is incorrect" });
        return;
    }
    (0, auth_db_1.updatePasswordHash)(participant, await (0, auth_1.hashPassword)(newPassword));
    console.log(`Password changed: ${participant}`);
    res.json({ ok: true });
});
// --- Participant read/edit API (each participant sees only their own data) --
app.get("/api/sessions", auth_1.requireAuth, (req, res) => {
    const sessions = (0, db_1.listSessions)(req.participant).map((row) => ({
        device: row.device,
        session: row.session,
        startedAtMs: row.started_at_ms,
        endedAtMs: row.ended_at_ms,
        frameCount: row.frame_count,
        deletedFrameCount: row.deleted_frame_count,
    }));
    res.json({ sessions });
});
app.get("/api/sessions/:device/:session/frames", auth_1.requireAuth, (req, res) => {
    const device = sanitize(req.params.device);
    const session = Number(req.params.session);
    if (!device || !Number.isInteger(session)) {
        res.status(400).json({ error: "invalid device or session" });
        return;
    }
    // Deliberately NO vlm_* fields: the mobile app must never receive VLM
    // output before the fixed-order assisted reconstruction website.
    const frames = (0, db_1.listFrames)(req.participant, device, session).map((row) => ({
        frameIndex: row.frame_index,
        captureEpochMs: row.capture_epoch_ms,
        imageUrl: `/frames/${row.file_path}`,
    }));
    res.json({ frames });
});
// Deletes files synchronously before marking their rows. Node's request
// handler cannot interleave another request between these synchronous steps,
// and failed unlinks leave the row active so a retry can try again. ENOENT is
// accepted: the file is already gone, and the retained row can still be
// safely soft-deleted.
const deleteFrames = (participant, device, session, frameIndexes) => {
    const targets = frameIndexes.map((frameIndex) => ({
        frameIndex,
        target: (0, db_1.getFrameDeletionTarget)(participant, device, session, frameIndex),
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
    const failedFrameIndexes = [];
    const recordingsRoot = path_1.default.resolve(RECORDINGS_DIR);
    for (const { frameIndex, target } of targets) {
        if (target.deletedAt !== null) {
            alreadyDeletedCount += 1;
            continue;
        }
        try {
            const absolutePath = path_1.default.resolve(RECORDINGS_DIR, target.filePath);
            if (absolutePath !== recordingsRoot &&
                !absolutePath.startsWith(`${recordingsRoot}${path_1.default.sep}`)) {
                throw new Error("frame path escaped recordings directory");
            }
            try {
                fs_1.default.unlinkSync(absolutePath);
            }
            catch (error) {
                if (error.code !== "ENOENT")
                    throw error;
            }
            if ((0, db_1.softDeleteFrameRow)(participant, device, session, frameIndex)) {
                deletedCount += 1;
                console.log(`Deleted frame file and retained row: ${participant}/${device}/${session}/#${frameIndex}`);
            }
            else {
                alreadyDeletedCount += 1;
            }
        }
        catch (error) {
            failedFrameIndexes.push(frameIndex);
            console.error(`Failed to delete frame ${participant}/${device}/${session}/#${frameIndex}:`, error);
        }
    }
    const body = {
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
app.delete("/api/sessions/:device/:session/frames/:frameIndex", auth_1.requireAuth, (req, res) => {
    const device = sanitize(req.params.device);
    const session = Number(req.params.session);
    const frameIndex = Number(req.params.frameIndex);
    if (!device ||
        !Number.isInteger(session) ||
        !Number.isSafeInteger(frameIndex) ||
        frameIndex < 1) {
        res.status(400).json({ error: "invalid device, session, or frameIndex" });
        return;
    }
    const result = deleteFrames(req.participant, device, session, [frameIndex]);
    res.status(result.status).json(result.body);
});
// Bounded, participant-scoped batch deletion. Duplicates are collapsed and a
// repeated request succeeds without changing counts or chunk bookkeeping.
app.delete("/api/sessions/:device/:session/frames", auth_1.requireAuth, (req, res) => {
    const device = sanitize(req.params.device);
    const session = Number(req.params.session);
    const rawFrameIndexes = req.body?.frameIndexes;
    if (!device ||
        !Number.isInteger(session) ||
        !Array.isArray(rawFrameIndexes) ||
        rawFrameIndexes.length < 1 ||
        rawFrameIndexes.length > MAX_BATCH_DELETE_FRAMES ||
        !rawFrameIndexes.every((value) => Number.isSafeInteger(value) && value >= 1)) {
        res.status(400).json({
            error: `frameIndexes must contain 1-${MAX_BATCH_DELETE_FRAMES} positive integers`,
        });
        return;
    }
    const frameIndexes = [...new Set(rawFrameIndexes)];
    const result = deleteFrames(req.participant, device, session, frameIndexes);
    res.status(result.status).json(result.body);
});
// Serves the JPEG bytes. Not express.static: every request must prove the
// requested path belongs to the authenticated participant (these are images
// of people and their homes). Cookie fallback (blinks_token) is for the DRM
// website's <img> tags only; all JSON APIs remain header-authenticated.
app.get("/frames/*", auth_1.requireAuthWithCookieFallback, (req, res) => {
    const relativePath = decodeURIComponent(req.path.slice("/frames/".length));
    const normalized = path_1.default.normalize(relativePath);
    if (normalized.startsWith("..") ||
        path_1.default.isAbsolute(normalized) ||
        !normalized.startsWith(`${req.participant}${path_1.default.sep}`)) {
        res.status(403).json({ error: "forbidden" });
        return;
    }
    // Serving gate: never hand back a frame whose face has not been blurred yet.
    // Anonymization happens in place shortly after ingestion (face-blur worker);
    // until face_status='done' the image is withheld, even from its owner.
    if ((0, db_1.getFrameStatusByPath)(req.participant, normalized) !== "done") {
        res.status(404).json({ error: "frame not available yet" });
        return;
    }
    res.sendFile(normalized, { root: RECORDINGS_DIR }, (err) => {
        if (err && !res.headersSent)
            res.status(404).json({ error: "not found" });
    });
});
// On-demand CSV export from the DB, for the authenticated participant's own
// sessions (analysis on the VM reads the SQLite file directly instead).
app.get("/api/export.csv", auth_1.requireAuth, (req, res) => {
    const participant = req.participant;
    const device = sanitize(String(req.query.device ?? ""));
    const session = Number(req.query.session);
    if (!device || !Number.isFinite(session)) {
        res
            .status(400)
            .json({ error: "query params 'device' and 'session' are required" });
        return;
    }
    const csv = (0, db_1.exportFramesCsv)({ participant, device, session });
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="${participant}-${device}-${session}-frames.csv"`);
    res.send(csv);
});
// --- DRM: profile + push registration ----------------------------------------
app.get("/api/profile", auth_1.requireAuth, (req, res) => {
    const participant = (0, db_1.getParticipant)(req.participant);
    res.json({
        username: req.participant,
        occupation: participant?.occupation ?? null,
        workDescription: participant?.work_description ?? null,
        wakeTime: participant?.wake_time ?? null,
        bedTime: participant?.bed_time ?? null,
        drmWebUrl: WEB_URL,
    });
});
app.put("/api/profile", auth_1.requireAuth, (req, res) => {
    const { occupation, workDescription, wakeTime, bedTime } = req.body;
    if (typeof occupation !== "string" ||
        typeof workDescription !== "string" ||
        typeof wakeTime !== "string" ||
        typeof bedTime !== "string") {
        res.status(400).json({
            error: "occupation, workDescription, wakeTime and bedTime are required",
        });
        return;
    }
    // The bedtime drives the fallback push reminder, so it must parse.
    if ((0, time_1.timeOfDayToMinutes)(wakeTime.trim()) === undefined ||
        (0, time_1.timeOfDayToMinutes)(bedTime.trim()) === undefined) {
        res
            .status(400)
            .json({ error: "wakeTime and bedTime must be HH:MM (24-hour)" });
        return;
    }
    // Upserts only participant-entered profile fields.
    (0, db_1.upsertParticipantProfile)(req.participant, occupation.trim(), workDescription.trim(), wakeTime.trim(), bedTime.trim());
    res.json({ ok: true });
});
app.post("/api/register-push", auth_1.requireAuth, (req, res) => {
    const { expoPushToken } = req.body;
    if (typeof expoPushToken !== "string" || expoPushToken.trim().length === 0) {
        res.status(400).json({ error: "expoPushToken is required" });
        return;
    }
    (0, db_1.setPushToken)(req.participant, expoPushToken.trim());
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
const isDayAvailable = (day) => {
    const today = (0, time_1.todayKey)();
    if (day < today)
        return true;
    if (day > today)
        return false;
    return (0, time_1.currentLocalHour)() >= AVAILABLE_FROM_HOUR;
};
// The study day: pinned by round 1's response-list row once that round was
// first opened; before that, the latest frame day. Undefined = no frames yet.
const resolveStudyDay = (participant) => (0, db_1.getRoundResponseList)(participant, 1)?.day ?? (0, db_1.latestFrameDay)(participant);
const toActivityJson = (row) => ({
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
// overlap — the round-2 submit propagation stamps user_corrected_* onto
// frames by time range, so an out-of-day span could otherwise rewrite frames
// outside the study day. On round 1 every activity must be user-sourced
// and carries no VLM provenance (there is no VLM proposal the participant
// could have seen).
const parseActivityInputs = (body, day, requireLabels, round) => {
    const list = body?.activities;
    if (!Array.isArray(list))
        return { error: "activities array is required" };
    if (list.length > MAX_ACTIVITIES_PER_ROUND) {
        return { error: `too many activities (max ${MAX_ACTIVITIES_PER_ROUND})` };
    }
    const activities = [];
    for (const [index, item] of list.entries()) {
        const entry = item;
        const { startMs, endMs, rawLabel, categoryLabel, source } = entry;
        if (typeof startMs !== "number" ||
            typeof endMs !== "number" ||
            !Number.isFinite(startMs) ||
            !Number.isFinite(endMs) ||
            endMs < startMs) {
            return { error: `activity ${index}: invalid startMs/endMs` };
        }
        if ((0, time_1.dayKeyFromEpochMs)(startMs) !== day ||
            (0, time_1.dayKeyFromEpochMs)(endMs) !== day) {
            return { error: `activity ${index}: span must lie within ${day}` };
        }
        if (rawLabel !== null && rawLabel !== undefined && typeof rawLabel !== "string") {
            return { error: `activity ${index}: rawLabel must be a string or null` };
        }
        const trimmedLabel = typeof rawLabel === "string" && rawLabel.trim().length > 0
            ? rawLabel.trim()
            : null;
        if (categoryLabel !== null &&
            categoryLabel !== undefined &&
            !CATEGORY_LABELS.has(categoryLabel)) {
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
        const parseRating = (value, field) => {
            if (value === null || value === undefined)
                return { rating: null };
            if (!Number.isInteger(value) || value < 1 || value > 7) {
                return { error: `activity ${index}: ${field} must be an integer 1-7 or null` };
            }
            return { rating: value };
        };
        const workload = parseRating(entry.workloadRating, "workloadRating");
        if (workload.error)
            return { error: workload.error };
        const recovery = parseRating(entry.recoveryRating, "recoveryRating");
        if (recovery.error)
            return { error: recovery.error };
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
        const vlmRawLabel = round === 2 &&
            typeof entry.vlmRawLabel === "string" &&
            entry.vlmRawLabel.length > 0
            ? entry.vlmRawLabel
            : null;
        const vlmCategory = round === 2 && CATEGORY_LABELS.has(entry.vlmCategory)
            ? entry.vlmCategory
            : null;
        activities.push({
            start_ms: startMs,
            end_ms: endMs,
            raw_label: trimmedLabel,
            category_label: categoryLabel ?? null,
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
const roundTimingJson = (responseList) => ({
    firstOpenedAt: responseList?.first_opened_at ?? null,
    firstDraftSavedAt: responseList?.first_draft_saved_at ?? null,
    lastDraftSavedAt: responseList?.last_draft_saved_at ?? null,
    submittedAt: responseList?.submitted_at ?? null,
});
// The whole evening at a glance: the pinned/derived study day and both
// rounds' status, so the website can render the linear two-step flow without
// client-side workflow branching.
app.get("/api/reconstruction/state", auth_1.requireAuth, (req, res) => {
    const participant = req.participant;
    const round1 = (0, db_1.getRoundResponseList)(participant, 1);
    const round2 = (0, db_1.getRoundResponseList)(participant, 2);
    const day = resolveStudyDay(participant) ?? null;
    const round1Submitted = round1?.status === "submitted";
    const round2Unlocked = DRM_DEV_MODE || round1Submitted;
    res.json({
        day,
        frameCount: day === null ? 0 : (0, db_1.countFramesOnDay)(participant, day),
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
});
// Shared guard for round reads and writes. Responds and returns undefined
// when the round is malformed, there is no study day yet, the evening gate is
// closed, round 2 is still locked behind round 1 (the fixed-order invariant,
// enforced here and not just in the UI), or — writes only — the round is
// already submitted.
const guardRound = (req, res, forWrite) => {
    const round = Number(req.params.round);
    if (round !== 1 && round !== 2) {
        res.status(400).json({ error: "round must be 1 or 2" });
        return undefined;
    }
    const participant = req.participant;
    const existing = (0, db_1.getRoundResponseList)(participant, round);
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
    if (!DRM_DEV_MODE &&
        round === 2 &&
        (0, db_1.getRoundResponseList)(participant, 1)?.status !== "submitted") {
        res.status(403).json({ error: "step 1 must be submitted first" });
        return undefined;
    }
    if (forWrite && existing?.status === "submitted") {
        res.status(409).json({ error: "this step is already submitted" });
        return undefined;
    }
    return { round, day };
};
app.get("/api/reconstruction/round/:round", auth_1.requireAuth, (req, res) => {
    const guard = guardRound(req, res, false);
    if (!guard)
        return;
    const participant = req.participant;
    const { round, day } = guard;
    // Pin the response-list role + study day on first open (INSERT OR IGNORE)
    // so later frames or frame deletion cannot shift the seen round.
    (0, db_1.pinRoundResponseList)(participant, round, day);
    let responseList = (0, db_1.getRoundResponseList)(participant, round);
    let activities = (0, db_1.listActivities)(participant, round);
    let proposalPayload;
    const payload = {
        round,
        day,
        status: responseList?.status ?? "none",
    };
    // Frames and VLM output go ONLY to round 2. Round 1 is from memory, so
    // exposing either there would contaminate the fixed-order design.
    if (round === 2) {
        const dayFrames = (0, db_1.listFramesOnDay)(participant, day);
        const servedFrames = dayFrames.filter((f) => f.face_status === "done");
        // Pending = frames whose 5-minute chunk is not terminal yet (filling /
        // ready / processing). Legacy frames without a chunk are frozen, and
        // face_status='failed' frames can never feed a chunk's VLM input — do
        // not let either hold the round in "still processing" forever.
        const vlmPendingCount = dayFrames.filter((f) => f.chunk_status !== null &&
            f.chunk_status !== "done" &&
            f.chunk_status !== "failed" &&
            f.face_status !== "failed").length;
        // The assisted round bootstraps from two distinct lists:
        //   1. an immutable original VLM proposal, generated exactly once after
        //      the chunk pass completes;
        //   2. the editable assisted list used by the existing web API.
        // Draft saves replace only (2). If the participant empties that draft,
        // reload restores it from (1) without re-running segmentation.
        let proposalList = (0, db_1.getActivityList)(participant, round, "vlm_proposal");
        if (proposalList === undefined &&
            vlmPendingCount === 0 &&
            servedFrames.length > 0) {
            // Segmentation runs on the day's CHUNKS: consecutive same-label
            // windows group into one activity, with activity bounds at the real
            // first/last frame times inside the grouped windows. Failed or
            // unlabeled chunks come in as null/null (segmentDay merges them into
            // a labeled neighbor); chunks with no servable frame are skipped.
            const dayChunks = (0, db_1.listChunksOnDay)(participant, day);
            const segments = (0, segmentation_1.segmentDay)(dayChunks
                .filter((chunk) => chunk.first_frame_ms !== null && chunk.last_frame_ms !== null)
                .map((chunk) => ({
                firstFrameMs: chunk.first_frame_ms,
                lastFrameMs: chunk.last_frame_ms,
                vlmLabel: chunk.status === "done" ? chunk.vlm_label : null,
                vlmCategory: chunk.status === "done" &&
                    chunk.vlm_category !== null &&
                    CATEGORY_LABELS.has(chunk.vlm_category)
                    ? chunk.vlm_category
                    : null,
            })));
            const proposalActivities = segments.map((segment) => ({
                start_ms: segment.startMs,
                end_ms: segment.endMs,
                raw_label: segment.rawLabel,
                category_label: segment.categoryLabel,
                source: "vlm",
                vlm_raw_label: segment.rawLabel,
                vlm_category: segment.categoryLabel,
            }));
            const created = (0, db_1.createVlmProposal)({
                participant,
                round,
                day,
                activities: proposalActivities,
            });
            proposalList = (0, db_1.getActivityList)(participant, round, "vlm_proposal");
            if (created) {
                console.log(`Generated immutable VLM proposal: ${participant}/round ${round} (${proposalActivities.length} activities)`);
            }
        }
        if (responseList?.status !== "submitted" &&
            activities.length === 0 &&
            proposalList !== undefined) {
            const proposalActivities = (0, db_1.listActivitiesByKind)(participant, round, "vlm_proposal");
            (0, db_1.replaceActivities)({
                participant,
                round,
                day,
                submit: false,
                activities: proposalActivities.map((activity) => ({
                    start_ms: activity.start_ms,
                    end_ms: activity.end_ms,
                    raw_label: activity.raw_label,
                    category_label: activity.category_label,
                    source: "vlm",
                    vlm_raw_label: activity.raw_label,
                    vlm_category: activity.category_label,
                })),
            });
            responseList = (0, db_1.getRoundResponseList)(participant, round);
            activities = (0, db_1.listActivities)(participant, round);
        }
        if (round === 2 &&
            vlmPendingCount === 0 &&
            proposalList !== undefined) {
            proposalPayload = {
                id: proposalList.id,
                kind: proposalList.kind,
                immutable: proposalList.immutable === 1,
                proposalViewedAt: proposalList.proposal_viewed_at,
                activities: (0, db_1.listActivitiesByKind)(participant, round, "vlm_proposal").map(toActivityJson),
            };
            payload.vlmProposal = proposalPayload;
        }
        payload.status = responseList?.status ?? "none";
        payload.vlmPendingCount = vlmPendingCount;
        payload.frames = servedFrames.map((frame) => ({
            captureEpochMs: frame.capture_epoch_ms,
            imageUrl: `/frames/${frame.file_path}`,
            vlmLabel: frame.vlm_label,
            vlmCategory: frame.vlm_category,
        }));
    }
    payload.activities = activities.map(toActivityJson);
    // These markers are written only after the successful response payload is
    // fully assembled. A pending assisted response counts as a round open, but
    // not as proposal exposure because it does not contain vlmProposal.
    if (proposalPayload !== undefined) {
        const proposalList = (0, db_1.getActivityList)(participant, round, "vlm_proposal");
        if (proposalList === undefined) {
            throw new Error("VLM proposal disappeared before response");
        }
        proposalPayload.proposalViewedAt = (0, db_1.markVlmProposalViewed)(proposalList.id);
    }
    (0, db_1.markRoundResponseOpened)(participant, round);
    responseList = (0, db_1.getRoundResponseList)(participant, round);
    Object.assign(payload, roundTimingJson(responseList));
    res.json(payload);
});
// Replace-all draft save.
app.put("/api/reconstruction/round/:round", auth_1.requireAuth, (req, res) => {
    const guard = guardRound(req, res, true);
    if (!guard)
        return;
    const { activities, error } = parseActivityInputs(req.body, guard.day, false, guard.round);
    if (!activities) {
        res.status(400).json({ error: error });
        return;
    }
    (0, db_1.replaceActivities)({
        participant: req.participant,
        round: guard.round,
        day: guard.day,
        activities,
        submit: false,
        recordDraftSave: true,
    });
    const responseList = (0, db_1.getRoundResponseList)(req.participant, guard.round);
    res.json({ ok: true, ...roundTimingJson(responseList) });
});
// Atomic save + lock; the ASSISTED round additionally propagates the labels
// onto every chunk overlapping each activity's span (chunk-level
// label-quality ground truth). Submitting round 1 unlocks round 2.
app.post("/api/reconstruction/round/:round/submit", auth_1.requireAuth, (req, res) => {
    const guard = guardRound(req, res, true);
    if (!guard)
        return;
    const { activities, error } = parseActivityInputs(req.body, guard.day, true, guard.round);
    if (!activities) {
        res.status(400).json({ error: error });
        return;
    }
    const { submittedAt } = (0, db_1.replaceActivities)({
        participant: req.participant,
        round: guard.round,
        day: guard.day,
        activities,
        submit: true,
    });
    console.log(`Reconstruction round ${guard.round} submitted: ${req.participant}/${guard.day} (${activities.length} activities)`);
    const responseList = (0, db_1.getRoundResponseList)(req.participant, guard.round);
    res.json({
        ok: true,
        submittedAt,
        ...roundTimingJson(responseList),
    });
});
// --- Pause / resume (participant from token) --------------------------------
app.post("/api/pause", auth_1.requireAuth, (req, res) => {
    pausedParticipants.add(req.participant);
    persistPaused();
    console.log(`Paused participant ${req.participant}`);
    res.json({ ok: true, paused: true });
});
app.post("/api/resume", auth_1.requireAuth, (req, res) => {
    pausedParticipants.delete(req.participant);
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
app.post("/api/recording/ended", auth_1.requireAuth, (req, res) => {
    const closedChunks = (0, db_1.closeFillingChunks)(req.participant);
    if (closedChunks > 0) {
        console.log(`Recording ended: ${req.participant} — closed ${closedChunks} chunk(s) for VLM`);
    }
    res.json({ ok: true, closedChunks });
});
// --- WebSocket ingestion (the phone is the client) ---------------------------
const server = http_1.default.createServer(app);
const wss = new ws_1.WebSocketServer({ server });
wss.on("connection", (ws, req) => {
    const requestUrl = new url_1.URL(req.url ?? "", `http://${req.headers.host}`);
    if (requestUrl.pathname !== "/ingest") {
        console.error(`Rejected WS connection with path: ${requestUrl.pathname}`);
        ws.close(1008, "unknown path");
        return;
    }
    const participant = (0, auth_1.participantFromAuthHeader)(req.headers.authorization);
    if (!participant) {
        console.error("Rejected WS connection: invalid or missing token");
        ws.close(1008, "unauthorized");
        return;
    }
    const device = sanitize(requestUrl.searchParams.get("device") ?? "");
    const session = Number(requestUrl.searchParams.get("session"));
    if (!device || !Number.isInteger(session) || session <= 0) {
        console.error(`Rejected WS connection for ${participant}: bad device/session params`);
        ws.close(1008, "device and session query params required");
        return;
    }
    const sessionDir = path_1.default.join(RECORDINGS_DIR, participant, device, String(session));
    const imagesDir = path_1.default.join(sessionDir, "images");
    ensureDir(imagesDir);
    // Continue numbering across reconnects within the same declared session.
    let frameNumber = (0, db_1.maxFrameIndex)(participant, device, session);
    let pendingMeta = null;
    console.log(`Phone connected: participant=${participant} device=${device} session=${session} (resuming at frame ${frameNumber})`);
    ws.on("message", (data, isBinary) => {
        if (!isBinary) {
            const text = data.toString();
            if (text === "heartbeat")
                return;
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
            }
            catch {
                // not JSON, fall through to control logging
            }
            console.log(`[${participant}/${device}] control: ${text}`);
            return;
        }
        // Defense in depth: never persist a frame for a paused participant, no
        // matter what the phone or camera did with the pause state.
        if (pausedParticipants.has(participant)) {
            pendingMeta = null;
            console.log(`[${participant}/${device}] dropped frame: participant is paused`);
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
            console.warn(`[${participant}/${device}] frame ${frameNumber} does not look like a complete JPEG (${buffer.length} bytes)`);
        }
        const fileName = `frame-${String(frameNumber).padStart(6, "0")}-${stamp}.jpg`;
        const filePath = path_1.default.join(imagesDir, fileName);
        fs_1.default.writeFile(filePath, buffer, (err) => {
            if (err)
                console.error(`Failed to write ${fileName}:`, err);
        });
        (0, db_1.insertFrame)({
            participant,
            device,
            session,
            frame_index: frameNumber,
            capture_epoch_ms: captureEpochMs ?? receivedEpochMs,
            received_epoch_ms: receivedEpochMs,
            file_path: path_1.default.relative(RECORDINGS_DIR, filePath),
            device_frame: cameraFrame,
            byte_length: buffer.length,
            jpeg_ok: jpegOk ? 1 : 0,
        });
    });
    ws.on("close", () => {
        console.log(`Phone disconnected: ${participant}/${device} session=${session} (at frame ${frameNumber})`);
    });
    ws.on("error", (err) => {
        console.error(`WebSocket error for ${participant}/${device}:`, err);
    });
});
(0, push_1.startPushScheduler)();
// Chunk idle sweep: a session's LAST 5-minute window never sees a later
// frame, so it is closed once no new frame has arrived for CHUNK_IDLE_CLOSE_MS
// (server receipt time — a delayed catch-up upload keeps its chunk open while
// frames are still streaming in). 60 s tick, same cadence as the push loop.
const CHUNK_IDLE_CLOSE_MS = Number(process.env.CHUNK_IDLE_CLOSE_MS ?? 10 * 60 * 1000);
setInterval(() => {
    try {
        const closed = (0, db_1.closeIdleChunks)(CHUNK_IDLE_CLOSE_MS);
        if (closed > 0) {
            console.log(`Chunk idle sweep: closed ${closed} chunk(s) for VLM`);
        }
    }
    catch (err) {
        console.error("Chunk idle sweep failed:", err);
    }
}, 60000);
server.listen(PORT, () => {
    console.log(`BLINKS server listening on http://0.0.0.0:${PORT}`);
    console.log(`Health:  http://localhost:${PORT}/health`);
    console.log(`Ingest:  ws://localhost:${PORT}/ingest (bearer token required)`);
    console.log(`Recordings directory: ${RECORDINGS_DIR}`);
});
