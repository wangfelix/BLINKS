import Database from "better-sqlite3";

import { dayKeyFromEpochMs, dayUtcRange } from "./time";

// ===========================================================================
// SQLite metadata store (recordings.db, WAL mode, via better-sqlite3).
//
// One row per ingested frame, written synchronously as the JPEG is received.
// The JPEG bytes stay on the filesystem under recordings/...; this table is the
// index over them, superseding the old per-session CSV. Five-minute VLM output
// lives on chunks, while participant reconstructions live in activity lists.
// See CLAUDE.md, "Storage and VLM metadata", for the rationale and full schema.
//
// DRM subproject additions (single-day, two-round design): participants,
// explicitly identified activity_lists (self response, immutable
// vlm_proposal, editable/final assisted response), and their activities.
// Recording start/pause/resume/end actions are an append-only event stream.
// ===========================================================================

// Inserted at ingestion time. VLM output is attached later to the frame's
// five-minute chunk, so it is deliberately absent from this shape.
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
// export is participant-facing (bearer token) and must never expose VLM output;
// the researcher reads recordings.db directly on the VM for analysis.
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
// VLM output before the assisted reconstruction.
export interface FrameRow {
  frame_index: number;
  capture_epoch_ms: number;
  file_path: string;
}

export interface FrameDeletionTarget {
  filePath: string;
  deletedAt: number | null;
}

// --- Recording lifecycle events ---------------------------------------------

export const RECORDING_EVENT_TYPES = [
  "start",
  "pause",
  "resume",
  "end",
] as const;
export type RecordingEventType = (typeof RECORDING_EVENT_TYPES)[number];

export interface RecordingEventInput {
  event_id: string;
  session: number;
  event_type: RecordingEventType;
  client_epoch_ms: number;
  sequence_number: number;
}

export interface RecordingEventRow extends RecordingEventInput {
  participant: string;
  server_received_epoch_ms: number;
}

export class RecordingEventConflictError extends Error {}

// --- DRM row shapes ---------------------------------------------------------

export interface ParticipantRow {
  username: string;
  occupation: string | null;
  work_description: string | null;
  wake_time: string | null; // "HH:MM" local study time, from app onboarding
  bed_time: string | null; // "HH:MM"; drives the fallback push reminder
  arm: string; // Legacy column retained for SQLite compatibility; workflow ignores it.
  push_token: string | null;
  last_reminder_day: string | null;
  created_at: number;
  updated_at: number | null;
}

export interface ActivityRow {
  id: number;
  activity_list_id: number;
  proposal_activity_id: number | null;
  position: number;
  start_ms: number;
  end_ms: number;
  raw_label: string | null;
  category_label: string | null; // 'work'|'break'|'other'
  source: string; // 'vlm'|'user'
  vlm_raw_label: string | null;
  vlm_category: string | null;
  // Genuine VLM confidence stays researcher-facing. presented_* records the
  // annotation initially placed in the assisted editor, which differs from
  // the genuine proposal only for an injected incorrect annotation.
  vlm_mean_activity_confidence: number | null;
  vlm_mean_activity_confidences_json: string | null;
  vlm_mean_category_confidence: number | null;
  vlm_mean_category_confidences_json: string | null;
  presented_raw_label: string | null;
  presented_category_label: string | null;
  is_incorrect_annotation_injected: number;
  // Experience ratings (7-point Likert, 1-7; NULL = not answered). Work
  // activities rate mental demand, breaks rate mental recovery.
  workload_rating: number | null;
  recovery_rating: number | null;
}

export const ACTIVITY_LIST_KINDS = [
  "self",
  "vlm_proposal",
  "assisted",
] as const;
export type ActivityListKind = (typeof ACTIVITY_LIST_KINDS)[number];

export interface ActivityListRow {
  id: number;
  participant: string;
  round: number;
  day: string;
  kind: ActivityListKind;
  immutable: number;
  status: "draft" | "submitted" | null;
  created_at: number;
  updated_at: number | null;
  first_opened_at: number | null;
  first_draft_saved_at: number | null;
  last_draft_saved_at: number | null;
  submitted_at: number | null;
  proposal_viewed_at: number | null;
}

export interface ActivityListSnapshot extends ActivityListRow {
  activities: ActivityRow[];
}

// Replace-all write shape. The DB assigns position from array order and derives
// every VLM/intervention field from the immutable proposal via the opaque
// proposal_activity_id (or an exact-span fallback for older clients).
export interface ActivityWriteInput {
  start_ms: number;
  end_ms: number;
  raw_label: string | null;
  category_label: string | null;
  source: "vlm" | "user";
  proposal_activity_id?: number | null;
  vlm_mean_activity_confidence?: number | null;
  vlm_mean_activity_confidences_json?: string | null;
  vlm_mean_category_confidence?: number | null;
  vlm_mean_category_confidences_json?: string | null;
  presented_raw_label?: string | null;
  presented_category_label?: string | null;
  is_incorrect_annotation_injected?: boolean;
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
  device: string;
  session: number;
  frame_index: number;
  capture_epoch_ms: number;
  file_path: string;
  face_status: string;
  chunk_status: string | null;
  vlm_label: string | null;
  vlm_category: string | null;
}

