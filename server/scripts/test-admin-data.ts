import assert from "assert";
import fs from "fs";
import os from "os";
import path from "path";

import {
  ensureParticipant,
  exportAdminTableCsv,
  getAdminFrameAvailabilityByPath,
  getAdminParticipantCount,
  getAdminTableCounts,
  initDb,
  insertFrame,
  isAdminTableName,
  listAdminPhotoParticipants,
  listAdminPhotos,
  listAdminPhotoSessions,
  listAdminTableRows,
} from "../src/db";

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "blinks-admin-data-"));
const dbPath = path.join(tempDir, "recordings.db");

try {
  initDb(dbPath);
  ensureParticipant("participant-a");
  const captureTime = 1_750_000_000_000;
  insertFrame({
    participant: "participant-a",
    device: "camera-a",
    session: 1_750_000_000,
    frame_index: 1,
    capture_epoch_ms: captureTime,
    received_epoch_ms: captureTime + 25,
    file_path: "participant-a/camera-a/1750000000/frame,1.jpg",
    device_frame: 7,
    byte_length: 1234,
    jpeg_ok: 1,
  });

  assert.strictEqual(isAdminTableName("frames"), true);
  assert.strictEqual(isAdminTableName("participants"), false);
  assert.strictEqual(getAdminParticipantCount(), 1);
  assert.strictEqual(getAdminTableCounts().frames, 1);
  assert.strictEqual(getAdminTableCounts().chunks, 1);

  const framePage = listAdminTableRows("frames", { limit: 50, offset: 0 });
  assert.strictEqual(framePage.total, 1);
  assert.ok(framePage.columns.includes("face_status"));
  assert.strictEqual(framePage.rows[0].participant, "participant-a");

  const allColumnMatch = listAdminTableRows("frames", {
    limit: 50,
    offset: 0,
    search: "camera-a",
  });
  assert.strictEqual(allColumnMatch.total, 1);
  assert.strictEqual(allColumnMatch.rows.length, 1);

  const faceStatusMatch = listAdminTableRows("frames", {
    limit: 50,
    offset: 0,
    search: "PENDING",
    column: "face_status",
  });
  assert.strictEqual(faceStatusMatch.total, 1);

  const wrongColumnMatch = listAdminTableRows("frames", {
    limit: 50,
    offset: 0,
    search: "participant-a",
    column: "device",
  });
  assert.strictEqual(wrongColumnMatch.total, 0);
  assert.throws(
    () =>
      listAdminTableRows("frames", {
        limit: 50,
        offset: 0,
        search: "participant-a",
        column: "not_a_column",
      }),
    /unknown admin table column/,
  );

  const csv = exportAdminTableCsv("frames");
  assert.ok(csv.startsWith("participant,device,session"));
  assert.ok(csv.includes('"participant-a/camera-a/1750000000/frame,1.jpg"'));

  assert.deepStrictEqual(listAdminPhotoParticipants(), [
    { participant: "participant-a", frame_count: 1 },
  ]);
  const sessions = listAdminPhotoSessions();
  assert.strictEqual(sessions.length, 1);
  assert.strictEqual(sessions[0].available_frame_count, 0);

  const photos = listAdminPhotos({
    participant: "participant-a",
    limit: 96,
    offset: 0,
  });
  assert.strictEqual(photos.total, 1);
  assert.strictEqual(photos.rows[0].face_status, "pending");
  assert.deepStrictEqual(
    getAdminFrameAvailabilityByPath(
      "participant-a/camera-a/1750000000/frame,1.jpg",
    ),
    { face_status: "pending", deleted_at: null },
  );

  console.log("Admin data read-model tests passed.");
} finally {
  fs.rmSync(tempDir, { recursive: true, force: true });
}
