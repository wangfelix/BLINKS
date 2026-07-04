import fs = require("fs");
import path = require("path");
import Database = require("better-sqlite3");

import { hashPassword } from "../src/auth";
import { getUser, initAuthDb, insertUser, updatePasswordHash } from "../src/auth-db";
import { initDb, insertFrame } from "../src/db";

// Seeds a fully clickable demo state for testing drm-web locally:
//
//   npx tsx scripts/seed-demo-data.ts [username] [password]   (default demo / demo12345)
//
// Creates the auth user, a participants row with plan ["control","assisted"],
// and two study days of frames (yesterday = control, today = assisted;
// 09:00-16:15 local, one frame per 5 min) with face_status='done' and a
// plausible VLM label timeline, so the assisted day auto-segments into ~8
// activities and the control day offers manual entry.
//
// Respects RECORDINGS_DIR / DATA_DIR / AUTH_DB_PATH like the server — run it
// with the SAME env values the server uses. JPEG bytes are copied from the
// first real frame found under RECORDINGS_DIR (falls back to an embedded
// 1x1 JPEG, which renders as a grey thumbnail).
//
// Cleanup: delete the user's directory under recordings/ and their rows in
// frames/participants/reconstructions/activities (+ the auth user).

const RECORDINGS_DIR =
  process.env.RECORDINGS_DIR ?? path.join(__dirname, "..", "recordings");
const DATA_DIR = process.env.DATA_DIR ?? path.join(__dirname, "..", "data");
const DRM_TZ = process.env.DRM_TZ ?? "Europe/Berlin";

const USERNAME = process.argv[2] ?? "demo";
const PASSWORD = process.argv[3] ?? "demo12345";
const DEVICE = "DEMOCAM00001";
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

  // auth user
  const passwordHash = await hashPassword(PASSWORD);
  if (getUser(USERNAME)) {
    updatePasswordHash(USERNAME, passwordHash);
    console.log(`Auth user '${USERNAME}' already existed, password reset.`);
  } else {
    insertUser(USERNAME, passwordHash);
    console.log(`Created auth user '${USERNAME}'.`);
  }

  const jpegSource = findRealJpeg(RECORDINGS_DIR);
  const jpegBytes = jpegSource ? fs.readFileSync(jpegSource) : FALLBACK_JPEG;
  console.log(
    jpegSource
      ? `Thumbnails use a real frame: ${path.relative(RECORDINGS_DIR, jpegSource)}`
      : "No real frame found; thumbnails will be a grey placeholder.",
  );

  const db = new Database(path.join(RECORDINGS_DIR, "recordings.db"));
  try {
    // participants row: yesterday control, today assisted; occupation filled
    // so the profile gate in the mobile app / VLM context is satisfied.
    db.prepare(
      `INSERT INTO participants
         (username, occupation, work_description, condition_plan, created_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(username) DO UPDATE SET
         occupation = excluded.occupation,
         work_description = excluded.work_description,
         condition_plan = excluded.condition_plan,
         updated_at = excluded.created_at`,
    ).run(
      USERNAME,
      "PhD student (demo)",
      "Research, writing, and data analysis at a computer (demo account).",
      JSON.stringify(["control", "assisted"]),
      Date.now(),
    );

    // wipe any previous demo frames/reconstructions for repeatable runs
    for (const table of ["frames", "reconstructions", "activities"]) {
      db.prepare(`DELETE FROM ${table} WHERE participant = ?`).run(USERNAME);
    }

    const markProcessed = db.prepare(
      `UPDATE frames SET
         face_status = 'done', face_count = 0, face_method = 'seed',
         face_completed_at = ?, vlm_status = 'done', vlm_model = 'seed',
         vlm_label = ?, vlm_category = ?, vlm_completed_at = ?
       WHERE participant = ? AND device = ? AND session = ? AND frame_index = ?`,
    );

    const today = dayKeyOf(Date.now());
    const yesterday = dayKeyOf(localNoonOf(today) - 86_400_000);

    for (const day of [yesterday, today]) {
      const dayStartMs = localNoonOf(day) - 3 * 3_600_000; // 09:00 local
      const session = Math.floor(dayStartMs / 1000);
      const imagesDir = path.join(
        RECORDINGS_DIR,
        USERNAME,
        DEVICE,
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
            participant: USERNAME,
            device: DEVICE,
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
            USERNAME,
            DEVICE,
            session,
            frameIndex,
          );
        }
      }
      console.log(`Seeded ${day}: ${frameIndex} frames (session ${session}).`);
    }

    console.log(`
Done. Log into drm-web as '${USERNAME}' / '${PASSWORD}':
  ${yesterday} -> day 1, CONTROL  (manual entry, no frames shown)
  ${today} -> day 2, ASSISTED (auto-segmented, editable, with frames)
Run the server with DRM_AVAILABLE_FROM_HOUR=0 to test today before 19:00.`);
  } finally {
    db.close();
  }
};

void main();
