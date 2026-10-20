// Re-anonymize frames that were stored while privacy.faceBlur.enabled was
// false (face_method='disabled'). Those frames are
// served unblurred and stay so after blur is switched back on, unless they
// are requeued here. Prints counts only (no participant data).
//
//   cd server
//   npx tsx scripts/requeue-unblurred-frames.ts            # dry run: count
//   npx tsx scripts/requeue-unblurred-frames.ts --apply    # requeue
//
// Env: RECORDINGS_DIR (default server/recordings), BLINKS_STUDY_CONFIG.
// --apply needs privacy.faceBlur.enabled=true in the active study config.
// Requeued frames get face_status='pending' and are HIDDEN from participants
// until blinks-face-blur has processed them (same gate as new frames). VLM
// labels already computed from the unblurred images are not changed: the
// images have already been sent to the VLM endpoint.

import fs = require("fs");
import path = require("path");
import Database = require("better-sqlite3");

import { studyConfig } from "../src/study-config";

const apply = process.argv.includes("--apply");
const recordingsDir = process.env.RECORDINGS_DIR ?? path.join(__dirname, "..", "recordings");
const dbPath = path.join(recordingsDir, "recordings.db");
if (!fs.existsSync(dbPath)) {
  console.error(`no database at ${dbPath}`);
  process.exit(1);
}
if (apply && !studyConfig.privacy.faceBlur.enabled) {
  console.error(
    "refusing --apply: privacy.faceBlur.enabled is false in the active study config, " +
      "so nothing would anonymize the requeued frames (they would stay hidden).",
  );
  process.exit(1);
}

const db = new Database(dbPath, apply ? {} : { readonly: true });
db.pragma("busy_timeout = 5000");
const where = "face_method = 'disabled' AND deleted_at IS NULL";
const count = (db.prepare(`SELECT COUNT(*) AS n FROM frames WHERE ${where}`).get() as { n: number }).n;
const participants = (
  db.prepare(`SELECT COUNT(DISTINCT participant) AS n FROM frames WHERE ${where}`).get() as { n: number }
).n;
console.log(`unblurred frames (face_method='disabled'): ${count} from ${participants} participant(s)`);
if (!apply) {
  if (count > 0) console.log("dry run; rerun with --apply to requeue them for blinks-face-blur");
  db.close();
  process.exit(0);
}
const changed = db
  .prepare(
    `UPDATE frames SET face_status = 'pending', face_method = NULL, face_count = NULL,
       face_completed_at = NULL WHERE ${where}`,
  )
  .run().changes;
db.close();
console.log(`requeued ${changed} frame(s); they are hidden until blinks-face-blur has processed them`);
