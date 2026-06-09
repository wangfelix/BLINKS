"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.initDb = initDb;
exports.insertFrame = insertFrame;
exports.exportFramesCsv = exportFramesCsv;
const better_sqlite3_1 = __importDefault(require("better-sqlite3"));
let db;
let insertStmt;
let exportStmt;
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
}
function insertFrame(row) {
    insertStmt.run(row);
}
// Reconstructs a per-session CSV from the DB on demand (the DB is the live
// index now). CaptureDatetime is intentionally dropped (derive it from
// capture_epoch_ms if needed); vlm_status / vlm_label are included since they
// are now part of the record.
function exportFramesCsv(q) {
    const rows = exportStmt.all(q);
    const header = "FrameIndex;CaptureEpochMs;ReceivedEpochMs;DeviceFrame;ByteLength;JpegOk;FilePath;VlmStatus;VlmLabel";
    const lines = rows.map((r) => [
        r.frame_index,
        r.capture_epoch_ms,
        r.received_epoch_ms,
        r.device_frame ?? "",
        r.byte_length ?? "",
        r.jpeg_ok ?? "",
        r.file_path,
        r.vlm_status,
        r.vlm_label ?? "",
    ].join(";"));
    return [header, ...lines].join("\n") + "\n";
}
