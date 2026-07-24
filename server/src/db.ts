import Database from "better-sqlite3";

import { dayKeyFromEpochMs, dayUtcRange } from "./time";

// ===========================================================================
// SQLite metadata store (recordings.db, WAL mode, via better-sqlite3).
//
// One row per ingested frame, written synchronously as the JPEG is received.
// The JPEG bytes stay on the filesystem under recordings/...; this table is the
// index over them, superseding the old per-session CSV, and the place the
// separate VLM process later writes labels / descriptions / descriptors back.
// See CLAUDE.md, "Storage and VLM metadata", for the rationale and full schema.
//
// DRM subproject additions (single-day, two-round design): participants
// (occupation / schedule / study arm / push token), reconstructions (one per
// participant+round, round 1 = self from memory, round 2 = assisted or self
// depending on the arm), activities (the reconstruction unit), plus per-frame
// vlm_category and user_corrected_* columns filled by propagating the
// submitted ASSISTED reconstruction onto its frames.
// ===========================================================================

// Inserted at ingestion time. The vlm_* columns are filled later by the VLM
// process and default to 'pending', so they are not part of this shape.
export interface FrameInsert {
  participant: string;
  device: string; // MAC, colons stripped
  session: number; // session epoch (connect time)
  frame_index: number; // per-session server counter
  capture_epoch_ms: number; // device NTP time (biosignal alignment key)
  received_epoch_ms: number; // server receipt time
  file_path: string; // relative to recordings/
  device_frame: number | null; // device's own counter; gaps = dropped frames
  byte_length: number;
  jpeg_ok: number; // 0/1 from the SOI/EOI check
}

// Shape returned by the CSV export query. Deliberately NO vlm_* columns: the
// export is participant-facing (bearer token), and a control-day participant
// must never be able to obtain VLM output (the researcher reads recordings.db
// directly on the VM for analysis).
interface ExportRow {
  frame_index: number;
  capture_epoch_ms: number;
  received_epoch_ms: number;
  device_frame: number | null;
  byte_length: number | null;
  jpeg_ok: number | null;
  file_path: string;
}

// Rows returned by the participant-facing read API.
export interface SessionRow {
  device: string;
  session: number;
  started_at_ms: number;
  ended_at_ms: number;
  frame_count: number;
  deleted_frame_count: number;
}

// Deliberately carries no vlm_* columns: the mobile app must never receive
// VLM output (anti-leak for the DRM control condition).
export interface FrameRow {
  frame_index: number;
  capture_epoch_ms: number;
  file_path: string;
}

export interface FrameDeletionTarget {
  filePath: string;
  deletedAt: number | null;
}

// --- DRM row shapes ---------------------------------------------------------

export interface ParticipantRow {
  username: string;
  occupation: string | null;
  work_description: string | null;
  wake_time: string | null; // "HH:MM" local study time, from app onboarding
  bed_time: string | null; // "HH:MM"; drives the fallback push reminder
  arm: string; // 'main'|'control', set at provisioning (create-user --arm)
  push_token: string | null;
  last_reminder_day: string | null;
  created_at: number;
  updated_at: number | null;
}

export interface ReconstructionRow {
  participant: string;
  round: number; // 1|2
  mode: string; // 'self'|'assisted'
  day: string; // pinned study day (YYYY-MM-DD)
  status: string; // 'draft'|'submitted'
  created_at: number;
  submitted_at: number | null;
}

export interface ActivityRow {
  id: number;
  position: number;
  start_ms: number;
  end_ms: number;
  raw_label: string | null;
  category_label: string | null; // 'work'|'break'|'other'
  source: string; // 'vlm'|'user'
  vlm_raw_label: string | null;
  vlm_category: string | null;
  // Experience ratings (7-point Likert, 1-7; NULL = not answered). Work
  // activities rate mental demand, breaks rate mental recovery.
  workload_rating: number | null;
  recovery_rating: number | null;
}

// Replace-all write shape; the DB layer assigns position from array order and
// fills vlm_raw_label/vlm_category from a matching existing 'vlm' row (same
// [start_ms, end_ms] span) unless the caller supplies them (generation path).
export interface ActivityWriteInput {
  start_ms: number;
  end_ms: number;
  raw_label: string | null;
  category_label: string | null;
  source: "vlm" | "user";
  vlm_raw_label?: string | null;
  vlm_category?: string | null;
  workload_rating?: number | null;
  recovery_rating?: number | null;
}

