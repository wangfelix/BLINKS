import fs = require("fs");
import path = require("path");
import Database = require("better-sqlite3");

import { hashPassword } from "../src/auth";
import { getUser, initAuthDb, insertUser, updatePasswordHash } from "../src/auth-db";
import { initDb, insertFrame } from "../src/db";

// Seeds a fully clickable demo state for testing drm-web locally:
//
//   npx tsx scripts/seed-demo-data.ts
//
// Creates TWO demo participants, each with one fully labeled field day
// (today, 09:00-16:15 local, one frame per 5 min, face_status='done', a
// plausible VLM label timeline):
//
//   demo    / demo12345  -> MAIN arm    (round 2 = VLM-assisted)
//   democtl / demo12345  -> CONTROL arm (round 2 = self again)
//
// so the whole two-round flow is clickable for both arms without a
// camera/VLM run. Occupation + schedule are pre-filled (the app onboarding
// gate and the bedtime reminder are satisfied).
//
// Respects RECORDINGS_DIR / DATA_DIR / AUTH_DB_PATH like the server — run it
// with the SAME env values the server uses. JPEG bytes are copied from the
// first real frame found under RECORDINGS_DIR (falls back to an embedded
// 1x1 JPEG, which renders as a grey thumbnail).
//
// Re-runnable: wipes and re-seeds the demo users' frames, reconstructions
// and activities. Run the server with DRM_AVAILABLE_FROM_HOUR=0 to test
// before 19:00.

const RECORDINGS_DIR =
  process.env.RECORDINGS_DIR ?? path.join(__dirname, "..", "recordings");
const DATA_DIR = process.env.DATA_DIR ?? path.join(__dirname, "..", "data");
const DRM_TZ = process.env.DRM_TZ ?? "Europe/Berlin";

const PASSWORD = process.argv[2] ?? "demo12345";
const USERS: { username: string; arm: "main" | "control"; device: string }[] = [
  { username: "demo", arm: "main", device: "DEMOCAM00001" },
  { username: "democtl", arm: "control", device: "DEMOCAM00002" },
];
const FRAME_INTERVAL_MS = 5 * 60_000;

// (label from ACTIVITY_VOCABULARY, category, duration in minutes)
const DAY_TIMELINE: [string, string, number][] = [
  ["working at computer", "work", 85],
  ["drinking coffee or tea", "break", 20],
  ["in a meeting", "work", 70],
  ["eating a meal", "break", 40],
  ["working at computer", "work", 125],
  ["walking outside", "break", 15],
  ["reading documents", "work", 60],
  ["household chores", "other", 20],
];

// 1x1 grey JPEG (valid SOI..EOI), used only when no real frame exists yet.
const FALLBACK_JPEG = Buffer.from(
  "/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRof" +
    "Hh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAAB" +
    "AAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AVN//2Q==",
  "base64",
);

const dayKeyFormatter = new Intl.DateTimeFormat("en-CA", {
  timeZone: DRM_TZ,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});
const hourFormatter = new Intl.DateTimeFormat("en-GB", {
  timeZone: DRM_TZ,
  hour: "2-digit",
  hourCycle: "h23",
});
const dayKeyOf = (epochMs: number): string =>
  dayKeyFormatter.format(new Date(epochMs));
// Epoch ms of 12:00 local on a given day (whole-hour zone offsets).
const localNoonOf = (day: string): number => {
  const guess = Date.parse(`${day}T12:00:00Z`);
  const guessLocalHour = Number(hourFormatter.format(new Date(guess)));
  return guess - (guessLocalHour - 12) * 3_600_000;
};

const findRealJpeg = (dir: string, depth = 0): string | null => {
  if (depth > 6 || !fs.existsSync(dir)) return null;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const entryPath = path.join(dir, entry.name);
    if (entry.isFile() && entry.name.endsWith(".jpg")) return entryPath;
    if (entry.isDirectory()) {
      const found = findRealJpeg(entryPath, depth + 1);
      if (found) return found;
    }
  }
  return null;
};

