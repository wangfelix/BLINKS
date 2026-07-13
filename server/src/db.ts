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
}

// Deliberately carries no vlm_* columns: the mobile app must never receive
// VLM output (anti-leak for the DRM control condition).
export interface FrameRow {
  frame_index: number;
  capture_epoch_ms: number;
  file_path: string;
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
}

// Per-day frame aggregate for /api/reconstruction/days.
export interface DayAggregate {
  day: string;
  frameCount: number;
  vlmPendingCount: number; // vlm_status IN ('pending','processing')
}

// Frame rows of one local day, for the reconstruction API + segmentation.
export interface DayFrameRow {
  capture_epoch_ms: number;
  file_path: string;
  face_status: string;
  vlm_status: string;
  vlm_label: string | null;
  vlm_category: string | null;
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
let getFrameStmt: Database.Statement;
let deleteFrameStmt: Database.Statement;
let maxFrameIndexStmt: Database.Statement;
let frameStatusByPathStmt: Database.Statement;

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

  // Created after the column exists so the migration path also gets the index.
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_frames_face_pending
      ON frames (capture_epoch_ms) WHERE face_status = 'pending';
  `);

  // DRM migration (additive, same pattern as face_*): category + propagated
  // user-corrected labels on frames, plus the participants / reconstructions /
  // activities tables.
  migrateAddColumn("vlm_category", "vlm_category TEXT");
  migrateAddColumn(
    "user_corrected_category_label",
    "user_corrected_category_label TEXT",
  );
  migrateAddColumn(
    "user_corrected_activity_label",
    "user_corrected_activity_label TEXT",
  );

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
      created_at     INTEGER NOT NULL,
      updated_at     INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_activities_round
      ON activities (participant, round, position);
  `);

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
           vlm_raw_label, vlm_category
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
      created_at, updated_at
    ) VALUES (
      @participant, @round, @position, @start_ms, @end_ms,
      @raw_label, @category_label, @source, @vlm_raw_label, @vlm_category,
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
      // upstream can never rewrite frames outside the pinned study day.
      const { fromMs, toMs } = dayUtcRange(day);
      for (const activity of activities) {
        propagateCorrectionsStmt.run(
          activity.category_label,
          activity.raw_label,
          participant,
          Math.max(activity.start_ms, fromMs),
          Math.min(activity.end_ms, toMs),
        );
      }
      return now;
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

export function getFrameFilePath(
  participant: string,
  device: string,
  session: number,
  frameIndex: number,
): string | undefined {
  const row = getFrameStmt.get(participant, device, session, frameIndex) as
    | { file_path: string }
    | undefined;
  return row?.file_path;
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

export function deleteFrameRow(
  participant: string,
  device: string,
  session: number,
  frameIndex: number,
): boolean {
  return (
    deleteFrameStmt.run(participant, device, session, frameIndex).changes > 0
  );
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
  insertStmt.run(row);
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
    vlm_status: string;
    face_status: string;
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
    // A face_status='failed' frame can never become VLM-done (the VLM gate
    // requires face 'done'), so it must not count as pending — otherwise one
    // failed blur would keep an assisted day in "still processing" forever.
    if (
      (row.vlm_status === "pending" || row.vlm_status === "processing") &&
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