// Per-day frame aggregate for study-day resolution.
export interface DayAggregate {
  day: string;
  frameCount: number;
  vlmPendingCount: number; // frames whose chunk is not yet done/failed
}

// Frame rows of one local day, for the reconstruction API + segmentation.
// vlm_label / vlm_category are inherited from the frame's 5-minute CHUNK
// (non-null only once the chunk's VLM pass is done); chunk_status is the
// chunk lifecycle (null only for legacy rows ingested before chunks existed).
export interface DayFrameRow {
  capture_epoch_ms: number;
  file_path: string;
  face_status: string;
  chunk_status: string | null;
  vlm_label: string | null;
  vlm_category: string | null;
}

// --- 5-minute chunks ---------------------------------------------------------
// The chunk is the VLM inference unit: frames are grouped into clock-aligned
// 5-minute windows at ingestion, and the VLM worker labels whole chunks (not
// individual frames). Epoch-aligned windows ARE local-clock-aligned windows:
// every real-world UTC offset is a whole multiple of 5 minutes.

export const CHUNK_WINDOW_MS = 5 * 60 * 1000;

/** Clock-aligned window start containing the given capture time. */
export function chunkStartOf(captureEpochMs: number): number {
  return captureEpochMs - (captureEpochMs % CHUNK_WINDOW_MS);
}

// One day's chunk as segmentation/bootstrap input: the chunk's VLM result
// plus the REAL first/last capture times of its servable (face-done) frames.
export interface DayChunkRow {
  chunk_start_ms: number;
  status: string;
  vlm_label: string | null;
  vlm_category: string | null;
  first_frame_ms: number | null; // null = no servable frame in this chunk
  last_frame_ms: number | null;
  served_frame_count: number;
}

export interface ChunkRow {
  participant: string;
  chunk_start_ms: number;
  chunk_end_ms: number;
  frame_count: number;
  last_frame_received_ms: number | null;
  status: string; // filling|ready|processing|done|failed
  vlm_model: string | null;
  vlm_label: string | null;
  vlm_category: string | null;
  vlm_description: string | null;
  vlm_descriptor: string | null;
  vlm_completed_at: number | null;
  user_corrected_category_label: string | null;
  user_corrected_activity_label: string | null;
  created_at: number;
  updated_at: number | null;
}

export const STUDY_ARMS = ["main", "control"] as const;
export type StudyArm = (typeof STUDY_ARMS)[number];

// Normalizes a participants.arm value, defaulting to 'main' on anything
// malformed (defensive: the column is provisioned by create-user, but a
// hand-edited DB must not take the API down).
export function parseArm(value: string | null | undefined): StudyArm {
  return value === "control" ? "control" : "main";
}

let db: Database.Database;
let insertStmt: Database.Statement;
let exportStmt: Database.Statement;
let listSessionsStmt: Database.Statement;
let listFramesStmt: Database.Statement;
let getFrameForDeletionStmt: Database.Statement;
let softDeleteFrameStmt: Database.Statement;
let maxFrameIndexStmt: Database.Statement;
let frameStatusByPathStmt: Database.Statement;

// Chunk statements
let upsertChunkStmt: Database.Statement;
let closeEarlierChunksStmt: Database.Statement;
let closeIdleChunksStmt: Database.Statement;
let closeParticipantChunksStmt: Database.Statement;
let chunksInRangeStmt: Database.Statement;
let getFrameChunkStmt: Database.Statement;
let decrementChunkStmt: Database.Statement;
let deleteEmptyChunkStmt: Database.Statement;
let insertFrameTx: Database.Transaction<(row: FrameInsert) => void>;
let softDeleteFrameTx: Database.Transaction<
  (participant: string, device: string, session: number, frameIndex: number) => boolean
>;

