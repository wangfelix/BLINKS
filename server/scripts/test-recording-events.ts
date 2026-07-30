// Database-level tests for append-only recording lifecycle events:
// idempotent retries, conflict detection, pause-state restoration, and
// session-scoped trailing-chunk closure.
//
//   npx tsx scripts/test-recording-events.ts

import assert = require("assert");
import fs = require("fs");
import os = require("os");
import path = require("path");
import Database = require("better-sqlite3");

import {
  CHUNK_WINDOW_MS,
  RecordingEventConflictError,
  chunkStartOf,
  closeFillingChunksForSession,
  initDb,
  insertFrame,
  latestRecordingEvent,
  listPausedParticipants,
  recordRecordingEvent,
} from "../src/db";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "blinks-events-test-"));
const dbPath = path.join(dir, "recordings.db");
initDb(dbPath);

const participant = "participant";
const firstSession = 1_800_000_000;
const secondSession = firstSession + 60;
const baseMs = chunkStartOf(Date.now() - CHUNK_WINDOW_MS);

const event = (
  session: number,
  sequence: number,
  eventType: "start" | "pause" | "resume" | "end",
) => ({
  event_id: `${session}-${sequence}`,
  session,
  event_type: eventType,
  client_epoch_ms: baseMs + sequence * 1_000,
  sequence_number: sequence,
});

const firstStart = recordRecordingEvent(
  participant,
  event(firstSession, 0, "start"),
);
const firstPause = recordRecordingEvent(
  participant,
  event(firstSession, 1, "pause"),
);
const retriedPause = recordRecordingEvent(
  participant,
  event(firstSession, 1, "pause"),
);
assert.deepStrictEqual(retriedPause, firstPause, "identical retry is a no-op");

assert.throws(
  () =>
    recordRecordingEvent(participant, {
      ...event(firstSession, 1, "resume"),
      event_id: "conflicting-event",
    }),
  RecordingEventConflictError,
  "a reused session sequence cannot silently change meaning",
);

recordRecordingEvent(participant, event(firstSession, 2, "resume"));
recordRecordingEvent(participant, event(firstSession, 3, "end"));
recordRecordingEvent(participant, event(secondSession, 0, "start"));
recordRecordingEvent(participant, event(secondSession, 1, "pause"));

assert.strictEqual(firstStart.event_type, "start");
assert.strictEqual(
  latestRecordingEvent(participant)?.event_type,
  "pause",
  "latest session and sequence define current recording state",
);
assert.deepStrictEqual(
  listPausedParticipants(),
  [participant],
  "pause gate can be rebuilt from the append-only event stream",
);

const storedDb = new Database(dbPath, { readonly: true });
assert.strictEqual(
  (
    storedDb
      .prepare(
        "SELECT COUNT(*) AS count FROM recording_events WHERE participant = ?",
      )
      .get(participant) as { count: number }
  ).count,
  6,
  "retry and rejected conflict do not add rows",
);
storedDb.close();

insertFrame({
  participant,
  device: "camera",
  session: firstSession,
  frame_index: 1,
  capture_epoch_ms: baseMs,
  received_epoch_ms: baseMs,
  file_path: "first.jpg",
  device_frame: 1,
  byte_length: 10,
  jpeg_ok: 1,
});
insertFrame({
  participant,
  device: "camera",
  session: secondSession,
  frame_index: 1,
  capture_epoch_ms: baseMs + CHUNK_WINDOW_MS,
  received_epoch_ms: baseMs + CHUNK_WINDOW_MS,
  file_path: "second.jpg",
  device_frame: 2,
  byte_length: 10,
  jpeg_ok: 1,
});

assert.strictEqual(
  closeFillingChunksForSession(participant, firstSession),
  0,
  "a delayed old-session end does not close the newer session's chunk",
);
assert.strictEqual(
  closeFillingChunksForSession(participant, secondSession),
  1,
  "the current session closes its own trailing chunk",
);

fs.rmSync(dir, { recursive: true, force: true });
console.log("RECORDING EVENT TESTS PASSED");
