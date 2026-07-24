// Builds a minimal one-chunk fixture for a LIVE run of the chunk VLM worker:
//   RECORDINGS_DIR=<dir> npx tsx scripts/seed-vlm-live-test.ts
//   RECORDINGS_DIR=<dir> ../vlm/.venv/bin/python ../vlm/vlm_worker.py --once --max 1
// Creates one participant with 3 frames (grey placeholder JPEGs) in a single
// closed ('ready') 5-minute chunk, face_status='done'.

import fs = require("fs");
import path = require("path");
import Database = require("better-sqlite3");

import { chunkStartOf, initDb, insertFrame } from "../src/db";

const RECORDINGS_DIR = process.env.RECORDINGS_DIR;
if (!RECORDINGS_DIR) throw new Error("set RECORDINGS_DIR to a throwaway dir");

const GREY_JPEG = Buffer.from(
  "/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRof" +
    "Hh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAAB" +
    "AAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AVN//2Q==",
  "base64",
);

fs.mkdirSync(RECORDINGS_DIR, { recursive: true });
initDb(path.join(RECORDINGS_DIR, "recordings.db"));

const windowStart = chunkStartOf(Date.now() - 30 * 60_000);
const imagesDir = path.join(RECORDINGS_DIR, "vlmtest", "CAM", "1", "images");
fs.mkdirSync(imagesDir, { recursive: true });

for (let i = 0; i < 3; i++) {
  const captureMs = windowStart + i * 60_000;
  const fileName = `frame-${i + 1}-${captureMs}.jpg`;
  fs.writeFileSync(path.join(imagesDir, fileName), GREY_JPEG);
  insertFrame({
    participant: "vlmtest",
    device: "CAM",
    session: 1,
    frame_index: i + 1,
    capture_epoch_ms: captureMs,
    received_epoch_ms: captureMs,
    file_path: path.join("vlmtest", "CAM", "1", "images", fileName),
    device_frame: i + 1,
    byte_length: GREY_JPEG.length,
    jpeg_ok: 1,
  });
}

const db = new Database(path.join(RECORDINGS_DIR, "recordings.db"));
db.prepare("UPDATE frames SET face_status = 'done' WHERE participant = 'vlmtest'").run();
db.prepare(
  "UPDATE chunks SET status = 'ready' WHERE participant = 'vlmtest'",
).run();
console.log(
  db
    .prepare("SELECT chunk_start_ms, frame_count, status FROM chunks WHERE participant = 'vlmtest'")
    .all(),
);
db.close();
console.log("fixture ready");