// Participant-facing frame audit metadata for photo management. Deleted rows
// deliberately keep their identity + timestamp but have no serving path.
export interface PhotoFrameRow {
  device: string;
  session: number;
  frame_index: number;
  capture_epoch_ms: number;
  file_path: string;
  deleted_at: number | null;
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

// One day's chunk as segmentation/bootstrap input. Initial reconstructed
// activities use these clock-aligned 5-minute bounds, not individual frames.
export interface DayChunkRow {
  chunk_start_ms: number;
  chunk_end_ms: number;
  status: string;
  vlm_label: string | null;
  vlm_category: string | null;
  vlm_activity_confidence: number | null;
  vlm_activity_confidences_json: string | null;
  vlm_category_confidence: number | null;
  vlm_category_confidences_json: string | null;
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
  vlm_activity_confidence: number | null;
  vlm_activity_confidences_json: string | null;
  vlm_category_confidence: number | null;
  vlm_category_confidences_json: string | null;
  vlm_completed_at: number | null;
  vlm_attempt_count: number;
  vlm_retry_count: number;
  vlm_next_attempt_at: number | null;
  vlm_last_error_type: string | null;
  created_at: number;
  updated_at: number | null;
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
let closeSessionChunksStmt: Database.Statement;
let chunksInRangeStmt: Database.Statement;
let getFrameChunkStmt: Database.Statement;
let decrementChunkStmt: Database.Statement;
let deleteEmptyChunkStmt: Database.Statement;
let insertFrameTx: Database.Transaction<(row: FrameInsert) => void>;
let softDeleteFrameTx: Database.Transaction<
  (participant: string, device: string, session: number, frameIndex: number) => boolean
>;

// Recording lifecycle event statements
let getRecordingEventByIdStmt: Database.Statement;
let getRecordingEventBySequenceStmt: Database.Statement;
let insertRecordingEventStmt: Database.Statement;
let latestRecordingEventStmt: Database.Statement;
let listPausedParticipantsStmt: Database.Statement;
let recordRecordingEventTx: Database.Transaction<
  (
    participant: string,
    event: RecordingEventInput,
    serverReceivedEpochMs: number,
  ) => RecordingEventRow
>;

// DRM statements
let getParticipantStmt: Database.Statement;
let insertParticipantStmt: Database.Statement;
let updateProfileStmt: Database.Statement;
let updatePushTokenStmt: Database.Statement;
let updateLastReminderDayStmt: Database.Statement;
let listPushParticipantsStmt: Database.Statement;
let frameDayStatsStmt: Database.Statement;
let framesInRangeStmt: Database.Statement;
let photoFramesInRangeStmt: Database.Statement;
let getRoundResponseListStmt: Database.Statement;
let insertRoundResponseListStmt: Database.Statement;
let markFirstOpenedStmt: Database.Statement;
let markDraftSavedStmt: Database.Statement;
let markSubmittedStmt: Database.Statement;
let markVlmProposalViewedStmt: Database.Statement;
let listActivitiesStmt: Database.Statement;
let listActivitiesByKindStmt: Database.Statement;
let getActivityListStmt: Database.Statement;
let listActivityListsForDayStmt: Database.Statement;
let upsertEditableActivityListStmt: Database.Statement;
let insertVlmProposalListStmt: Database.Statement;
let listVlmSpanActivitiesStmt: Database.Statement;
let deleteActivitiesStmt: Database.Statement;
let insertActivityStmt: Database.Statement;
let createVlmProposalTx: Database.Transaction<
  (
    participant: string,
    round: number,
    day: string,
    activities: ActivityWriteInput[],
    now: number,
  ) => boolean
>;
let replaceActivitiesTx: Database.Transaction<
  (
    participant: string,
    round: number,
    day: string,
    activities: ActivityWriteInput[],
    submit: boolean,
    recordDraftSave: boolean,
    now: number,
  ) => number | null
>;

// Adds a column only if it is missing, so an existing recordings.db is
// upgraded in place without losing rows. Must be called after the table exists.
function migrateAddTableColumn(
  table: string,
  column: string,
  ddl: string,
): void {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as {
    name: string;
  }[];
  if (!cols.some((c) => c.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl}`);
  }
}

const migrateAddFrameColumn = (column: string, ddl: string): void =>
  migrateAddTableColumn("frames", column, ddl);

function tableHasColumn(table: string, column: string): boolean {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as {
    name: string;
  }[];
  return cols.some((candidate) => candidate.name === column);
}

function tableExists(table: string): boolean {
  return (db.prepare(`PRAGMA table_info(${table})`).all() as unknown[]).length > 0;
}

// Remove retired or derived columns rather than retaining duplicate research
// data in fresh or upgraded databases.
function migrateDropColumn(table: string, column: string): void {
  if (tableExists(table) && tableHasColumn(table, column)) {
    db.exec(`ALTER TABLE ${table} DROP COLUMN ${column}`);
  }
}

export function initDb(dbPath: string): void {
  db = new Database(dbPath);
  // Schema upgrades may rebuild the DRM parent/child tables. Foreign-key
  // enforcement must be disabled outside that transaction, then is enabled
  // and checked before any prepared statement can use the database.
  db.pragma("foreign_keys = OFF");
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
  `);

  // Migrate DBs created before the face_* columns existed (the columns are part
  // of the CREATE above for fresh DBs; ALTER adds them to existing ones). Every
  // pre-existing row gets face_status='pending', so the worker backfills them.
  migrateAddFrameColumn(
    "face_status",
    "face_status TEXT NOT NULL DEFAULT 'pending'",
  );
  migrateAddFrameColumn("face_count", "face_count INTEGER");
  migrateAddFrameColumn("face_method", "face_method TEXT");
  migrateAddFrameColumn("face_completed_at", "face_completed_at INTEGER");
  migrateAddFrameColumn("deleted_at", "deleted_at INTEGER");

  // Recreate the face-processing index after the migration so older databases
  // do not keep indexing soft-deleted work as pending. The retired per-frame
  // VLM index must be dropped before its source column is removed below.
  db.exec(`
    DROP INDEX IF EXISTS idx_frames_pending;
    DROP INDEX IF EXISTS idx_frames_face_pending;
    CREATE INDEX idx_frames_face_pending
      ON frames (capture_epoch_ms)
      WHERE face_status = 'pending' AND deleted_at IS NULL;
    CREATE INDEX IF NOT EXISTS idx_frames_deleted
      ON frames (participant, deleted_at)
      WHERE deleted_at IS NOT NULL;
  `);

  // Every frame knows its clock-aligned 5-minute window. NULL marks a row
  // ingested before chunking existed; it remains available as frame metadata
  // but has no current VLM result.
  migrateAddFrameColumn("chunk_start_ms", "chunk_start_ms INTEGER");
  db.transaction(() => {
    [
      "vlm_status",
      "vlm_model",
      "vlm_label",
      "vlm_category",
      "vlm_description",
      "vlm_descriptor",
      "vlm_completed_at",
      "user_corrected_activity_label",
      "user_corrected_category_label",
    ].forEach((column) => migrateDropColumn("frames", column));
  })();
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
      -- Black-box VLM self-report: argmax scalar plus each normalized
      -- probability distribution serialized as JSON for exploratory analysis.
      vlm_activity_confidence REAL,
      vlm_activity_confidences_json TEXT,
      vlm_category_confidence REAL,
      vlm_category_confidences_json TEXT,
      vlm_completed_at INTEGER,
      -- Retry scheduling stays on the chunk; immutable per-attempt evidence is
      -- retained separately in vlm_attempts for later reliability analysis.
      vlm_attempt_count INTEGER NOT NULL DEFAULT 0,
      vlm_retry_count INTEGER NOT NULL DEFAULT 0,
      vlm_next_attempt_at INTEGER,
      vlm_last_error_type TEXT,
      created_at      INTEGER NOT NULL,
      updated_at      INTEGER,
      PRIMARY KEY (participant, chunk_start_ms)
    );
    CREATE INDEX IF NOT EXISTS idx_chunks_status
      ON chunks (status, chunk_start_ms);
  `);
  migrateAddTableColumn(
    "chunks",
    "vlm_activity_confidence",
    "vlm_activity_confidence REAL",
  );
  migrateAddTableColumn(
    "chunks",
    "vlm_activity_confidences_json",
    "vlm_activity_confidences_json TEXT",
  );
  migrateAddTableColumn(
    "chunks",
    "vlm_category_confidence",
    "vlm_category_confidence REAL",
  );
  migrateAddTableColumn(
    "chunks",
    "vlm_category_confidences_json",
    "vlm_category_confidences_json TEXT",
  );
  migrateAddTableColumn(
    "chunks",
    "vlm_attempt_count",
    "vlm_attempt_count INTEGER NOT NULL DEFAULT 0",
  );
  migrateAddTableColumn(
    "chunks",
    "vlm_retry_count",
    "vlm_retry_count INTEGER NOT NULL DEFAULT 0",
  );
  migrateAddTableColumn(
    "chunks",
    "vlm_next_attempt_at",
    "vlm_next_attempt_at INTEGER",
  );
  migrateAddTableColumn(
    "chunks",
    "vlm_last_error_type",
    "vlm_last_error_type TEXT",
  );
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_chunks_vlm_queue
      ON chunks (status, vlm_next_attempt_at, chunk_start_ms);
    CREATE TABLE IF NOT EXISTS vlm_attempts (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      participant     TEXT    NOT NULL,
      chunk_start_ms  INTEGER NOT NULL,
      attempt_number  INTEGER NOT NULL,
      retry_number    INTEGER NOT NULL,
      model           TEXT    NOT NULL,
      started_at      INTEGER NOT NULL,
      completed_at    INTEGER,
      duration_ms     INTEGER,
      frames_sent     INTEGER NOT NULL,
      timeout_seconds REAL    NOT NULL,
      outcome         TEXT
        CHECK (outcome IS NULL OR outcome IN (
          'done', 'timeout', 'rate_limit', 'server_error', 'api_error',
          'validation_error', 'input_error', 'interrupted'
        )),
      error_class     TEXT,
      http_status     INTEGER,
      -- Deliberately no chunks FK: deleting a chunk after its last photo is
      -- removed must not erase non-image reliability evidence used in analysis.
      UNIQUE (participant, chunk_start_ms, attempt_number)
    );
    CREATE INDEX IF NOT EXISTS idx_vlm_attempts_chunk
      ON vlm_attempts (participant, chunk_start_ms, attempt_number);
    CREATE INDEX IF NOT EXISTS idx_vlm_attempts_outcome
      ON vlm_attempts (outcome, started_at);
  `);
  db.transaction(() => {
    [
      "vlm_description",
      "vlm_descriptor",
      "user_corrected_activity_label",
      "user_corrected_category_label",
    ].forEach((column) => migrateDropColumn("chunks", column));
  })();