// DRM statements
let getParticipantStmt: Database.Statement;
let insertParticipantStmt: Database.Statement;
let updateArmStmt: Database.Statement;
let updateProfileStmt: Database.Statement;
let updatePushTokenStmt: Database.Statement;
let updateLastReminderDayStmt: Database.Statement;
let listPushParticipantsStmt: Database.Statement;
let frameDayStatsStmt: Database.Statement;
let framesInRangeStmt: Database.Statement;
let getReconstructionStmt: Database.Statement;
let insertReconstructionStmt: Database.Statement;
let markSubmittedStmt: Database.Statement;
let listActivitiesStmt: Database.Statement;
let listVlmSpanActivitiesStmt: Database.Statement;
let deleteActivitiesStmt: Database.Statement;
let insertActivityStmt: Database.Statement;
let propagateCorrectionsStmt: Database.Statement;
let replaceActivitiesTx: Database.Transaction<
  (
    participant: string,
    round: number,
    mode: string,
    day: string,
    activities: ActivityWriteInput[],
    submit: boolean,
    now: number,
  ) => number | null
>;

// Adds a column to the frames table only if it is missing, so an existing
// recordings.db (written before the column was introduced) is upgraded in
// place without losing rows. Must be called after the table exists.
function migrateAddColumn(column: string, ddl: string): void {
  const cols = db.prepare(`PRAGMA table_info(frames)`).all() as {
    name: string;
  }[];
  if (!cols.some((c) => c.name === column)) {
    db.exec(`ALTER TABLE frames ADD COLUMN ${ddl}`);
  }
}

