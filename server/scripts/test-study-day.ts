// Unit test for the SESSION-ANCHORED study day (db.ts + time.ts). A study day
// is the local date of the recording session's Start tap, not the local date
// of each individual frame, so a session that runs past local midnight stays
// one single day instead of splitting into a field day plus a sliver on the
// next calendar date. Runs against a throwaway DB in a temp dir.
//
//   npx tsx scripts/test-study-day.ts

import assert = require("assert");
import fs = require("fs");
import os = require("os");
import path = require("path");
import Database = require("better-sqlite3");

import {
  aggregateFrameDays,
  CHUNK_WINDOW_MS,
  chunkStartOf,
  countFramesOnDay,
  dayBoundsMs,
  initDb,
  insertFrame,
  latestFrameDay,
  listChunksOnDay,
  listFramesOnDay,
  listPhotoFramesOnDay,
} from "../src/db";
import {
  DAY_OVERRUN_MS,
  localDayStartMs,
  nextDayKey,
  sessionDayKey,
} from "../src/time";

process.env.TZ = process.env.TZ ?? "UTC"; // the study TZ comes from DRM_TZ

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "blinks-study-day-test-"));
initDb(path.join(dir, "recordings.db"));
const db = new Database(path.join(dir, "recordings.db"));

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

const HOUR_MS = 3_600_000;
const FIELD_DAY = "2026-08-07";

// The reported case: start 07.08 at 03:00 local, end 08.08 at 00:51 local.
const sessionStartMs = localDayStartMs(FIELD_DAY) + 3 * HOUR_MS;
const session = Math.floor(sessionStartMs / 1000);
const lastFrameMs = localDayStartMs(nextDayKey(FIELD_DAY)) + 51 * 60_000;

let frameIndex = 0;
const addFrame = (participant: string, sessionId: number, captureMs: number) => {
  insertFrame({
    participant,
    device: "d",
    session: sessionId,
    frame_index: frameIndex,
    capture_epoch_ms: captureMs,
    received_epoch_ms: captureMs,
    file_path: `f${frameIndex}.jpg`,
    device_frame: frameIndex,
    byte_length: 10,
    jpeg_ok: 1,
  });
  frameIndex += 1;
};

// Hourly frames across the whole overnight session, plus the two after
// midnight that used to become a study day of their own.
for (let ms = sessionStartMs; ms <= lastFrameMs; ms += HOUR_MS) {
  addFrame("p", session, ms);
}
addFrame("p", session, lastFrameMs);

check(
  "the session's own day key is its local start date",
  sessionDayKey(session),
  FIELD_DAY,
);

check(
  "a session that runs past midnight produces exactly one study day",
  aggregateFrameDays("p").map((aggregate) => aggregate.day),
  [FIELD_DAY],
);

check(
  "the study day is the field day, not the next calendar date",
  latestFrameDay("p"),
  FIELD_DAY,
);

const fieldDayFrameCount = frameIndex;
check(
  "every frame of the session counts towards its study day",
  countFramesOnDay("p", FIELD_DAY),
  fieldDayFrameCount,
);

check(
  "frames captured after midnight stay on the field day",
  listFramesOnDay("p", FIELD_DAY).filter(
    (frame) => frame.capture_epoch_ms >= localDayStartMs(nextDayKey(FIELD_DAY)),
  ).length,
  2,
);

check(
  "the next calendar date holds no separate sliver day",
  countFramesOnDay("p", nextDayKey(FIELD_DAY)),
  0,
);

check(
  "chunks filled after midnight belong to the field day",
  listChunksOnDay("p", FIELD_DAY).filter(
    (chunk) => chunk.chunk_start_ms >= localDayStartMs(nextDayKey(FIELD_DAY)),
  ).length,
  2,
);

// Photo management only ever sees face-anonymized frames; the day anchor must
// carry through that gate unchanged.
check(
  "the photo audit withholds frames that are not anonymized yet",
  listPhotoFramesOnDay("p", FIELD_DAY).length,
  0,
);
db.prepare("UPDATE frames SET face_status = 'done'").run();
check(
  "photo audit rows follow the same day anchor",
  listPhotoFramesOnDay("p", FIELD_DAY).length,
  fieldDayFrameCount,
);

// The day's epoch extent: the calendar day, extended to cover the overrun so
// a reconstructed activity may end after midnight.
const bounds = dayBoundsMs("p", FIELD_DAY);
check("the day starts at its local midnight", bounds.startMs, localDayStartMs(FIELD_DAY));
check(
  "the day ends past midnight, covering both the overrun and the last chunk",
  bounds.endMs,
  Math.max(
    localDayStartMs(nextDayKey(FIELD_DAY)) + DAY_OVERRUN_MS,
    chunkStartOf(lastFrameMs) + CHUNK_WINDOW_MS,
  ),
);
check(
  "the extended end covers every segmented activity boundary",
  listChunksOnDay("p", FIELD_DAY).every(
    (chunk) => chunk.chunk_end_ms <= bounds.endMs,
  ),
  true,
);

// A participant whose recording ends before midnight still gets the overrun:
// round 1 reconstructs from memory, so "I went to bed at 00:30" must be
// expressible even though the camera stopped hours earlier.
const ordinaryDay = "2026-08-05";
const ordinarySession = Math.floor(
  (localDayStartMs(ordinaryDay) + 9 * HOUR_MS) / 1000,
);
addFrame("q", ordinarySession, localDayStartMs(ordinaryDay) + 9 * HOUR_MS);
addFrame("q", ordinarySession, localDayStartMs(ordinaryDay) + 17 * HOUR_MS);
check(
  "a day whose recording ended early still reaches past midnight",
  dayBoundsMs("q", ordinaryDay),
  {
    startMs: localDayStartMs(ordinaryDay),
    endMs: localDayStartMs(nextDayKey(ordinaryDay)) + DAY_OVERRUN_MS,
  },
);

// Two sessions on different days must not bleed into each other, including
// when the earlier one ran past midnight into the later one's calendar date.
const nextSessionMs = localDayStartMs(nextDayKey(FIELD_DAY)) + 9 * HOUR_MS;
const nextSession = Math.floor(nextSessionMs / 1000);
addFrame("p", nextSession, nextSessionMs);
check(
  "a following day's session forms its own study day",
  aggregateFrameDays("p").map((aggregate) => [
    aggregate.day,
    aggregate.frameCount,
  ]),
  [
    [FIELD_DAY, fieldDayFrameCount],
    [nextDayKey(FIELD_DAY), 1],
  ],
);
check(
  "the later day contains only its own session's frames",
  listFramesOnDay("p", nextDayKey(FIELD_DAY)).map(
    (frame) => frame.capture_epoch_ms,
  ),
  [nextSessionMs],
);

fs.rmSync(dir, { recursive: true, force: true });

if (failures > 0) {
  console.error(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log("\nSTUDY DAY TESTS PASSED");