const main = async (): Promise<void> => {
  fs.mkdirSync(RECORDINGS_DIR, { recursive: true });
  fs.mkdirSync(DATA_DIR, { recursive: true });
  initDb(path.join(RECORDINGS_DIR, "recordings.db"));
  initAuthDb(process.env.AUTH_DB_PATH ?? path.join(DATA_DIR, "auth.db"));

  const passwordHash = await hashPassword(PASSWORD);
  const jpegSource = findRealJpeg(RECORDINGS_DIR);
  const jpegBytes = jpegSource ? fs.readFileSync(jpegSource) : FALLBACK_JPEG;
  console.log(
    jpegSource
      ? `Thumbnails use a real frame: ${path.relative(RECORDINGS_DIR, jpegSource)}`
      : "No real frame found; thumbnails will be a grey placeholder.",
  );

  const db = new Database(path.join(RECORDINGS_DIR, "recordings.db"));
  try {
    const markProcessed = db.prepare(
      `UPDATE frames SET
         face_status = 'done', face_count = 0, face_method = 'seed',
         face_completed_at = ?, vlm_status = 'done', vlm_model = 'seed',
         vlm_label = ?, vlm_category = ?, vlm_completed_at = ?
       WHERE participant = ? AND device = ? AND session = ? AND frame_index = ?`,
    );

    const today = dayKeyOf(Date.now());

    for (const user of USERS) {
      if (getUser(user.username)) {
        updatePasswordHash(user.username, passwordHash);
        console.log(`Auth user '${user.username}' already existed, password reset.`);
      } else {
        insertUser(user.username, passwordHash);
        console.log(`Created auth user '${user.username}'.`);
      }

      // participants row: arm + occupation + schedule pre-filled so the app
      // onboarding gate and the bedtime reminder are satisfied.
      db.prepare(
        `INSERT INTO participants
           (username, occupation, work_description, wake_time, bed_time, arm, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(username) DO UPDATE SET
           occupation = excluded.occupation,
           work_description = excluded.work_description,
           wake_time = excluded.wake_time,
           bed_time = excluded.bed_time,
           arm = excluded.arm,
           updated_at = excluded.created_at`,
      ).run(
        user.username,
        "PhD student (demo)",
        "Research, writing, and data analysis at a computer (demo account).",
        "07:30",
        "23:00",
        user.arm,
        Date.now(),
      );

      // wipe any previous demo state for repeatable runs
      for (const table of ["frames", "reconstructions", "activities"]) {
        db.prepare(`DELETE FROM ${table} WHERE participant = ?`).run(
          user.username,
        );
      }

      const dayStartMs = localNoonOf(today) - 3 * 3_600_000; // 09:00 local
      const session = Math.floor(dayStartMs / 1000);
      const imagesDir = path.join(
        RECORDINGS_DIR,
        user.username,
        user.device,
        String(session),
        "images",
      );
      fs.mkdirSync(imagesDir, { recursive: true });

      let frameIndex = 0;
      let cursorMs = dayStartMs;
      for (const [label, category, minutes] of DAY_TIMELINE) {
        const segmentEndMs = cursorMs + minutes * 60_000;
        for (; cursorMs < segmentEndMs; cursorMs += FRAME_INTERVAL_MS) {
          frameIndex += 1;
          const fileName = `frame-${String(frameIndex).padStart(6, "0")}-${cursorMs}.jpg`;
          const filePath = path.join(imagesDir, fileName);
          fs.writeFileSync(filePath, jpegBytes);
          insertFrame({
            participant: user.username,
            device: user.device,
            session,
            frame_index: frameIndex,
            capture_epoch_ms: cursorMs,
            received_epoch_ms: cursorMs + 150,
            file_path: path.relative(RECORDINGS_DIR, filePath),
            device_frame: frameIndex,
            byte_length: jpegBytes.length,
            jpeg_ok: 1,
          });
          markProcessed.run(
            Date.now(),
            label,
            category,
            Date.now(),
            user.username,
            user.device,
            session,
            frameIndex,
          );
        }
      }
      console.log(
        `Seeded ${user.username} (${user.arm} arm): ${frameIndex} frames on ${today}.`,
      );
    }

    console.log(`
Done. Log into drm-web:
  demo    / '${PASSWORD}'  -> MAIN arm    (step 1 self, step 2 VLM-assisted)
  democtl / '${PASSWORD}'  -> CONTROL arm (step 1 self, step 2 self again)
Run the server with DRM_AVAILABLE_FROM_HOUR=0 to test today before 19:00.`);
  } finally {
    db.close();
  }
};

void main();