export function initDb(dbPath: string): void {
  db = new Database(dbPath);
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
      -- Soft deletion keeps the research/audit row while removing the JPEG.
      -- file_path is cleared at deletion so no serving path remains.
      deleted_at        INTEGER,
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
  migrateAddColumn(
    "face_status",
    "face_status TEXT NOT NULL DEFAULT 'pending'",
  );
  migrateAddColumn("face_count", "face_count INTEGER");
  migrateAddColumn("face_method", "face_method TEXT");
  migrateAddColumn("face_completed_at", "face_completed_at INTEGER");
  migrateAddColumn("deleted_at", "deleted_at INTEGER");

  // Recreate these partial indexes after the migration so older databases do
  // not keep indexing soft-deleted work as pending.
  db.exec(`
    DROP INDEX IF EXISTS idx_frames_pending;
    DROP INDEX IF EXISTS idx_frames_face_pending;
    CREATE INDEX idx_frames_pending
      ON frames (capture_epoch_ms)
      WHERE vlm_status = 'pending' AND deleted_at IS NULL;
    CREATE INDEX idx_frames_face_pending
      ON frames (capture_epoch_ms)
      WHERE face_status = 'pending' AND deleted_at IS NULL;
    CREATE INDEX IF NOT EXISTS idx_frames_deleted
      ON frames (participant, deleted_at)
      WHERE deleted_at IS NOT NULL;
  `);

  // DRM migration (additive, same pattern as face_*): category + propagated
  // user-corrected labels on frames, plus the participants / reconstructions /
  // activities tables.
  // NOTE (2026-07 chunk rework): frames.vlm_* and frames.user_corrected_* are
  // FROZEN legacy columns — kept readable for pre-chunk test data but no
  // longer written. The VLM output and the propagated corrections now live on
  // the 5-minute chunks table below.
  migrateAddColumn("vlm_category", "vlm_category TEXT");
  migrateAddColumn(
    "user_corrected_category_label",
    "user_corrected_category_label TEXT",
  );
  migrateAddColumn(
    "user_corrected_activity_label",
    "user_corrected_activity_label TEXT",
  );

  // Chunk rework (additive): every frame knows its clock-aligned 5-minute
  // window; NULL marks legacy rows ingested before chunks existed (they keep
  // their frozen per-frame vlm_* data and are excluded from chunk logic).
  migrateAddColumn("chunk_start_ms", "chunk_start_ms INTEGER");
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_frames_chunk
      ON frames (participant, chunk_start_ms);
    CREATE TABLE IF NOT EXISTS chunks (
      participant     TEXT    NOT NULL,
      chunk_start_ms  INTEGER NOT NULL,  -- clock-aligned 5-min window start
      chunk_end_ms    INTEGER NOT NULL,  -- start + 5 min (exclusive)
      frame_count     INTEGER NOT NULL DEFAULT 0,
      last_frame_received_ms INTEGER,    -- server receipt of the newest frame
      -- Lifecycle: 'filling' while the window can still receive frames;
      -- 'ready' once closed (a later-window frame arrived, or the idle sweep
      -- fired); the VLM worker takes it ready -> processing -> done|failed.
      status          TEXT    NOT NULL DEFAULT 'filling',
      vlm_model       TEXT,
      vlm_label       TEXT,
      vlm_category    TEXT,               -- work|break|other
      vlm_description TEXT,
      vlm_descriptor  TEXT,               -- JSON scene-state descriptor
      vlm_completed_at INTEGER,
      -- Label-quality propagation target (was frames.user_corrected_*): the
      -- submitted ASSISTED reconstruction stamps its labels onto every chunk
      -- overlapping each activity's span.
      user_corrected_category_label TEXT,
      user_corrected_activity_label TEXT,
      created_at      INTEGER NOT NULL,
      updated_at      INTEGER,
      PRIMARY KEY (participant, chunk_start_ms)
    );
    CREATE INDEX IF NOT EXISTS idx_chunks_status
      ON chunks (status, chunk_start_ms);
  `);

  // Clean-break migration from the OLD multi-day DRM schema (2026-07-12,
  // decided with Felix): participants.condition_plan -> arm, reconstructions
  // keyed by day -> by round. Only test data ever lived in the old shape, so
  // old-shape DRM tables are dropped and recreated; frames + auth untouched.
  // Re-provision test users (create-user / seed-demo-data) after this runs.
  const tableHasColumn = (table: string, column: string): boolean => {
    const cols = db.prepare(`PRAGMA table_info(${table})`).all() as {
      name: string;
    }[];
    return cols.some((c) => c.name === column);
  };
  const tableExists = (table: string): boolean =>
    (db.prepare(`PRAGMA table_info(${table})`).all() as unknown[]).length > 0;
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
      device_frame, byte_length, jpeg_ok, chunk_start_ms
    ) VALUES (
      @participant, @device, @session, @frame_index,
      @capture_epoch_ms, @received_epoch_ms, @file_path,
      @device_frame, @byte_length, @jpeg_ok, @chunk_start_ms
    )
  `);

  upsertChunkStmt = db.prepare(`
    INSERT INTO chunks (
      participant, chunk_start_ms, chunk_end_ms, frame_count,
      last_frame_received_ms, created_at, updated_at
    ) VALUES (
      @participant, @chunk_start_ms, @chunk_end_ms, 1, @received_ms, @now, @now
    )
    ON CONFLICT (participant, chunk_start_ms) DO UPDATE SET
      frame_count = frame_count + 1,
      last_frame_received_ms = excluded.last_frame_received_ms,
      updated_at = excluded.updated_at
  `);

  // Frames upload in capture order per participant (single camera, FIFO
  // queue), so the arrival of a frame for a LATER window proves every earlier
  // window can no longer grow: close them.
  closeEarlierChunksStmt = db.prepare(`
    UPDATE chunks SET status = 'ready', updated_at = @now
    WHERE participant = @participant AND status = 'filling'
      AND chunk_start_ms < @chunk_start_ms
  `);

  // Idle sweep (the day's LAST chunk never sees a later frame): close any
  // still-filling chunk whose newest frame arrived longer than the idle
  // window ago. Keyed on server receipt time so an offline phone's delayed
  // catch-up upload keeps its chunk open while frames are still streaming in.
  closeIdleChunksStmt = db.prepare(`
    UPDATE chunks SET status = 'ready', updated_at = @now
    WHERE status = 'filling' AND last_frame_received_ms < @cutoff_ms
  `);

  // The app's explicit End-session signal: every still-filling chunk of the
  // participant closes immediately (the idle sweep stays as the fallback).
  closeParticipantChunksStmt = db.prepare(`
    UPDATE chunks SET status = 'ready', updated_at = @now
    WHERE participant = @participant AND status = 'filling'
  `);

  chunksInRangeStmt = db.prepare(`
    SELECT c.chunk_start_ms, c.status, c.vlm_label, c.vlm_category,
           MIN(f.capture_epoch_ms) AS first_frame_ms,
           MAX(f.capture_epoch_ms) AS last_frame_ms,
           COUNT(f.capture_epoch_ms) AS served_frame_count
    FROM chunks c
    LEFT JOIN frames f
      ON f.participant = c.participant
     AND f.chunk_start_ms = c.chunk_start_ms
     AND f.face_status = 'done'
     AND f.deleted_at IS NULL
    WHERE c.participant = ? AND c.chunk_start_ms BETWEEN ? AND ?
    GROUP BY c.chunk_start_ms
    ORDER BY c.chunk_start_ms
  `);

  getFrameChunkStmt = db.prepare(`
    SELECT chunk_start_ms, deleted_at FROM frames
    WHERE participant = ? AND device = ? AND session = ? AND frame_index = ?
  `);

  decrementChunkStmt = db.prepare(`
    UPDATE chunks SET frame_count = frame_count - 1, updated_at = ?
    WHERE participant = ? AND chunk_start_ms = ?
  `);

  deleteEmptyChunkStmt = db.prepare(`
    DELETE FROM chunks
    WHERE participant = ? AND chunk_start_ms = ? AND frame_count <= 0
  `);

  exportStmt = db.prepare(`
    SELECT frame_index, capture_epoch_ms, received_epoch_ms, device_frame,
           byte_length, jpeg_ok, file_path
    FROM frames
    WHERE participant = @participant AND device = @device AND session = @session
      AND deleted_at IS NULL
    ORDER BY frame_index
  `);

  listSessionsStmt = db.prepare(`
    SELECT device, session,
           COALESCE(
             MIN(CASE WHEN deleted_at IS NULL THEN capture_epoch_ms END),
             MIN(capture_epoch_ms)
           ) AS started_at_ms,
           COALESCE(
             MAX(CASE WHEN deleted_at IS NULL THEN capture_epoch_ms END),
             MAX(capture_epoch_ms)
           ) AS ended_at_ms,
           COUNT(CASE WHEN deleted_at IS NULL THEN 1 END)     AS frame_count,
           COUNT(CASE WHEN deleted_at IS NOT NULL THEN 1 END) AS deleted_frame_count
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
      AND deleted_at IS NULL
    ORDER BY frame_index
  `);

  getFrameForDeletionStmt = db.prepare(`
    SELECT file_path, deleted_at FROM frames
    WHERE participant = ? AND device = ? AND session = ? AND frame_index = ?
  `);

  softDeleteFrameStmt = db.prepare(`
    UPDATE frames SET deleted_at = ?, file_path = ''
    WHERE participant = ? AND device = ? AND session = ? AND frame_index = ?
      AND deleted_at IS NULL
  `);

  maxFrameIndexStmt = db.prepare(`
    SELECT COALESCE(MAX(frame_index), 0) AS max_index FROM frames
    WHERE participant = ? AND device = ? AND session = ?
  `);

  frameStatusByPathStmt = db.prepare(`
    SELECT face_status FROM frames
    WHERE participant = ? AND file_path = ? AND deleted_at IS NULL
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
    SELECT f.capture_epoch_ms, f.face_status, c.status AS chunk_status
    FROM frames f
    LEFT JOIN chunks c
      ON c.participant = f.participant AND c.chunk_start_ms = f.chunk_start_ms
    WHERE f.participant = ? AND f.deleted_at IS NULL
    ORDER BY f.capture_epoch_ms
  `);

  // Frames inherit their chunk's VLM output; the label is only surfaced once
  // the chunk reached 'done' (mirrors the old per-frame vlm_status gate).
  framesInRangeStmt = db.prepare(`
    SELECT f.capture_epoch_ms, f.file_path, f.face_status,
           c.status AS chunk_status,
           CASE WHEN c.status = 'done' THEN c.vlm_label    ELSE NULL END AS vlm_label,
           CASE WHEN c.status = 'done' THEN c.vlm_category ELSE NULL END AS vlm_category
    FROM frames f
    LEFT JOIN chunks c
      ON c.participant = f.participant AND c.chunk_start_ms = f.chunk_start_ms
    WHERE f.participant = ? AND f.capture_epoch_ms BETWEEN ? AND ?
      AND f.deleted_at IS NULL
    ORDER BY f.capture_epoch_ms
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
  // labels onto every CHUNK overlapping its time span. A chunk straddling two
  // activities is stamped by both; activities are written in position order,
  // so the later activity deterministically wins the boundary chunk.
  propagateCorrectionsStmt = db.prepare(`
    UPDATE chunks
    SET user_corrected_category_label = ?, user_corrected_activity_label = ?
    WHERE participant = ? AND chunk_start_ms < ? AND chunk_end_ms > ?
  `);

  // Replace-all write for a round's activities. Draft saves and submissions
  // share it; submit additionally locks the round and — for the ASSISTED
  // round only — propagates the labels onto the frames, all atomically.
  // Self rounds must never propagate: both rounds cover the same day, so a
  // self-round propagation would overwrite (or pre-empt) the assisted
  // round's frame-level ground truth.
  replaceActivitiesTx = db.transaction(
    (
      participant: string,
      round: number,
      mode: string,
      day: string,
      activities: ActivityWriteInput[],
      submit: boolean,
      now: number,
    ): number | null => {
      // Snapshot the original VLM proposals before the delete, keyed by span,
      // so unchanged spans keep their vlm_* provenance across saves.
      const existingVlmRows = listVlmSpanActivitiesStmt.all(participant, round) as {
        start_ms: number;
        end_ms: number;
        vlm_raw_label: string | null;
        vlm_category: string | null;
      }[];
      const vlmBySpan = new Map(
        existingVlmRows.map((row) => [`${row.start_ms}|${row.end_ms}`, row]),
      );

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
      if (!submit) return null;

      markSubmittedStmt.run(now, participant, round);
      if (mode !== "assisted") return now;

      // Defense in depth: the API validates every span against the day, but
      // the propagation additionally clamps to the day's UTC range so a bug
      // upstream can never rewrite chunks outside the pinned study day.
      const { fromMs, toMs } = dayUtcRange(day);
      for (const activity of activities) {
        propagateCorrectionsStmt.run(
          activity.category_label,
          activity.raw_label,
          participant,
          Math.min(activity.end_ms, toMs), // chunk_start_ms < clamped end
          Math.max(activity.start_ms, fromMs), // chunk_end_ms > clamped start
        );
      }
      return now;
    },
  );

  // Ingest one frame atomically with its chunk bookkeeping: attach the frame
  // to its clock-aligned window, create/grow the chunk row, and close every
  // earlier still-filling chunk of this participant (frames arrive in capture
  // order, so an older window can no longer grow once a newer one starts).
  insertFrameTx = db.transaction((row: FrameInsert) => {
    const chunkStart = chunkStartOf(row.capture_epoch_ms);
    const now = Date.now();
    insertStmt.run({ ...row, chunk_start_ms: chunkStart });
    upsertChunkStmt.run({
      participant: row.participant,
      chunk_start_ms: chunkStart,
      chunk_end_ms: chunkStart + CHUNK_WINDOW_MS,
      received_ms: row.received_epoch_ms,
      now,
    });
    closeEarlierChunksStmt.run({
      participant: row.participant,
      chunk_start_ms: chunkStart,
      now,
    });
  });

  // GDPR per-frame soft delete keeps the audit row but removes it from every
  // active data path. Chunk bookkeeping still tracks only live imagery: the
  // count drops once, and a chunk left with no live frames disappears.
  softDeleteFrameTx = db.transaction(
    (
      participant: string,
      device: string,
      session: number,
      frameIndex: number,
    ): boolean => {
      const frame = getFrameChunkStmt.get(
        participant,
        device,
        session,
        frameIndex,
      ) as
        | { chunk_start_ms: number | null; deleted_at: number | null }
        | undefined;
      if (!frame || frame.deleted_at !== null) return false;
      const deleted =
        softDeleteFrameStmt.run(
          Date.now(),
          participant,
          device,
          session,
          frameIndex,
        ).changes > 0;
      if (deleted && frame?.chunk_start_ms != null) {
        decrementChunkStmt.run(Date.now(), participant, frame.chunk_start_ms);
        deleteEmptyChunkStmt.run(participant, frame.chunk_start_ms);
      }
      return deleted;
    },
  );
}

// Pins a round's mode + study day the first time the participant opens it
// (INSERT OR IGNORE = no-op when a row already exists). Without pinning, the
// study day would keep deriving from the participant's latest frame day —
// mutable data: a new frame the next morning (or a frame deletion) could
// silently shift an already-seen round onto a different day, and an arm
// change after the evening could flip round 2's mode mid-reconstruction.
export function pinReconstructionRound(
  participant: string,
  round: number,
  mode: string,
  day: string,
): void {
  insertReconstructionStmt.run(participant, round, mode, day, Date.now());
}

export function listSessions(participant: string): SessionRow[] {
  return listSessionsStmt.all(participant) as SessionRow[];
}

export function listFrames(
  participant: string,
  device: string,
  session: number,
): FrameRow[] {
  return listFramesStmt.all(participant, device, session) as FrameRow[];
}

export function getFrameDeletionTarget(
  participant: string,
  device: string,
  session: number,
  frameIndex: number,
): FrameDeletionTarget | undefined {
  const row = getFrameForDeletionStmt.get(
    participant,
    device,
    session,
    frameIndex,
  ) as
    | { file_path: string; deleted_at: number | null }
    | undefined;
  return row
    ? { filePath: row.file_path, deletedAt: row.deleted_at }
    : undefined;
}

// Serving gate: returns the face anonymization status for a frame identified by
// its on-disk path, scoped to the owner. Used by /frames to refuse a frame
// whose face has not been blurred yet. Returns undefined if no such row.
export function getFrameStatusByPath(
  participant: string,
  filePath: string,
): string | undefined {
  const row = frameStatusByPathStmt.get(participant, filePath) as
    | { face_status: string }
    | undefined;
  return row?.face_status;
}

export function softDeleteFrameRow(
  participant: string,
  device: string,
  session: number,
  frameIndex: number,
): boolean {
  return softDeleteFrameTx(participant, device, session, frameIndex);
}

// Lets a reconnecting phone continue a session's frame numbering instead of
// colliding with rows already written under the same (participant, device,
// session) key.
export function maxFrameIndex(
  participant: string,
  device: string,
  session: number,
): number {
  const row = maxFrameIndexStmt.get(participant, device, session) as {
    max_index: number;
  };
  return row.max_index;
}

export function insertFrame(row: FrameInsert): void {
  insertFrameTx(row);
}

// Closes 'filling' chunks whose newest frame arrived more than idleMs ago
// (the tail of a session that no later window will ever close). Called from
// the server's periodic sweep. Returns how many chunks were closed.
export function closeIdleChunks(idleMs: number): number {
  const now = Date.now();
  return closeIdleChunksStmt.run({ now, cutoff_ms: now - idleMs }).changes;
}

// The app's End-session signal: the participant deliberately stopped
// recording, so no more frames are coming — every still-filling chunk goes to
// the VLM immediately instead of waiting for the idle sweep.
export function closeFillingChunks(participant: string): number {
  return closeParticipantChunksStmt.run({ participant, now: Date.now() })
    .changes;
}

// Every chunk of one local day with the real frame bounds of its servable
// frames, ordered by window start. Windows are clock-aligned, so a chunk
// never straddles the local-midnight day boundary.
export function listChunksOnDay(
  participant: string,
  day: string,
): DayChunkRow[] {
  const { fromMs, toMs } = dayUtcRange(day);
  const rows = chunksInRangeStmt.all(participant, fromMs, toMs) as DayChunkRow[];
  return rows.filter((row) => dayKeyFromEpochMs(row.chunk_start_ms) === day);
}

export interface ExportQuery {
  participant: string;
  device: string;
  session: number;
}

// --- DRM: participants -------------------------------------------------------

export function getParticipant(username: string): ParticipantRow | undefined {
  return getParticipantStmt.get(username) as ParticipantRow | undefined;
}

// Creates the participants row if missing (condition_plan gets the schema
// default); never touches an existing row.
export function ensureParticipant(username: string): void {
  insertParticipantStmt.run(username, Date.now());
}

export function setArm(username: string, arm: StudyArm): void {
  ensureParticipant(username);
  updateArmStmt.run(arm, Date.now(), username);
}

// Profile upsert: occupation, work description and the daily schedule —
// deliberately never touches arm (that is provisioning state, not profile
// state).
export function upsertParticipantProfile(
  username: string,
  occupation: string,
  workDescription: string,
  wakeTime: string,
  bedTime: string,
): void {
  ensureParticipant(username);
  updateProfileStmt.run(
    occupation,
    workDescription,
    wakeTime,
    bedTime,
    Date.now(),
    username,
  );
}

export function setPushToken(username: string, pushToken: string): void {
  ensureParticipant(username);
  updatePushTokenStmt.run(pushToken, Date.now(), username);
}

export function setLastReminderDay(username: string, day: string): void {
  updateLastReminderDayStmt.run(day, username);
}

export function listPushParticipants(): ParticipantRow[] {
  return listPushParticipantsStmt.all() as ParticipantRow[];
}

// --- DRM: day aggregation ----------------------------------------------------

// Distinct local study days (>=1 frame) for a participant, ascending by day,
// with frame + VLM-pending counts. Day keys are computed in the study TZ from
// capture_epoch_ms (SQLite has no timezone support, so bucketing happens here;
// a participant's whole study is a few thousand rows).
export function aggregateFrameDays(participant: string): DayAggregate[] {
  const rows = frameDayStatsStmt.all(participant) as {
    capture_epoch_ms: number;
    face_status: string;
    chunk_status: string | null;
  }[];
  const byDay = new Map<string, DayAggregate>();
  for (const row of rows) {
    const day = dayKeyFromEpochMs(row.capture_epoch_ms);
    let aggregate = byDay.get(day);
    if (!aggregate) {
      aggregate = { day, frameCount: 0, vlmPendingCount: 0 };
      byDay.set(day, aggregate);
    }
    aggregate.frameCount += 1;
    // Pending = the frame's chunk has not reached a terminal state. Legacy
    // frames without a chunk (NULL) are frozen, never pending. A
    // face_status='failed' frame can never contribute to a chunk's VLM input,
    // so it must not count as pending — otherwise one failed blur could keep
    // an assisted day in "still processing" forever.
    if (
      row.chunk_status !== null &&
      row.chunk_status !== "done" &&
      row.chunk_status !== "failed" &&
      row.face_status !== "failed"
    ) {
      aggregate.vlmPendingCount += 1;
    }
  }
  return Array.from(byDay.values()).sort((a, b) => (a.day < b.day ? -1 : 1));
}

// Every frame of one local day, ordered by capture time. A conservative UTC
// range narrows the indexed scan; the exact local-day filter happens here.
export function listFramesOnDay(
  participant: string,
  day: string,
): DayFrameRow[] {
  const { fromMs, toMs } = dayUtcRange(day);
  const rows = framesInRangeStmt.all(participant, fromMs, toMs) as DayFrameRow[];
  return rows.filter((row) => dayKeyFromEpochMs(row.capture_epoch_ms) === day);
}

export function countFramesOnDay(participant: string, day: string): number {
  return listFramesOnDay(participant, day).length;
}

// The participant's most recent local date with >=1 frame — the candidate
// study day while no round is pinned yet (a Day-0 lab test run is superseded
// as soon as the real field day produces frames).
export function latestFrameDay(participant: string): string | undefined {
  const days = aggregateFrameDays(participant);
  return days.length > 0 ? days[days.length - 1].day : undefined;
}

// --- DRM: reconstructions + activities ---------------------------------------

export function getReconstruction(
  participant: string,
  round: number,
): ReconstructionRow | undefined {
  return getReconstructionStmt.get(participant, round) as
    | ReconstructionRow
    | undefined;
}

export function listActivities(
  participant: string,
  round: number,
): ActivityRow[] {
  return listActivitiesStmt.all(participant, round) as ActivityRow[];
}

// Atomic replace-all save of a round's activities (creates the
// reconstructions row on first save). With submit=true also locks the round
// and — assisted mode only — propagates each activity's labels onto the
// frames in its span; returns the submitted_at timestamp (null for drafts).
export function replaceActivities(options: {
  participant: string;
  round: number;
  mode: string;
  day: string;
  activities: ActivityWriteInput[];
  submit: boolean;
}): { submittedAt: number | null } {
  const submittedAt = replaceActivitiesTx(
    options.participant,
    options.round,
    options.mode,
    options.day,
    options.activities,
    options.submit,
    Date.now(),
  );
  return { submittedAt };
}

// Reconstructs a per-session CSV from the DB on demand (the DB is the live
// index now). CaptureDatetime is intentionally dropped (derive it from
// capture_epoch_ms if needed). NO vlm_* columns: participant-facing output
// must never carry VLM labels (DRM control-condition anti-leak; see ExportRow).
export function exportFramesCsv(q: ExportQuery): string {
  const rows = exportStmt.all(q) as ExportRow[];
  const header =
    "FrameIndex;CaptureEpochMs;ReceivedEpochMs;DeviceFrame;ByteLength;JpegOk;FilePath";
  const lines = rows.map((r) =>
    [
      r.frame_index,
      r.capture_epoch_ms,
      r.received_epoch_ms,
      r.device_frame ?? "",
      r.byte_length ?? "",
      r.jpeg_ok ?? "",
      r.file_path,
    ].join(";"),
  );
  return [header, ...lines].join("\n") + "\n";
}