  // Raw recording lifecycle events are append-only. Client time records the
  // participant's tap; server time makes delivery delay and offline retries
  // auditable. The two uniqueness constraints make retries idempotent.
  db.exec(`
    CREATE TABLE IF NOT EXISTS recording_events (
      participant              TEXT    NOT NULL,
      event_id                 TEXT    NOT NULL,
      session                  INTEGER NOT NULL,
      event_type               TEXT    NOT NULL
        CHECK (event_type IN ('start', 'pause', 'resume', 'end')),
      client_epoch_ms          INTEGER NOT NULL,
      server_received_epoch_ms INTEGER NOT NULL,
      sequence_number          INTEGER NOT NULL,
      PRIMARY KEY (participant, event_id),
      UNIQUE (participant, session, sequence_number)
    );
    CREATE INDEX IF NOT EXISTS idx_recording_events_session
      ON recording_events (participant, session, sequence_number);
  `);

  // DRM schema discovery. Workflow state used to live in a separate
  // reconstructions table; the final model moves it onto the response-list
  // parent so an opened-but-empty round still has one durable identity.
  if (tableExists("participants") && !tableHasColumn("participants", "arm")) {
    db.exec(`DROP TABLE participants;`);
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
  `);

  const reconstructionsExist = tableExists("reconstructions");
  if (
    reconstructionsExist &&
    !tableHasColumn("reconstructions", "round")
  ) {
    throw new Error(
      "cannot safely migrate the obsolete pre-round reconstructions schema",
    );
  }

  const activityListsSchema = `
    CREATE TABLE activity_lists (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      participant  TEXT NOT NULL,
      round        INTEGER NOT NULL,
      day          TEXT NOT NULL,
      -- The list role is the workflow truth: round 1 has a self response;
      -- round 2 has an immutable proposal plus an assisted response.
      kind         TEXT NOT NULL CHECK (kind IN ('self', 'vlm_proposal', 'assisted')),
      immutable    INTEGER NOT NULL DEFAULT 0 CHECK (immutable IN (0, 1)),
      status       TEXT CHECK (status IN ('draft', 'submitted')),
      created_at   INTEGER NOT NULL,
      updated_at   INTEGER,
      first_opened_at INTEGER,
      first_draft_saved_at INTEGER,
      last_draft_saved_at INTEGER,
      submitted_at INTEGER,
      proposal_viewed_at INTEGER,
      CHECK (
        (round = 1 AND kind = 'self')
        OR
        (round = 2 AND kind IN ('vlm_proposal', 'assisted'))
      ),
      CHECK (
        (kind = 'vlm_proposal' AND immutable = 1 AND status IS NULL
          AND first_opened_at IS NULL
          AND first_draft_saved_at IS NULL
          AND last_draft_saved_at IS NULL
          AND submitted_at IS NULL)
        OR
        (kind != 'vlm_proposal' AND immutable = 0 AND status IS NOT NULL
          AND proposal_viewed_at IS NULL)
      ),
      UNIQUE (participant, round, kind)
    )
  `;
  const activitiesSchema = `
    CREATE TABLE activities (
      id               INTEGER PRIMARY KEY AUTOINCREMENT,
      activity_list_id INTEGER NOT NULL,
      proposal_activity_id INTEGER,
      position         INTEGER NOT NULL,
      start_ms         INTEGER NOT NULL,
      end_ms           INTEGER NOT NULL,
      raw_label        TEXT,
      category_label   TEXT,
      source           TEXT NOT NULL,
      vlm_raw_label    TEXT,
      vlm_category     TEXT,
      vlm_mean_activity_confidence REAL
        CHECK (vlm_mean_activity_confidence IS NULL OR
               vlm_mean_activity_confidence BETWEEN 0 AND 1),
      vlm_mean_activity_confidences_json TEXT,
      vlm_mean_category_confidence REAL
        CHECK (vlm_mean_category_confidence IS NULL OR
               vlm_mean_category_confidence BETWEEN 0 AND 1),
      vlm_mean_category_confidences_json TEXT,
      presented_raw_label TEXT,
      presented_category_label TEXT,
      is_incorrect_annotation_injected INTEGER NOT NULL DEFAULT 0
        CHECK (is_incorrect_annotation_injected IN (0, 1)),
      workload_rating INTEGER,
      recovery_rating INTEGER,
      created_at       INTEGER NOT NULL,
      updated_at       INTEGER,
      FOREIGN KEY (activity_list_id)
        REFERENCES activity_lists(id) ON DELETE CASCADE,
      FOREIGN KEY (proposal_activity_id)
        REFERENCES activities(id) ON DELETE SET NULL
    )
  `;

  const activityListsExist = tableExists("activity_lists");
  const activitiesExist = tableExists("activities");
  const parentIdColumn = activityListsExist
    ? (
        db.prepare(`PRAGMA table_info(activity_lists)`).all() as {
          name: string;
          pk: number;
        }[]
      ).find((column) => column.name === "id")
    : undefined;
  const parentHasId = parentIdColumn?.pk === 1;
  const childHasForeignKey =
    activitiesExist && tableHasColumn("activities", "activity_list_id");
  const childForeignKeys = activitiesExist
    ? (db.prepare(`PRAGMA foreign_key_list(activities)`).all() as {
        table: string;
        from: string;
        to: string;
        on_delete: string;
      }[])
    : [];
  const childHasParentForeignKey =
    childHasForeignKey &&
    childForeignKeys.some(
      (foreignKey) =>
        foreignKey.table === "activity_lists" &&
        foreignKey.from === "activity_list_id" &&
        foreignKey.to === "id" &&
        foreignKey.on_delete.toUpperCase() === "CASCADE",
    );
  const childHasProposalForeignKey = childForeignKeys.some(
    (foreignKey) =>
      foreignKey.table === "activities" &&
      foreignKey.from === "proposal_activity_id" &&
      foreignKey.to === "id" &&
      foreignKey.on_delete.toUpperCase() === "SET NULL",
  );
  const childHasRedundantIdentity =
    activitiesExist &&
    (tableHasColumn("activities", "participant") ||
      tableHasColumn("activities", "round") ||
      tableHasColumn("activities", "list_kind"));
  const childHasInterventionContract =
    activitiesExist &&
    [
      "proposal_activity_id",
      "vlm_mean_activity_confidence",
      "vlm_mean_activity_confidences_json",
      "vlm_mean_category_confidence",
      "vlm_mean_category_confidences_json",
      "presented_raw_label",
      "presented_category_label",
      "is_incorrect_annotation_injected",
    ].every((column) => tableHasColumn("activities", column));
  const parentHasFinalWorkflow =
    activityListsExist &&
    [
      "status",
      "first_opened_at",
      "first_draft_saved_at",
      "last_draft_saved_at",
      "submitted_at",
      "proposal_viewed_at",
    ].every((column) => tableHasColumn("activity_lists", column)) &&
    !tableHasColumn("activity_lists", "mode");

  if (!activityListsExist && !activitiesExist && !reconstructionsExist) {
    db.exec(`${activityListsSchema}; ${activitiesSchema};`);
  } else if (
    reconstructionsExist ||
    !parentHasId ||
    !parentHasFinalWorkflow ||
    !childHasForeignKey ||
    !childHasParentForeignKey ||
    !childHasInterventionContract ||
    !childHasProposalForeignKey ||
    childHasRedundantIdentity
  ) {
    // SQLite cannot add a primary key or foreign key with ALTER TABLE. Rebuild
    // both tables transactionally, preserving IDs where they already exist.
    // This handles, in one atomic migration:
    //   1. legacy activities keyed only by participant+round;
    //   2. the natural-key three-list implementation (activities.list_kind);
    //   3. the parent/child implementation plus reconstructions workflow;
    //   4. a partially upgraded parent/child schema.
    const parentHasUpdatedAt =
      activityListsExist && tableHasColumn("activity_lists", "updated_at");
    const parentHasStatus =
      activityListsExist && tableHasColumn("activity_lists", "status");
    const parentHasFirstOpened =
      activityListsExist && tableHasColumn("activity_lists", "first_opened_at");
    const parentHasFirstDraftSaved =
      activityListsExist &&
      tableHasColumn("activity_lists", "first_draft_saved_at");
    const parentHasLastDraftSaved =
      activityListsExist &&
      tableHasColumn("activity_lists", "last_draft_saved_at");
    const parentHasSubmitted =
      activityListsExist && tableHasColumn("activity_lists", "submitted_at");
    const parentHasProposalViewedAt =
      activityListsExist &&
      tableHasColumn("activity_lists", "proposal_viewed_at");
    const reconstructionHasFirstOpened =
      reconstructionsExist &&
      tableHasColumn("reconstructions", "first_opened_at");
    const reconstructionHasFirstDraftSaved =
      reconstructionsExist &&
      tableHasColumn("reconstructions", "first_draft_saved_at");
    const reconstructionHasLastDraftSaved =
      reconstructionsExist &&
      tableHasColumn("reconstructions", "last_draft_saved_at");
    const childHasListKind =
      activitiesExist && tableHasColumn("activities", "list_kind");
    const childHasWorkload =
      activitiesExist && tableHasColumn("activities", "workload_rating");
    const childHasRecovery =
      activitiesExist && tableHasColumn("activities", "recovery_rating");
    const childHasUpdatedAt =
      activitiesExist && tableHasColumn("activities", "updated_at");
    const childHasProposalActivityId =
      activitiesExist && tableHasColumn("activities", "proposal_activity_id");
    const childHasMeanConfidence =
      activitiesExist &&
      tableHasColumn("activities", "vlm_mean_activity_confidence");
    const childHasMeanConfidencesJson =
      activitiesExist &&
      tableHasColumn("activities", "vlm_mean_activity_confidences_json");
    const childHasMeanCategoryConfidence =
      activitiesExist &&
      tableHasColumn("activities", "vlm_mean_category_confidence");
    const childHasMeanCategoryConfidencesJson =
      activitiesExist &&
      tableHasColumn("activities", "vlm_mean_category_confidences_json");
    const childHasPresentedRawLabel =
      activitiesExist && tableHasColumn("activities", "presented_raw_label");
    const childHasPresentedCategoryLabel =
      activitiesExist &&
      tableHasColumn("activities", "presented_category_label");
    const childHasInjectedMarker =
      activitiesExist &&
      tableHasColumn("activities", "is_incorrect_annotation_injected");
    const legacyActivityCount = activitiesExist
      ? (
          db.prepare(`SELECT COUNT(*) AS count FROM activities`).get() as {
            count: number;
          }
        ).count
      : 0;

    if (activityListsExist) {
      const conflictingParents = db
        .prepare(`
          SELECT participant, round,
                 CASE WHEN round = 1 THEN 'self'
                      WHEN kind = 'vlm_proposal' THEN 'vlm_proposal'
                      ELSE 'assisted' END AS target_kind,
                 COUNT(*) AS count
          FROM activity_lists
          GROUP BY participant, round, target_kind
          HAVING COUNT(*) > 1
        `)
        .all() as {
        participant: string;
        round: number;
        target_kind: string;
        count: number;
      }[];
      if (conflictingParents.length > 0) {
        const conflict = conflictingParents[0];
        throw new Error(
          `cannot merge ${conflict.count} activity lists into ` +
            `${conflict.participant}/round ${conflict.round}/${conflict.target_kind}`,
        );
      }
    }

    db.exec("BEGIN IMMEDIATE");
    try {
      db.exec(`
        DROP INDEX IF EXISTS idx_activities_round;
        DROP INDEX IF EXISTS idx_activities_list_position;
        DROP INDEX IF EXISTS idx_activities_parent;
        DROP INDEX IF EXISTS idx_activities_proposal_origin;
        DROP INDEX IF EXISTS idx_activity_lists_day;
        DROP INDEX IF EXISTS idx_activity_lists_response;
      `);
      if (activityListsExist) {
        db.exec(`ALTER TABLE activity_lists RENAME TO activity_lists_legacy`);
      }
      if (activitiesExist) {
        db.exec(`ALTER TABLE activities RENAME TO activities_legacy`);
      }
      if (reconstructionsExist) {
        db.exec(`ALTER TABLE reconstructions RENAME TO reconstructions_legacy`);
      }
      db.exec(`${activityListsSchema}; ${activitiesSchema};`);

      if (activityListsExist) {
        const idColumn = parentHasId ? "id, " : "";
        const idValue = parentHasId ? "id, " : "";
        const updatedAtValue = parentHasUpdatedAt
          ? "p.updated_at"
          : "p.created_at";
        const kindValue =
          "CASE WHEN p.round = 1 THEN 'self' " +
          "WHEN p.kind = 'vlm_proposal' THEN 'vlm_proposal' ELSE 'assisted' END";
        const reconstructionJoin = reconstructionsExist
          ? `LEFT JOIN reconstructions_legacy r
               ON r.participant = p.participant AND r.round = p.round`
          : "";
        const reconstructionStatus = reconstructionsExist
          ? "r.status"
          : "NULL";
        const statusValue = parentHasStatus
          ? reconstructionsExist
            ? "COALESCE(p.status, r.status)"
            : "p.status"
          : reconstructionStatus;
        const firstOpenedValue = parentHasFirstOpened
          ? reconstructionHasFirstOpened
            ? "COALESCE(p.first_opened_at, r.first_opened_at)"
            : "p.first_opened_at"
          : reconstructionHasFirstOpened
            ? "r.first_opened_at"
            : "NULL";
        const firstDraftSavedValue = parentHasFirstDraftSaved
          ? reconstructionHasFirstDraftSaved
            ? "COALESCE(p.first_draft_saved_at, r.first_draft_saved_at)"
            : "p.first_draft_saved_at"
          : reconstructionHasFirstDraftSaved
            ? "r.first_draft_saved_at"
            : "NULL";
        const lastDraftSavedValue = parentHasLastDraftSaved
          ? reconstructionHasLastDraftSaved
            ? "COALESCE(p.last_draft_saved_at, r.last_draft_saved_at)"
            : "p.last_draft_saved_at"
          : reconstructionHasLastDraftSaved
            ? "r.last_draft_saved_at"
            : "NULL";
        const submittedValue = parentHasSubmitted
          ? reconstructionsExist
            ? "COALESCE(p.submitted_at, r.submitted_at)"
            : "p.submitted_at"
          : reconstructionsExist
            ? "r.submitted_at"
            : "NULL";
        const proposalViewedAtValue = parentHasProposalViewedAt
          ? "p.proposal_viewed_at"
          : "NULL";
        db.exec(`
          INSERT INTO activity_lists (
            ${idColumn}participant, round, day, kind, immutable, status,
            created_at, updated_at, first_opened_at,
            first_draft_saved_at, last_draft_saved_at, submitted_at,
            proposal_viewed_at
          )
          SELECT ${idValue}p.participant, p.round, p.day, ${kindValue},
                 CASE WHEN ${kindValue} = 'vlm_proposal' THEN 1 ELSE 0 END,
                 CASE WHEN ${kindValue} = 'vlm_proposal' THEN NULL
                      ELSE COALESCE(${statusValue}, 'draft') END,
                 p.created_at, ${updatedAtValue},
                 CASE WHEN ${kindValue} = 'vlm_proposal' THEN NULL
                      ELSE ${firstOpenedValue} END,
                 CASE WHEN ${kindValue} = 'vlm_proposal' THEN NULL
                      ELSE ${firstDraftSavedValue} END,
                 CASE WHEN ${kindValue} = 'vlm_proposal' THEN NULL
                      ELSE ${lastDraftSavedValue} END,
                 CASE WHEN ${kindValue} = 'vlm_proposal' THEN NULL
                      ELSE ${submittedValue} END,
                 CASE WHEN ${kindValue} = 'vlm_proposal'
                      THEN ${proposalViewedAtValue} ELSE NULL END
          FROM activity_lists_legacy p
          ${reconstructionJoin}
        `);
      }

      if (reconstructionsExist) {
        const firstOpenedValue = reconstructionHasFirstOpened
          ? "first_opened_at"
          : "NULL";
        const firstDraftSavedValue = reconstructionHasFirstDraftSaved
          ? "first_draft_saved_at"
          : "NULL";
        const lastDraftSavedValue = reconstructionHasLastDraftSaved
          ? "last_draft_saved_at"
          : "NULL";
        // Every legacy reconstruction becomes its participant-facing response
        // list, including opened/submitted rounds with zero activity children.
        db.exec(`
          INSERT OR IGNORE INTO activity_lists (
            participant, round, day, kind, immutable, status,
            created_at, updated_at, first_opened_at,
            first_draft_saved_at, last_draft_saved_at, submitted_at,
            proposal_viewed_at
          )
          SELECT participant, round, day,
                 CASE WHEN round = 1 THEN 'self' ELSE 'assisted' END,
                 0, status, created_at, COALESCE(submitted_at, created_at),
                 ${firstOpenedValue}, ${firstDraftSavedValue},
                 ${lastDraftSavedValue}, submitted_at, NULL
          FROM reconstructions_legacy
          WHERE round IN (1, 2)
        `);
      }

      if (activitiesExist) {
        const workloadValue = childHasWorkload
          ? "a.workload_rating"
          : "NULL";
        const recoveryValue = childHasRecovery
          ? "a.recovery_rating"
          : "NULL";
        const updatedAtValue = childHasUpdatedAt ? "a.updated_at" : "a.created_at";
        const proposalActivityIdValue = childHasProposalActivityId
          ? "a.proposal_activity_id"
          : "NULL";
        const meanConfidenceValue = childHasMeanConfidence
          ? "a.vlm_mean_activity_confidence"
          : "NULL";
        const meanConfidencesJsonValue = childHasMeanConfidencesJson
          ? "a.vlm_mean_activity_confidences_json"
          : "NULL";
        const meanCategoryConfidenceValue = childHasMeanCategoryConfidence
          ? "a.vlm_mean_category_confidence"
          : "NULL";
        const meanCategoryConfidencesJsonValue =
          childHasMeanCategoryConfidencesJson
            ? "a.vlm_mean_category_confidences_json"
            : "NULL";
        const presentedRawLabelValue = childHasPresentedRawLabel
          ? "a.presented_raw_label"
          : "CASE WHEN a.source = 'vlm' THEN a.raw_label ELSE NULL END";
        const presentedCategoryLabelValue = childHasPresentedCategoryLabel
          ? "a.presented_category_label"
          : "CASE WHEN a.source = 'vlm' THEN a.category_label ELSE NULL END";
        const injectedMarkerValue = childHasInjectedMarker
          ? "a.is_incorrect_annotation_injected"
          : "0";
        let relationshipJoin: string;
        let activityListIdValue: string;
        if (childHasForeignKey) {
          relationshipJoin = "";
          activityListIdValue = "a.activity_list_id";
        } else if (childHasListKind) {
          relationshipJoin = `
            JOIN activity_lists l
              ON l.participant = a.participant
             AND l.round = a.round
             AND l.kind = CASE
               WHEN a.round = 1 THEN 'self'
               WHEN a.list_kind = 'vlm_proposal' THEN 'vlm_proposal'
               ELSE 'assisted'
             END
          `;
          activityListIdValue = "l.id";
        } else {
          if (!reconstructionsExist) {
            throw new Error(
              "participant/round activities require legacy reconstruction metadata",
            );
          }
          relationshipJoin = `
            JOIN reconstructions_legacy r
              ON r.participant = a.participant AND r.round = a.round
            JOIN activity_lists l
              ON l.participant = a.participant
             AND l.round = a.round
             AND l.kind = CASE WHEN a.round = 1 THEN 'self' ELSE 'assisted' END
          `;
          activityListIdValue = "l.id";
        }
        db.exec(`
          INSERT INTO activities (
            id, activity_list_id, proposal_activity_id,
            position, start_ms, end_ms,
            raw_label, category_label, source, vlm_raw_label, vlm_category,
            vlm_mean_activity_confidence,
            vlm_mean_activity_confidences_json,
            vlm_mean_category_confidence,
            vlm_mean_category_confidences_json,
            presented_raw_label, presented_category_label,
            is_incorrect_annotation_injected,
            workload_rating, recovery_rating, created_at, updated_at
          )
          SELECT a.id, ${activityListIdValue}, ${proposalActivityIdValue},
                 a.position, a.start_ms, a.end_ms,
                 a.raw_label, a.category_label, a.source,
                 a.vlm_raw_label, a.vlm_category,
                 ${meanConfidenceValue}, ${meanConfidencesJsonValue},
                 ${meanCategoryConfidenceValue},
                 ${meanCategoryConfidencesJsonValue},
                 ${presentedRawLabelValue}, ${presentedCategoryLabelValue},
                 ${injectedMarkerValue},
                 ${workloadValue}, ${recoveryValue},
                 a.created_at, ${updatedAtValue}
          FROM activities_legacy a
          ${relationshipJoin}
          ORDER BY
            CASE WHEN ${proposalActivityIdValue} IS NULL THEN 0 ELSE 1 END,
            a.id
        `);
      }

      const migratedActivityCount = (
        db.prepare(`SELECT COUNT(*) AS count FROM activities`).get() as {
          count: number;
        }
      ).count;
      if (migratedActivityCount !== legacyActivityCount) {
        throw new Error(
          `activity-list migration preserved ${migratedActivityCount}/${legacyActivityCount} activities`,
        );
      }

      if (reconstructionsExist) {
        const unmappedReconstructions = (
          db.prepare(`
            SELECT COUNT(*) AS count
            FROM reconstructions_legacy r
            LEFT JOIN activity_lists l
              ON l.participant = r.participant
             AND l.round = r.round
             AND l.kind = CASE WHEN r.round = 1 THEN 'self' ELSE 'assisted' END
            WHERE l.id IS NULL
          `).get() as { count: number }
        ).count;
        if (unmappedReconstructions !== 0) {
          throw new Error(
            `${unmappedReconstructions} reconstruction row(s) could not be migrated`,
          );
        }
      }

      if (activitiesExist) db.exec(`DROP TABLE activities_legacy`);
      if (activityListsExist) db.exec(`DROP TABLE activity_lists_legacy`);
      if (reconstructionsExist) db.exec(`DROP TABLE reconstructions_legacy`);
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  }

  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_activities_parent
      ON activities (activity_list_id, position);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_activities_list_position
      ON activities (activity_list_id, position);
    CREATE INDEX IF NOT EXISTS idx_activities_proposal_origin
      ON activities (proposal_activity_id)
      WHERE proposal_activity_id IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_activity_lists_day
      ON activity_lists (participant, day, round, kind);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_activity_lists_response
      ON activity_lists (participant, round)
      WHERE kind != 'vlm_proposal';
  `);
  db.pragma("foreign_keys = ON");
  const foreignKeyViolations = db.pragma("foreign_key_check") as unknown[];
  if (foreignKeyViolations.length > 0) {
    throw new Error(
      `activity-list migration left ${foreignKeyViolations.length} foreign-key violation(s)`,
    );
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

  // The app's explicit End-session event closes only chunks containing frames
  // from that recording session. A delayed retry from an older session must
  // never close the participant's newer recording.
  closeSessionChunksStmt = db.prepare(`
    UPDATE chunks SET status = 'ready', updated_at = @now
    WHERE participant = @participant AND status = 'filling'
      AND EXISTS (
        SELECT 1 FROM frames f
        WHERE f.participant = chunks.participant
          AND f.chunk_start_ms = chunks.chunk_start_ms
          AND f.session = @session
      )
  `);

  chunksInRangeStmt = db.prepare(`
    SELECT c.chunk_start_ms, c.chunk_end_ms, c.status,
           c.vlm_label, c.vlm_category,
           c.vlm_activity_confidence,
           c.vlm_activity_confidences_json,
           c.vlm_category_confidence,
           c.vlm_category_confidences_json,
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

  // --- Recording lifecycle event statements --------------------------------

  getRecordingEventByIdStmt = db.prepare(`
    SELECT participant, event_id, session, event_type, client_epoch_ms,
           server_received_epoch_ms, sequence_number
    FROM recording_events
    WHERE participant = ? AND event_id = ?
  `);

  getRecordingEventBySequenceStmt = db.prepare(`
    SELECT participant, event_id, session, event_type, client_epoch_ms,
           server_received_epoch_ms, sequence_number
    FROM recording_events
    WHERE participant = ? AND session = ? AND sequence_number = ?
  `);

  insertRecordingEventStmt = db.prepare(`
    INSERT INTO recording_events (
      participant, event_id, session, event_type, client_epoch_ms,
      server_received_epoch_ms, sequence_number
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
  `);

  latestRecordingEventStmt = db.prepare(`
    SELECT participant, event_id, session, event_type, client_epoch_ms,
           server_received_epoch_ms, sequence_number
    FROM recording_events
    WHERE participant = ?
    ORDER BY session DESC, sequence_number DESC
    LIMIT 1
  `);

  listPausedParticipantsStmt = db.prepare(`
    SELECT participant FROM (
      SELECT participant, event_type,
             ROW_NUMBER() OVER (
               PARTITION BY participant
               ORDER BY session DESC, sequence_number DESC
             ) AS recency
      FROM recording_events
    )
    WHERE recency = 1 AND event_type = 'pause'
    ORDER BY participant
  `);

  recordRecordingEventTx = db.transaction(
    (
      participant: string,
      event: RecordingEventInput,
      serverReceivedEpochMs: number,
    ): RecordingEventRow => {
      const byId = getRecordingEventByIdStmt.get(
        participant,
        event.event_id,
      ) as RecordingEventRow | undefined;
      const bySequence = getRecordingEventBySequenceStmt.get(
        participant,
        event.session,
        event.sequence_number,
      ) as RecordingEventRow | undefined;
      const existing = byId ?? bySequence;

      if (existing) {
        const identical =
          existing.event_id === event.event_id &&
          existing.session === event.session &&
          existing.event_type === event.event_type &&
          existing.client_epoch_ms === event.client_epoch_ms &&
          existing.sequence_number === event.sequence_number;
        if (!identical) {
          throw new RecordingEventConflictError(
            "recording event identity conflicts with an existing event",
          );
        }
        return existing;
      }

      insertRecordingEventStmt.run(
        participant,
        event.event_id,
        event.session,
        event.event_type,
        event.client_epoch_ms,
        serverReceivedEpochMs,
        event.sequence_number,
      );
      return getRecordingEventByIdStmt.get(
        participant,
        event.event_id,
      ) as RecordingEventRow;
    },
  );

  // --- DRM statements --------------------------------------------------------

  getParticipantStmt = db.prepare(`
    SELECT username, occupation, work_description, wake_time, bed_time, arm,
           push_token, last_reminder_day, created_at, updated_at
    FROM participants WHERE username = ?
  `);

  insertParticipantStmt = db.prepare(`
    INSERT OR IGNORE INTO participants (username, created_at) VALUES (?, ?)
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
  // the chunk reached 'done'.
  framesInRangeStmt = db.prepare(`
    SELECT f.device, f.session, f.frame_index, f.capture_epoch_ms,
           f.file_path, f.face_status,
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

  // Photo management keeps soft-deleted rows visible as timestamped
  // tombstones. Only frames that completed face anonymization are included:
  // live rows may expose their image path, while deleted rows have file_path=''
  // and can therefore expose metadata only.
  photoFramesInRangeStmt = db.prepare(`
    SELECT device, session, frame_index, capture_epoch_ms, file_path, deleted_at
    FROM frames
    WHERE participant = ? AND capture_epoch_ms BETWEEN ? AND ?
      AND face_status = 'done'
    ORDER BY capture_epoch_ms, device, session, frame_index
  `);

  getRoundResponseListStmt = db.prepare(`
    SELECT id, participant, round, day, kind, immutable, status,
           created_at, updated_at, first_opened_at, first_draft_saved_at,
           last_draft_saved_at, submitted_at, proposal_viewed_at
    FROM activity_lists
    WHERE participant = ? AND round = ?
      AND kind = CASE WHEN round = 1 THEN 'self' ELSE 'assisted' END
  `);

  insertRoundResponseListStmt = db.prepare(`
    INSERT OR IGNORE INTO activity_lists (
      participant, round, day, kind, immutable, status,
      created_at, updated_at
    )
    VALUES (?, ?, ?, ?, 0, 'draft', ?, ?)
  `);

  markFirstOpenedStmt = db.prepare(`
    UPDATE activity_lists
    SET first_opened_at = COALESCE(first_opened_at, ?)
    WHERE participant = ? AND round = ? AND kind != 'vlm_proposal'
  `);

  markDraftSavedStmt = db.prepare(`
    UPDATE activity_lists
    SET first_draft_saved_at = COALESCE(first_draft_saved_at, ?),
        last_draft_saved_at = ?,
        updated_at = ?
    WHERE participant = ? AND round = ? AND kind != 'vlm_proposal'
  `);

  markSubmittedStmt = db.prepare(`
    UPDATE activity_lists
    SET status = 'submitted', submitted_at = ?, updated_at = ?
    WHERE participant = ? AND round = ? AND kind != 'vlm_proposal'
  `);

  listActivitiesStmt = db.prepare(`
    SELECT a.id, a.activity_list_id, a.proposal_activity_id,
           a.position, a.start_ms, a.end_ms,
           a.raw_label, a.category_label, a.source,
           a.vlm_raw_label, a.vlm_category,
           a.vlm_mean_activity_confidence,
           a.vlm_mean_activity_confidences_json,
           a.vlm_mean_category_confidence,
           a.vlm_mean_category_confidences_json,
           a.presented_raw_label, a.presented_category_label,
           a.is_incorrect_annotation_injected,
           a.workload_rating, a.recovery_rating
    FROM activities a
    JOIN activity_lists l ON l.id = a.activity_list_id
    WHERE l.participant = ? AND l.round = ? AND l.kind != 'vlm_proposal'
    ORDER BY a.position
  `);

  listActivitiesByKindStmt = db.prepare(`
    SELECT a.id, a.activity_list_id, a.proposal_activity_id,
           a.position, a.start_ms, a.end_ms,
           a.raw_label, a.category_label, a.source,
           a.vlm_raw_label, a.vlm_category,
           a.vlm_mean_activity_confidence,
           a.vlm_mean_activity_confidences_json,
           a.vlm_mean_category_confidence,
           a.vlm_mean_category_confidences_json,
           a.presented_raw_label, a.presented_category_label,
           a.is_incorrect_annotation_injected,
           a.workload_rating, a.recovery_rating
    FROM activities a
    JOIN activity_lists l ON l.id = a.activity_list_id
    WHERE l.participant = ? AND l.round = ? AND l.kind = ?
    ORDER BY a.position
  `);

  getActivityListStmt = db.prepare(`
    SELECT id, participant, round, day, kind, immutable, status,
           created_at, updated_at, first_opened_at, first_draft_saved_at,
           last_draft_saved_at, submitted_at, proposal_viewed_at
    FROM activity_lists
    WHERE participant = ? AND round = ? AND kind = ?
  `);

  listActivityListsForDayStmt = db.prepare(`
    SELECT id, participant, round, day, kind, immutable, status,
           created_at, updated_at, first_opened_at, first_draft_saved_at,
           last_draft_saved_at, submitted_at, proposal_viewed_at
    FROM activity_lists
    WHERE participant = ? AND day = ?
    ORDER BY round, CASE kind
      WHEN 'self' THEN 0
      WHEN 'vlm_proposal' THEN 1
      ELSE 2
    END
  `);

  upsertEditableActivityListStmt = db.prepare(`
    INSERT INTO activity_lists (
      participant, round, day, kind, immutable, status,
      created_at, updated_at
    ) VALUES (?, ?, ?, ?, 0, 'draft', ?, ?)
    ON CONFLICT (participant, round, kind) DO UPDATE SET
      updated_at = excluded.updated_at
    WHERE activity_lists.immutable = 0
    RETURNING id
  `);

  insertVlmProposalListStmt = db.prepare(`
    INSERT OR IGNORE INTO activity_lists (
      participant, round, day, kind, immutable, status,
      created_at, updated_at
    ) VALUES (?, ?, ?, 'vlm_proposal', 1, NULL, ?, ?)
  `);

  markVlmProposalViewedStmt = db.prepare(`
    UPDATE activity_lists
    SET proposal_viewed_at = COALESCE(proposal_viewed_at, ?)
    WHERE id = ? AND kind = 'vlm_proposal'
    RETURNING proposal_viewed_at
  `);

  listVlmSpanActivitiesStmt = db.prepare(`
    SELECT a.id, a.start_ms, a.end_ms,
           a.raw_label, a.category_label,
           a.vlm_raw_label, a.vlm_category,
           a.vlm_mean_activity_confidence,
           a.vlm_mean_activity_confidences_json,
           a.vlm_mean_category_confidence,
           a.vlm_mean_category_confidences_json,
           a.presented_raw_label, a.presented_category_label,
           a.is_incorrect_annotation_injected
    FROM activities a
    JOIN activity_lists l ON l.id = a.activity_list_id
    WHERE l.participant = ? AND l.round = ? AND l.kind = 'vlm_proposal'
  `);

  deleteActivitiesStmt = db.prepare(`
    DELETE FROM activities WHERE activity_list_id = ?
  `);

  insertActivityStmt = db.prepare(`
    INSERT INTO activities (
      activity_list_id, proposal_activity_id, position, start_ms, end_ms,
      raw_label, category_label, source, vlm_raw_label, vlm_category,
      vlm_mean_activity_confidence, vlm_mean_activity_confidences_json,
      vlm_mean_category_confidence, vlm_mean_category_confidences_json,
      presented_raw_label, presented_category_label,
      is_incorrect_annotation_injected,
      workload_rating, recovery_rating,
      created_at, updated_at
    ) VALUES (
      @activity_list_id, @proposal_activity_id, @position, @start_ms, @end_ms,
      @raw_label, @category_label, @source, @vlm_raw_label, @vlm_category,
      @vlm_mean_activity_confidence, @vlm_mean_activity_confidences_json,
      @vlm_mean_category_confidence, @vlm_mean_category_confidences_json,
      @presented_raw_label, @presented_category_label,
      @is_incorrect_annotation_injected,
      @workload_rating, @recovery_rating,
      @created_at, @updated_at
    )
  `);

  // The original generated proposal is a write-once list. The metadata row's
  // primary key makes repeated generation a no-op, and this transaction is
  // the only code path that inserts vlm_proposal items.
  createVlmProposalTx = db.transaction(
    (
      participant: string,
      round: number,
      day: string,
      activities: ActivityWriteInput[],
      now: number,
    ): boolean => {
      const inserted = insertVlmProposalListStmt.run(
        participant,
        round,
        day,
        now,
        now,
      );
      if (inserted.changes === 0) return false;
      const proposalList = getActivityListStmt.get(
        participant,
        round,
        "vlm_proposal",
      ) as ActivityListRow | undefined;
      if (proposalList === undefined) {
        throw new Error("created VLM proposal list could not be reloaded");
      }

      activities.forEach((activity, position) => {
        insertActivityStmt.run({
          activity_list_id: proposalList.id,
          proposal_activity_id: null,
          position,
          start_ms: activity.start_ms,
          end_ms: activity.end_ms,
          raw_label: activity.raw_label,
          category_label: activity.category_label,
          source: "vlm",
          vlm_raw_label: activity.raw_label,
          vlm_category: activity.category_label,
          vlm_mean_activity_confidence:
            activity.vlm_mean_activity_confidence ?? null,
          vlm_mean_activity_confidences_json:
            activity.vlm_mean_activity_confidences_json ?? null,
          vlm_mean_category_confidence:
            activity.vlm_mean_category_confidence ?? null,
          vlm_mean_category_confidences_json:
            activity.vlm_mean_category_confidences_json ?? null,
          presented_raw_label:
            activity.presented_raw_label ?? activity.raw_label,
          presented_category_label:
            activity.presented_category_label ?? activity.category_label,
          is_incorrect_annotation_injected:
            activity.is_incorrect_annotation_injected === true ? 1 : 0,
          workload_rating: null,
          recovery_rating: null,
          created_at: now,
          updated_at: now,
        });
      });
      return true;
    },
  );

  // Replace-all write for a round's EDITABLE activities. Draft saves and
  // submissions share it; submit additionally locks the response list. The
  // immutable vlm_proposal list is never deleted or updated here. Original
  // VLM and final participant labels remain separate list-owned observations.
  replaceActivitiesTx = db.transaction(
    (
      participant: string,
      round: number,
      day: string,
      activities: ActivityWriteInput[],
      submit: boolean,
      recordDraftSave: boolean,
      now: number,
    ): number | null => {
      const listKind: ActivityListKind = round === 1 ? "self" : "assisted";

      // Match against the immutable original proposal so unchanged spans keep
      // their VLM/intervention provenance after any number of replace-all
      // saves. proposal_activity_id is the stable path across boundary edits;
      // exact-span matching keeps older clients/backfilled rows compatible.
      const existingVlmRows = listVlmSpanActivitiesStmt.all(participant, round) as {
        id: number;
        start_ms: number;
        end_ms: number;
        raw_label: string | null;
        category_label: string | null;
        vlm_raw_label: string | null;
        vlm_category: string | null;
        vlm_mean_activity_confidence: number | null;
        vlm_mean_activity_confidences_json: string | null;
        vlm_mean_category_confidence: number | null;
        vlm_mean_category_confidences_json: string | null;
        presented_raw_label: string | null;
        presented_category_label: string | null;
        is_incorrect_annotation_injected: number;
      }[];
      const vlmBySpan = new Map(
        existingVlmRows.map((row) => [`${row.start_ms}|${row.end_ms}`, row]),
      );
      const vlmById = new Map(existingVlmRows.map((row) => [row.id, row]));

      const editableList = upsertEditableActivityListStmt.get(
        participant,
        round,
        day,
        listKind,
        now,
        now,
      ) as { id: number } | undefined;
      if (editableList === undefined) {
        throw new Error(`could not create or update ${listKind} activity list`);
      }
      deleteActivitiesStmt.run(editableList.id);
      activities.forEach((activity, position) => {
        const matched =
          (activity.source !== "vlm" || activity.proposal_activity_id == null
            ? undefined
            : vlmById.get(activity.proposal_activity_id)) ??
          (activity.source === "vlm"
            ? vlmBySpan.get(`${activity.start_ms}|${activity.end_ms}`)
            : undefined);
        insertActivityStmt.run({
          activity_list_id: editableList.id,
          proposal_activity_id: matched?.id ?? null,
          position,
          start_ms: activity.start_ms,
          end_ms: activity.end_ms,
          raw_label: activity.raw_label,
          category_label: activity.category_label,
          source: activity.source,
          vlm_raw_label:
            matched?.vlm_raw_label ?? matched?.raw_label ?? null,
          vlm_category:
            matched?.vlm_category ?? matched?.category_label ?? null,
          vlm_mean_activity_confidence:
            matched?.vlm_mean_activity_confidence ?? null,
          vlm_mean_activity_confidences_json:
            matched?.vlm_mean_activity_confidences_json ?? null,
          vlm_mean_category_confidence:
            matched?.vlm_mean_category_confidence ?? null,
          vlm_mean_category_confidences_json:
            matched?.vlm_mean_category_confidences_json ?? null,
          presented_raw_label: matched?.presented_raw_label ?? null,
          presented_category_label:
            matched?.presented_category_label ?? null,
          is_incorrect_annotation_injected:
            matched?.is_incorrect_annotation_injected ?? 0,
          workload_rating: activity.workload_rating ?? null,
          recovery_rating: activity.recovery_rating ?? null,
          created_at: now,
          updated_at: now,
        });
      });

      if (recordDraftSave) {
        markDraftSavedStmt.run(now, now, now, participant, round);
      }
      if (!submit) return null;

      markSubmittedStmt.run(now, now, participant, round);
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

// Pins a round's response-list identity + study day on first open
// (INSERT OR IGNORE = no-op when a row already exists). Without pinning, the
// study day would keep deriving from the participant's latest frame day —
// mutable data: a new frame the next morning (or a frame deletion) could
// silently shift an already-seen round onto a different day.
export function pinRoundResponseList(
  participant: string,
  round: number,
  day: string,
): void {
  const now = Date.now();
  const kind: ActivityListKind = round === 1 ? "self" : "assisted";
  insertRoundResponseListStmt.run(
    participant,
    round,
    day,
    kind,
    now,
    now,
  );
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

// Records one client-generated lifecycle event idempotently. Reusing an event
// ID or session sequence with different content is a data-integrity conflict.
export function recordRecordingEvent(
  participant: string,
  event: RecordingEventInput,
): RecordingEventRow {
  return recordRecordingEventTx(participant, event, Date.now());
}

export function latestRecordingEvent(
  participant: string,
): RecordingEventRow | undefined {
  return latestRecordingEventStmt.get(participant) as
    | RecordingEventRow
    | undefined;
}

// Restores the current defense-in-depth pause gate after a server restart.
export function listPausedParticipants(): string[] {
  return (
    listPausedParticipantsStmt.all() as { participant: string }[]
  ).map((row) => row.participant);
}

// The app's latest End-session event proves that no more frames from that
// session are coming, so its still-filling chunks can go to the VLM now.
export function closeFillingChunksForSession(
  participant: string,
  session: number,
): number {
  return closeSessionChunksStmt.run({
    participant,
    session,
    now: Date.now(),
  }).changes;
}

// Every chunk of one local day, ordered by window start. Windows are
// clock-aligned, so a chunk never straddles the local-midnight day boundary.
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

// Profile upsert: occupation, work description and the daily schedule —
// deliberately never touches the legacy arm column.
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

// Every anonymized frame audit row on one local day, including soft-deleted
// tombstones in their original chronological position.
export function listPhotoFramesOnDay(
  participant: string,
  day: string,
): PhotoFrameRow[] {
  const { fromMs, toMs } = dayUtcRange(day);
  const rows = photoFramesInRangeStmt.all(
    participant,
    fromMs,
    toMs,
  ) as PhotoFrameRow[];
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

// --- DRM: response lists + activity children --------------------------------

export function getRoundResponseList(
  participant: string,
  round: number,
): ActivityListRow | undefined {
  return getRoundResponseListStmt.get(participant, round) as
    | ActivityListRow
    | undefined;
}

// Records the first successful editor response once. Pinning and exposure are
// deliberately separate: the response-list row can exist before a response is
// successfully assembled.
export function markRoundResponseOpened(
  participant: string,
  round: number,
): void {
  markFirstOpenedStmt.run(Date.now(), participant, round);
}

// Atomically returns the stable first-view timestamp for the immutable
// proposal. The kind predicate prevents any editable/self list from being
// marked accidentally.
export function markVlmProposalViewed(activityListId: number): number {
  const row = markVlmProposalViewedStmt.get(
    Date.now(),
    activityListId,
  ) as { proposal_viewed_at: number } | undefined;
  if (!row) {
    throw new Error("VLM proposal activity list not found");
  }
  return row.proposal_viewed_at;
}

export function listActivities(
  participant: string,
  round: number,
): ActivityRow[] {
  return listActivitiesStmt.all(participant, round) as ActivityRow[];
}

export function getActivityList(
  participant: string,
  round: number,
  kind: ActivityListKind,
): ActivityListRow | undefined {
  return getActivityListStmt.get(participant, round, kind) as
    | ActivityListRow
    | undefined;
}

export function listActivitiesByKind(
  participant: string,
  round: number,
  kind: ActivityListKind,
): ActivityRow[] {
  return listActivitiesByKindStmt.all(
    participant,
    round,
    kind,
  ) as ActivityRow[];
}

// Researcher-facing DB query helper: returns the explicitly identified lists
// for one participant/day. Round 1 self, immutable VLM proposal, and the
// editable/final assisted list remain distinguishable after submission.
export function listStudyActivityLists(
  participant: string,
  day: string,
): ActivityListSnapshot[] {
  const lists = listActivityListsForDayStmt.all(
    participant,
    day,
  ) as ActivityListRow[];
  return lists.map((list) => ({
    ...list,
    activities: listActivitiesByKind(list.participant, list.round, list.kind),
  }));
}

// Stores the original generated VLM proposal exactly once. Returns false when
// the immutable proposal list already exists; existing items are never
// replaced, even if chunk labels are later reprocessed.
export function createVlmProposal(options: {
  participant: string;
  round: number;
  day: string;
  activities: ActivityWriteInput[];
}): boolean {
  return createVlmProposalTx(
    options.participant,
    options.round,
    options.day,
    options.activities,
    Date.now(),
  );
}

// Atomic replace-all save of a round's activities (creates its response-list
// parent on first save). With submit=true it also locks the round; returns the
// submitted_at timestamp (null for drafts).
export function replaceActivities(options: {
  participant: string;
  round: number;
  day: string;
  activities: ActivityWriteInput[];
  submit: boolean;
  // True only for a participant's successful draft PUT. Automatic proposal
  // bootstrap also writes the editable list but is not participant edit time.
  recordDraftSave?: boolean;
}): { submittedAt: number | null } {
  const submittedAt = replaceActivitiesTx(
    options.participant,
    options.round,
    options.day,
    options.activities,
    options.submit,
    options.recordDraftSave ?? false,
    Date.now(),
  );
  return { submittedAt };
}

// Reconstructs a per-session CSV from the DB on demand (the DB is the live
// index now). CaptureDatetime is intentionally dropped (derive it from
// capture_epoch_ms if needed). NO vlm_* columns: participant-facing output
// must never carry VLM labels (see ExportRow).
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
