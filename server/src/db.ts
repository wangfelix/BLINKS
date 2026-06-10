import Database from "better-sqlite3";

// ===========================================================================
// SQLite metadata store (recordings.db, WAL mode, via better-sqlite3).
//
// One row per ingested frame, written synchronously as the JPEG is received.
// The JPEG bytes stay on the filesystem under recordings/...; this table is the
// index over them, superseding the old per-session CSV, and the place the
// separate VLM process later writes labels / descriptions / descriptors back.
// See CLAUDE.md, "Storage and VLM metadata", for the rationale and full schema.
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

// Shape returned by the CSV export query.
interface ExportRow {
  frame_index: number;
  capture_epoch_ms: number;
  received_epoch_ms: number;
  device_frame: number | null;
  byte_length: number | null;
  jpeg_ok: number | null;
  file_path: string;
  vlm_status: string;
  vlm_label: string | null;
}

// Rows returned by the participant-facing read API.
export interface SessionRow {
  device: string;
  session: number;
  started_at_ms: number;
  ended_at_ms: number;
  frame_count: number;
}

export interface FrameRow {
  frame_index: number;
  capture_epoch_ms: number;
  vlm_status: string;
  vlm_label: string | null;
  file_path: string;
}

let db: Database.Database;
let insertStmt: Database.Statement;
let exportStmt: Database.Statement;
let listSessionsStmt: Database.Statement;
let listFramesStmt: Database.Statement;
let getFrameStmt: Database.Statement;
let deleteFrameStmt: Database.Statement;
let maxFrameIndexStmt: Database.Statement;

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
      PRIMARY KEY (participant, device, session, frame_index)
    );
    CREATE INDEX IF NOT EXISTS idx_frames_time
      ON frames (participant, capture_epoch_ms);
    CREATE INDEX IF NOT EXISTS idx_frames_pending
      ON frames (capture_epoch_ms) WHERE vlm_status = 'pending';
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
           byte_length, jpeg_ok, file_path, vlm_status, vlm_label
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

  listFramesStmt = db.prepare(`
    SELECT frame_index, capture_epoch_ms, vlm_status, vlm_label, file_path
    FROM frames
    WHERE participant = ? AND device = ? AND session = ?
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

// Reconstructs a per-session CSV from the DB on demand (the DB is the live
// index now). CaptureDatetime is intentionally dropped (derive it from
// capture_epoch_ms if needed); vlm_status / vlm_label are included since they
// are now part of the record.
export function exportFramesCsv(q: ExportQuery): string {
  const rows = exportStmt.all(q) as ExportRow[];
  const header =
    "FrameIndex;CaptureEpochMs;ReceivedEpochMs;DeviceFrame;ByteLength;JpegOk;FilePath;VlmStatus;VlmLabel";
  const lines = rows.map((r) =>
    [
      r.frame_index,
      r.capture_epoch_ms,
      r.received_epoch_ms,
      r.device_frame ?? "",
      r.byte_length ?? "",
      r.jpeg_ok ?? "",
      r.file_path,
      r.vlm_status,
      r.vlm_label ?? "",
    ].join(";"),
  );
  return [header, ...lines].join("\n") + "\n";
}
