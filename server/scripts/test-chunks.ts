// Unit test for the 5-minute-chunk ingestion lifecycle (db.ts): window
// alignment, close-on-later-frame, the idle sweep, and the GDPR frame-delete
// bookkeeping. Runs against a throwaway DB in a temp dir.
//
//   npx tsx scripts/test-chunks.ts

import assert = require("assert");
import fs = require("fs");
import os = require("os");
import path = require("path");
import Database = require("better-sqlite3");

import {
  CHUNK_WINDOW_MS,
  chunkStartOf,
  closeIdleChunks,
  initDb,
  insertFrame,
  softDeleteFrameRow,
} from "../src/db";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "blinks-chunk-test-"));
initDb(path.join(dir, "recordings.db"));
const db = new Database(path.join(dir, "recordings.db"));

const addFrame = (
  index: number,
  captureMs: number,
  receivedMs = captureMs,
): void =>
  insertFrame({
    participant: "p",
    device: "d",
    session: 1,
    frame_index: index,
    capture_epoch_ms: captureMs,
    received_epoch_ms: receivedMs,
    file_path: `f${index}.jpg`,
    device_frame: index,
    byte_length: 10,
    jpeg_ok: 1,
  });

const chunks = (): { chunk_start_ms: number; frame_count: number; status: string }[] =>
  db
    .prepare(
      "SELECT chunk_start_ms, frame_count, status FROM chunks ORDER BY chunk_start_ms",
    )
    .all() as { chunk_start_ms: number; frame_count: number; status: string }[];

let failures = 0;
const check = (name: string, actual: unknown, expected: unknown): void => {
  try {
    assert.deepStrictEqual(actual, expected);
    console.log(`ok   ${name}`);
  } catch {
    failures += 1;
    console.error(
      `FAIL ${name}\n  expected ${JSON.stringify(expected)}\n  actual   ${JSON.stringify(actual)}`,
    );
  }
};

check(
  "chunk retry columns are present",
  (db.prepare("PRAGMA table_info(chunks)").all() as { name: string }[])
    .map((column) => column.name)
    .filter(
      (name) =>
        (name.startsWith("vlm_") && name.includes("attempt")) ||
        name === "vlm_retry_count" ||
        name === "vlm_last_error_type",
    ),
  [
    "vlm_attempt_count",
    "vlm_retry_count",
    "vlm_next_attempt_at",
    "vlm_last_error_type",
  ],
);
check(
  "VLM attempt audit table is present",
  (db.prepare("PRAGMA table_info(vlm_attempts)").all() as { name: string }[]).map(
    (column) => column.name,
  ),
  [
    "id",
    "participant",
    "chunk_start_ms",
    "attempt_number",
    "retry_number",
    "model",
    "started_at",
    "completed_at",
    "duration_ms",
    "frames_sent",
    "timeout_seconds",
    "outcome",
    "error_class",
    "http_status",
  ],
);

// Fixed, 5-min-aligned base so window membership is deterministic.
const now = Date.now();
const w0 = chunkStartOf(now - 60 * 60_000); // an hour ago, aligned

check("alignment is modulo the window", chunkStartOf(w0 + 123_456), w0);
check(
  "window end is start + 5 min",
  chunkStartOf(w0 + CHUNK_WINDOW_MS),
  w0 + CHUNK_WINDOW_MS,
);

// Three frames in window 0: one chunk, filling, count 3.
addFrame(1, w0);
addFrame(2, w0 + 30_000);
addFrame(3, w0 + 299_999);
check(
  "frames of one window share one filling chunk",
  chunks().map((c) => [c.chunk_start_ms - w0, c.frame_count, c.status]),
  [[0, 3, "filling"]],
);
check(
  "new chunks start with clean retry state",
  db
    .prepare(
      "SELECT vlm_attempt_count, vlm_retry_count, vlm_next_attempt_at, " +
        "vlm_last_error_type FROM chunks WHERE chunk_start_ms = ?",
    )
    .get(w0),
  {
    vlm_attempt_count: 0,
    vlm_retry_count: 0,
    vlm_next_attempt_at: null,
    vlm_last_error_type: null,
  },
);

// A frame in window 2 (skipping window 1 entirely): closes window 0. Its
// capture time is old but it ARRIVES just now — the delayed-upload case the
// idle sweep must key on received (not capture) time.
addFrame(4, w0 + 2 * CHUNK_WINDOW_MS, now);
check(
  "later-window frame closes every earlier filling chunk",
  chunks().map((c) => [c.chunk_start_ms - w0, c.frame_count, c.status]),
  [
    [0, 3, "ready"],
    [2 * CHUNK_WINDOW_MS, 1, "filling"],
  ],
);

// Idle sweep: the trailing chunk closes only once its newest frame's ARRIVAL
// is older than the idle window (upload lag must not close it early).
check("sweep leaves recently-fed chunks alone", closeIdleChunks(10 * 60_000), 0);
check("sweep closes the idle trailing chunk", closeIdleChunks(-1), 1);
check(
  "trailing chunk is ready after the sweep",
  chunks().map((c) => c.status),
  ["ready", "ready"],
);

db.prepare(
  "INSERT INTO vlm_attempts " +
    "(participant, chunk_start_ms, attempt_number, retry_number, model, " +
    "started_at, completed_at, duration_ms, frames_sent, timeout_seconds, outcome) " +
    "VALUES ('p', ?, 1, 1, 'test-model', ?, ?, 100, 1, 120, 'done')",
).run(w0 + 2 * CHUNK_WINDOW_MS, now, now + 100);

// GDPR soft delete: the audit row remains, but the active chunk count drops;
// the last live frame of a window removes the chunk row entirely (a label
// must not outlive its imagery).
softDeleteFrameRow("p", "d", 1, 4);
check(
  "soft-deleting a window's last frame deletes its chunk",
  chunks().map((c) => [c.chunk_start_ms - w0, c.frame_count]),
  [[0, 3]],
);
check(
  "attempt analysis survives deletion of an empty chunk",
  db.prepare("SELECT COUNT(*) AS count FROM vlm_attempts").get(),
  { count: 1 },
);
check(
  "soft-deleted frame keeps an audit row with no serving path",
  db
    .prepare(
      "SELECT file_path, typeof(deleted_at) AS deleted_at_type FROM frames WHERE frame_index = 4",
    )
    .get(),
  { file_path: "", deleted_at_type: "integer" },
);
softDeleteFrameRow("p", "d", 1, 2);
check(
  "soft-deleting one of several frames only decrements",
  chunks().map((c) => [c.chunk_start_ms - w0, c.frame_count]),
  [[0, 2]],
);
softDeleteFrameRow("p", "d", 1, 2);
check(
  "repeating a soft delete does not decrement twice",
  chunks().map((c) => [c.chunk_start_ms - w0, c.frame_count]),
  [[0, 2]],
);

db.close();
fs.rmSync(dir, { recursive: true, force: true });

if (failures > 0) {
  console.error(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log("\nCHUNK TESTS PASSED");
