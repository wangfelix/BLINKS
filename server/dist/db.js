"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.STUDY_ARMS = void 0;
exports.parseArm = parseArm;
exports.initDb = initDb;
exports.pinReconstructionRound = pinReconstructionRound;
exports.listSessions = listSessions;
exports.listFrames = listFrames;
exports.getFrameFilePath = getFrameFilePath;
exports.getFrameStatusByPath = getFrameStatusByPath;
exports.deleteFrameRow = deleteFrameRow;
exports.maxFrameIndex = maxFrameIndex;
exports.insertFrame = insertFrame;
exports.getParticipant = getParticipant;
exports.ensureParticipant = ensureParticipant;
exports.setArm = setArm;
exports.upsertParticipantProfile = upsertParticipantProfile;
exports.setPushToken = setPushToken;
exports.setLastReminderDay = setLastReminderDay;
exports.listPushParticipants = listPushParticipants;
exports.aggregateFrameDays = aggregateFrameDays;
exports.listFramesOnDay = listFramesOnDay;
exports.countFramesOnDay = countFramesOnDay;
exports.latestFrameDay = latestFrameDay;
exports.getReconstruction = getReconstruction;
exports.listActivities = listActivities;
exports.replaceActivities = replaceActivities;
exports.exportFramesCsv = exportFramesCsv;
const better_sqlite3_1 = __importDefault(require("better-sqlite3"));
const time_1 = require("./time");
exports.STUDY_ARMS = ["main", "control"];
// Normalizes a participants.arm value, defaulting to 'main' on anything
// malformed (defensive: the column is provisioned by create-user, but a
// hand-edited DB must not take the API down).
function parseArm(value) {
    return value === "control" ? "control" : "main";
}
let db;
let insertStmt;
let exportStmt;
let listSessionsStmt;
let listFramesStmt;
let getFrameStmt;
let deleteFrameStmt;
let maxFrameIndexStmt;
let frameStatusByPathStmt;
// DRM statements
let getParticipantStmt;
let insertParticipantStmt;
let updateArmStmt;
let updateProfileStmt;
let updatePushTokenStmt;
let updateLastReminderDayStmt;
let listPushParticipantsStmt;
let frameDayStatsStmt;
let framesInRangeStmt;
let getReconstructionStmt;
let insertReconstructionStmt;
let markSubmittedStmt;
let listActivitiesStmt;
let listVlmSpanActivitiesStmt;
let deleteActivitiesStmt;
let insertActivityStmt;
let propagateCorrectionsStmt;
let replaceActivitiesTx;
// Adds a column to the frames table only if it is missing, so an existing
// recordings.db (written before the column was introduced) is upgraded in
// place without losing rows. Must be called after the table exists.
function migrateAddColumn(column, ddl) {
    const cols = db.prepare(`PRAGMA table_info(frames)`).all();
    if (!cols.some((c) => c.name === column)) {
        db.exec(`ALTER TABLE frames ADD COLUMN ${ddl}`);
    }
}
function initDb(dbPath) {
    db = new better_sqlite3_1.default(dbPath);
    // WAL lets the VLM reader run alongside the ingestion writer; NORMAL is the
    // standard fast/consistent pairing (a power loss can drop only the last
    // transaction, whose JPEG is likely lost too).
    db.pragma("journal_mode = WAL");
    db.pragma("synchronous = NORMAL");
    db.exec(`
    CREATE TABLE IF NOT EXISTS frames (
      participant       TEXT    NOT NULL,
      device            TEXT    NOT NULL,
      session           INTEGER NOT NULL,
      frame_index       INTEGER NOT NULL,
      capture_epoch_ms  INTEGER NOT NULL,
      received_epoch_ms INTEGER NOT NULL,
      file_path         TEXT    NOT NULL,
      device_frame      INTEGER,
      byte_length       INTEGER,
      jpeg_ok           INTEGER,
      vlm_status        TEXT    NOT NULL DEFAULT 'pending',
      vlm_model         TEXT,
      vlm_label         TEXT,
      vlm_description   TEXT,
      vlm_descriptor    TEXT,
      vlm_completed_at  INTEGER,
      -- DRM: per-frame work|break|other from the VLM worker, plus the labels
      -- the participant's SUBMITTED reconstruction propagates back onto the
      -- frames (NULL = never touched by a submitted reconstruction).
      vlm_category      TEXT,
      user_corrected_category_label TEXT,
      user_corrected_activity_label TEXT,
      -- Face anonymization, filled by the separate face-blur worker (Python).
      -- Faces are pixelated in place BEFORE the frame is ever served; the read
      -- API only exposes frames whose face_status='done'.
      face_status       TEXT    NOT NULL DEFAULT 'pending',  -- pending|processing|done|failed
      face_count        INTEGER,                             -- faces detected/obscured
      face_method       TEXT,                                -- e.g. 'mosaic:centerface@0.2'
      face_completed_at INTEGER,
      PRIMARY KEY (participant, device, session, frame_index)
    );
    CREATE INDEX IF NOT EXISTS idx_frames_time
      ON frames (participant, capture_epoch_ms);
    CREATE INDEX IF NOT EXISTS idx_frames_pending
      ON frames (capture_epoch_ms) WHERE vlm_status = 'pending';
  `);
    // Migrate DBs created before the face_* columns existed (the columns are part
    // of the CREATE above for fresh DBs; ALTER adds them to existing ones). Every
    // pre-existing row gets face_status='pending', so the worker backfills them.
    migrateAddColumn("face_status", "face_status TEXT NOT NULL DEFAULT 'pending'");
    migrateAddColumn("face_count", "face_count INTEGER");
    migrateAddColumn("face_method", "face_method TEXT");
    migrateAddColumn("face_completed_at", "face_completed_at INTEGER");
    // Created after the column exists so the migration path also gets the index.
    db.exec(`
    CREATE INDEX IF NOT EXISTS idx_frames_face_pending
      ON frames (capture_epoch_ms) WHERE face_status = 'pending';
  `);
    // DRM migration (additive, same pattern as face_*): category + propagated
    // user-corrected labels on frames, plus the participants / reconstructions /
    // activities tables.
    migrateAddColumn("vlm_category", "vlm_category TEXT");
    migrateAddColumn("user_corrected_category_label", "user_corrected_category_label TEXT");
    migrateAddColumn("user_corrected_activity_label", "user_corrected_activity_label TEXT");
    // Clean-break migration from the OLD multi-day DRM schema (2026-07-12,
    // decided with Felix): participants.condition_plan -> arm, reconstructions
    // keyed by day -> by round. Only test data ever lived in the old shape, so
    // old-shape DRM tables are dropped and recreated; frames + auth untouched.
    // Re-provision test users (create-user / seed-demo-data) after this runs.
    const tableHasColumn = (table, column) => {
        const cols = db.prepare(`PRAGMA table_info(${table})`).all();
        return cols.some((c) => c.name === column);
    };
    const tableExists = (table) => db.prepare(`PRAGMA table_info(${table})`).all().length > 0;
    if (tableExists("participants") && !tableHasColumn("participants", "arm")) {
        db.exec(`DROP TABLE participants;`);
    }
    if (tableExists("reconstructions") && !tableHasColumn("reconstructions", "round")) {
        db.exec(`DROP TABLE reconstructions; DROP TABLE IF EXISTS activities;`);
    }
    db.exec(`
    CREATE TABLE IF NOT EXISTS participants (
      username          TEXT PRIMARY KEY,
      occupation        TEXT,
      work_description  TEXT,
      wake_time         TEXT,
      bed_time          TEXT,
      arm               TEXT NOT NULL DEFAULT 'main',
      push_token        TEXT,
      last_reminder_day TEXT,
      created_at        INTEGER NOT NULL,
      updated_at        INTEGER
    );
    CREATE TABLE IF NOT EXISTS reconstructions (
      participant  TEXT NOT NULL,
      round        INTEGER NOT NULL,
      mode         TEXT NOT NULL,
      day          TEXT NOT NULL,
      status       TEXT NOT NULL DEFAULT 'draft',
      created_at   INTEGER NOT NULL,
      submitted_at INTEGER,
      PRIMARY KEY (participant, round)
    );
    CREATE TABLE IF NOT EXISTS activities (
      id             INTEGER PRIMARY KEY AUTOINCREMENT,
      participant    TEXT NOT NULL,
      round          INTEGER NOT NULL,
      position       INTEGER NOT NULL,
      start_ms       INTEGER NOT NULL,
      end_ms         INTEGER NOT NULL,
      raw_label      TEXT,
      category_label TEXT,
      source         TEXT NOT NULL,
      vlm_raw_label  TEXT,
      vlm_category   TEXT,
      -- 7-point Likert experience ratings (1-7, NULL = not answered):
      -- mental demand for work activities, mental recovery for breaks.
      workload_rating INTEGER,
      recovery_rating INTEGER,
      created_at     INTEGER NOT NULL,
      updated_at     INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_activities_round
      ON activities (participant, round, position);
  `);
    // Additive migration for activities tables created before the experience
    // ratings existed (same pattern as the frames face_*/DRM columns).
    if (!tableHasColumn("activities", "workload_rating")) {
        db.exec(`ALTER TABLE activities ADD COLUMN workload_rating INTEGER`);
    }
    if (!tableHasColumn("activities", "recovery_rating")) {
        db.exec(`ALTER TABLE activities ADD COLUMN recovery_rating INTEGER`);
    }
    insertStmt = db.prepare(`
    INSERT INTO frames (
      participant, device, session, frame_index,
      capture_epoch_ms, received_epoch_ms, file_path,
      device_frame, byte_length, jpeg_ok
    ) VALUES (
      @participant, @device, @session, @frame_index,
      @capture_epoch_ms, @received_epoch_ms, @file_path,
      @device_frame, @byte_length, @jpeg_ok
    )
  `);
    exportStmt = db.prepare(`
    SELECT frame_index, capture_epoch_ms, received_epoch_ms, device_frame,
           byte_length, jpeg_ok, file_path
    FROM frames
    WHERE participant = @participant AND device = @device AND session = @session
    ORDER BY frame_index
  `);
    listSessionsStmt = db.prepare(`
    SELECT device, session,
           MIN(capture_epoch_ms) AS started_at_ms,
           MAX(capture_epoch_ms) AS ended_at_ms,
           COUNT(*)              AS frame_count
    FROM frames
    WHERE participant = ?
    GROUP BY device, session
    ORDER BY started_at_ms DESC
  `);
    // Only anonymized frames are exposed: a frame still pending (or being
    // processed / failed) in the face-blur worker is withheld so an unblurred
    // face is never listed or served.
    listFramesStmt = db.prepare(`
    SELECT frame_index, capture_epoch_ms, file_path
    FROM frames
    WHERE participant = ? AND device = ? AND session = ?
      AND face_status = 'done'
    ORDER BY frame_index
  `);
    getFrameStmt = db.prepare(`
    SELECT file_path FROM frames
    WHERE participant = ? AND device = ? AND session = ? AND frame_index = ?
  `);
    deleteFrameStmt = db.prepare(`
    DELETE FROM frames
    WHERE participant = ? AND device = ? AND session = ? AND frame_index = ?
  `);
    maxFrameIndexStmt = db.prepare(`
    SELECT COALESCE(MAX(frame_index), 0) AS max_index FROM frames
    WHERE participant = ? AND device = ? AND session = ?
  `);
    frameStatusByPathStmt = db.prepare(`
    SELECT face_status FROM frames
    WHERE participant = ? AND file_path = ?
  `);
    // --- DRM statements --------------------------------------------------------
    getParticipantStmt = db.prepare(`
    SELECT username, occupation, work_description, wake_time, bed_time, arm,
           push_token, last_reminder_day, created_at, updated_at
    FROM participants WHERE username = ?
  `);
    insertParticipantStmt = db.prepare(`
    INSERT OR IGNORE INTO participants (username, created_at) VALUES (?, ?)
  `);
    updateArmStmt = db.prepare(`
    UPDATE participants SET arm = ?, updated_at = ? WHERE username = ?
  `);
    updateProfileStmt = db.prepare(`
    UPDATE participants
    SET occupation = ?, work_description = ?, wake_time = ?, bed_time = ?,
        updated_at = ?
    WHERE username = ?
  `);
    updatePushTokenStmt = db.prepare(`
    UPDATE participants SET push_token = ?, updated_at = ? WHERE username = ?
  `);
    updateLastReminderDayStmt = db.prepare(`
    UPDATE participants SET last_reminder_day = ? WHERE username = ?
  `);
    listPushParticipantsStmt = db.prepare(`
    SELECT username, occupation, work_description, wake_time, bed_time, arm,
           push_token, last_reminder_day, created_at, updated_at
    FROM participants WHERE push_token IS NOT NULL
  `);
    frameDayStatsStmt = db.prepare(`
    SELECT capture_epoch_ms, vlm_status, face_status FROM frames
    WHERE participant = ?
    ORDER BY capture_epoch_ms
  `);
    framesInRangeStmt = db.prepare(`
    SELECT capture_epoch_ms, file_path, face_status, vlm_status, vlm_label,
           vlm_category
    FROM frames
    WHERE participant = ? AND capture_epoch_ms BETWEEN ? AND ?
    ORDER BY capture_epoch_ms
  `);
    getReconstructionStmt = db.prepare(`
    SELECT participant, round, mode, day, status, created_at, submitted_at
    FROM reconstructions WHERE participant = ? AND round = ?
  `);
    insertReconstructionStmt = db.prepare(`
    INSERT OR IGNORE INTO reconstructions (participant, round, mode, day, status, created_at)
    VALUES (?, ?, ?, ?, 'draft', ?)
  `);
    markSubmittedStmt = db.prepare(`
    UPDATE reconstructions SET status = 'submitted', submitted_at = ?
    WHERE participant = ? AND round = ?
  `);
    listActivitiesStmt = db.prepare(`
    SELECT id, position, start_ms, end_ms, raw_label, category_label, source,
           vlm_raw_label, vlm_category, workload_rating, recovery_rating
    FROM activities
    WHERE participant = ? AND round = ?
    ORDER BY position
  `);
    listVlmSpanActivitiesStmt = db.prepare(`
    SELECT start_ms, end_ms, vlm_raw_label, vlm_category
    FROM activities
    WHERE participant = ? AND round = ? AND source = 'vlm'
  `);
    deleteActivitiesStmt = db.prepare(`
    DELETE FROM activities WHERE participant = ? AND round = ?
  `);
    insertActivityStmt = db.prepare(`
    INSERT INTO activities (
      participant, round, position, start_ms, end_ms,
      raw_label, category_label, source, vlm_raw_label, vlm_category,
      workload_rating, recovery_rating,
      created_at, updated_at
    ) VALUES (
      @participant, @round, @position, @start_ms, @end_ms,
      @raw_label, @category_label, @source, @vlm_raw_label, @vlm_category,
      @workload_rating, @recovery_rating,
      @created_at, @updated_at
    )
  `);
    // Label-quality propagation (contract): a submitted activity stamps its
    // labels onto every frame in its time span.
    propagateCorrectionsStmt = db.prepare(`
    UPDATE frames
    SET user_corrected_category_label = ?, user_corrected_activity_label = ?
    WHERE participant = ? AND capture_epoch_ms BETWEEN ? AND ?
  `);
    // Replace-all write for a round's activities. Draft saves and submissions
    // share it; submit additionally locks the round and — for the ASSISTED
    // round only — propagates the labels onto the frames, all atomically.
    // Self rounds must never propagate: both rounds cover the same day, so a
    // self-round propagation would overwrite (or pre-empt) the assisted
    // round's frame-level ground truth.
    replaceActivitiesTx = db.transaction((participant, round, mode, day, activities, submit, now) => {
        // Snapshot the original VLM proposals before the delete, keyed by span,
        // so unchanged spans keep their vlm_* provenance across saves.
        const existingVlmRows = listVlmSpanActivitiesStmt.all(participant, round);
        const vlmBySpan = new Map(existingVlmRows.map((row) => [`${row.start_ms}|${row.end_ms}`, row]));
        deleteActivitiesStmt.run(participant, round);
        activities.forEach((activity, position) => {
            const matched = vlmBySpan.get(`${activity.start_ms}|${activity.end_ms}`);
            insertActivityStmt.run({
                participant,
                round,
                position,
                start_ms: activity.start_ms,
                end_ms: activity.end_ms,
                raw_label: activity.raw_label,
                category_label: activity.category_label,
                source: activity.source,
                vlm_raw_label: activity.vlm_raw_label ?? matched?.vlm_raw_label ?? null,
                vlm_category: activity.vlm_category ?? matched?.vlm_category ?? null,
                workload_rating: activity.workload_rating ?? null,
                recovery_rating: activity.recovery_rating ?? null,
                created_at: now,
                updated_at: now,
            });
        });
        insertReconstructionStmt.run(participant, round, mode, day, now);
        if (!submit)
            return null;
        markSubmittedStmt.run(now, participant, round);
        if (mode !== "assisted")
            return now;
        // Defense in depth: the API validates every span against the day, but
        // the propagation additionally clamps to the day's UTC range so a bug
        // upstream can never rewrite frames outside the pinned study day.
        const { fromMs, toMs } = (0, time_1.dayUtcRange)(day);
        for (const activity of activities) {
            propagateCorrectionsStmt.run(activity.category_label, activity.raw_label, participant, Math.max(activity.start_ms, fromMs), Math.min(activity.end_ms, toMs));
        }
        return now;
    });
}
// Pins a round's mode + study day the first time the participant opens it
// (INSERT OR IGNORE = no-op when a row already exists). Without pinning, the
// study day would keep deriving from the participant's latest frame day —
// mutable data: a new frame the next morning (or a frame deletion) could
// silently shift an already-seen round onto a different day, and an arm
// change after the evening could flip round 2's mode mid-reconstruction.
function pinReconstructionRound(participant, round, mode, day) {
    insertReconstructionStmt.run(participant, round, mode, day, Date.now());
}
function listSessions(participant) {
    return listSessionsStmt.all(participant);
}
function listFrames(participant, device, session) {
    return listFramesStmt.all(participant, device, session);
}
function getFrameFilePath(participant, device, session, frameIndex) {
    const row = getFrameStmt.get(participant, device, session, frameIndex);
    return row?.file_path;
}
// Serving gate: returns the face anonymization status for a frame identified by
// its on-disk path, scoped to the owner. Used by /frames to refuse a frame
// whose face has not been blurred yet. Returns undefined if no such row.
function getFrameStatusByPath(participant, filePath) {
    const row = frameStatusByPathStmt.get(participant, filePath);
    return row?.face_status;
}
function deleteFrameRow(participant, device, session, frameIndex) {
    return (deleteFrameStmt.run(participant, device, session, frameIndex).changes > 0);
}
// Lets a reconnecting phone continue a session's frame numbering instead of
// colliding with rows already written under the same (participant, device,
// session) key.
function maxFrameIndex(participant, device, session) {
    const row = maxFrameIndexStmt.get(participant, device, session);
    return row.max_index;
}
function insertFrame(row) {
    insertStmt.run(row);
}
// --- DRM: participants -------------------------------------------------------
function getParticipant(username) {
    return getParticipantStmt.get(username);
}
// Creates the participants row if missing (condition_plan gets the schema
// default); never touches an existing row.
function ensureParticipant(username) {
    insertParticipantStmt.run(username, Date.now());
}
function setArm(username, arm) {
    ensureParticipant(username);
    updateArmStmt.run(arm, Date.now(), username);
}
// Profile upsert: occupation, work description and the daily schedule —
// deliberately never touches arm (that is provisioning state, not profile
// state).
function upsertParticipantProfile(username, occupation, workDescription, wakeTime, bedTime) {
    ensureParticipant(username);
    updateProfileStmt.run(occupation, workDescription, wakeTime, bedTime, Date.now(), username);
}
function setPushToken(username, pushToken) {
    ensureParticipant(username);
    updatePushTokenStmt.run(pushToken, Date.now(), username);
}
function setLastReminderDay(username, day) {
    updateLastReminderDayStmt.run(day, username);
}
function listPushParticipants() {
    return listPushParticipantsStmt.all();
}
// --- DRM: day aggregation ----------------------------------------------------
// Distinct local study days (>=1 frame) for a participant, ascending by day,
// with frame + VLM-pending counts. Day keys are computed in the study TZ from
// capture_epoch_ms (SQLite has no timezone support, so bucketing happens here;
// a participant's whole study is a few thousand rows).
function aggregateFrameDays(participant) {
    const rows = frameDayStatsStmt.all(participant);
    const byDay = new Map();
    for (const row of rows) {
        const day = (0, time_1.dayKeyFromEpochMs)(row.capture_epoch_ms);
        let aggregate = byDay.get(day);
        if (!aggregate) {
            aggregate = { day, frameCount: 0, vlmPendingCount: 0 };
            byDay.set(day, aggregate);
        }
        aggregate.frameCount += 1;
        // A face_status='failed' frame can never become VLM-done (the VLM gate
        // requires face 'done'), so it must not count as pending — otherwise one
        // failed blur would keep an assisted day in "still processing" forever.
        if ((row.vlm_status === "pending" || row.vlm_status === "processing") &&
            row.face_status !== "failed") {
            aggregate.vlmPendingCount += 1;
        }
    }
    return Array.from(byDay.values()).sort((a, b) => (a.day < b.day ? -1 : 1));
}
// Every frame of one local day, ordered by capture time. A conservative UTC
// range narrows the indexed scan; the exact local-day filter happens here.
function listFramesOnDay(participant, day) {
    const { fromMs, toMs } = (0, time_1.dayUtcRange)(day);
    const rows = framesInRangeStmt.all(participant, fromMs, toMs);
    return rows.filter((row) => (0, time_1.dayKeyFromEpochMs)(row.capture_epoch_ms) === day);
}
function countFramesOnDay(participant, day) {
    return listFramesOnDay(participant, day).length;
}
// The participant's most recent local date with >=1 frame — the candidate
// study day while no round is pinned yet (a Day-0 lab test run is superseded
// as soon as the real field day produces frames).
function latestFrameDay(participant) {
    const days = aggregateFrameDays(participant);
    return days.length > 0 ? days[days.length - 1].day : undefined;
}
// --- DRM: reconstructions + activities ---------------------------------------
function getReconstruction(participant, round) {
    return getReconstructionStmt.get(participant, round);
}
function listActivities(participant, round) {
    return listActivitiesStmt.all(participant, round);
}
// Atomic replace-all save of a round's activities (creates the
// reconstructions row on first save). With submit=true also locks the round
// and — assisted mode only — propagates each activity's labels onto the
// frames in its span; returns the submitted_at timestamp (null for drafts).
function replaceActivities(options) {
    const submittedAt = replaceActivitiesTx(options.participant, options.round, options.mode, options.day, options.activities, options.submit, Date.now());
    return { submittedAt };
}
// Reconstructs a per-session CSV from the DB on demand (the DB is the live
// index now). CaptureDatetime is intentionally dropped (derive it from
// capture_epoch_ms if needed). NO vlm_* columns: participant-facing output
// must never carry VLM labels (DRM control-condition anti-leak; see ExportRow).
function exportFramesCsv(q) {
    const rows = exportStmt.all(q);
    const header = "FrameIndex;CaptureEpochMs;ReceivedEpochMs;DeviceFrame;ByteLength;JpegOk;FilePath";
    const lines = rows.map((r) => [
        r.frame_index,
        r.capture_epoch_ms,
        r.received_epoch_ms,
        r.device_frame ?? "",
        r.byte_length ?? "",
        r.jpeg_ok ?? "",
        r.file_path,
    ].join(";"));
    return [header, ...lines].join("\n") + "\n";
}
