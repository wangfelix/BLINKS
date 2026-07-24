import assert = require("assert");
import fs = require("fs");
import path = require("path");
import Database = require("better-sqlite3");
import WebSocket = require("ws");

// End-to-end smoke test against a locally running server. Expects:
//   RECORDINGS_DIR/DATA_DIR pointing at a throwaway directory
//   two users created via create-user (one per study arm):
//     npx tsx scripts/create-user.ts smoketester password123
//     npx tsx scripts/create-user.ts smokecontrol password123 --arm control
//   the server running with DRM_AVAILABLE_FROM_HOUR=0 and DISABLE_PUSH=1
// The test reads RECORDINGS_DIR to reach recordings.db, so it can simulate the
// face-blur worker (face_status='done') and the VLM worker (vlm_status='done'
// + labels/categories) without running the Python processes.
// Run via: npx tsx scripts/smoke-test.ts (against a running server)
//
// Not covered here: the evening-gate hour branch (the server must run with
// DRM_AVAILABLE_FROM_HOUR=0 so the study day is open at all) — isDayAvailable
// is the same three-line comparison as before the rounds rewrite.

const BASE_URL = process.env.SMOKE_BASE_URL ?? "http://127.0.0.1:3100";
const WS_URL = BASE_URL.replace(/^http/, "ws");
const RECORDINGS_DIR = process.env.RECORDINGS_DIR;
const MAIN_USER = "smoketester";
const CONTROL_USER = "smokecontrol";
const PASSWORD = "password123";

// --- Study-day helpers (mirror server/src/time.ts; Europe/Berlin default) ----

const DRM_TZ = process.env.DRM_TZ ?? "Europe/Berlin";
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
// Epoch ms of 12:00 local on a given day (whole-hour offsets, fine for Berlin).
// Anchoring capture times at local noon keeps every synthetic frame inside one
// study day regardless of when the test runs.
const localNoonOf = (day: string): number => {
  const guess = Date.parse(`${day}T12:00:00Z`);
  const guessLocalHour = Number(hourFormatter.format(new Date(guess)));
  return guess - (guessLocalHour - 12) * 3_600_000;
};

const TODAY = dayKeyOf(Date.now());
const TODAY_NOON = localNoonOf(TODAY);

// --- recordings.db access (stand-in for the Python workers) ------------------

const openRecordingsDb = (): Database.Database => {
  if (!RECORDINGS_DIR) {
    throw new Error(
      "set RECORDINGS_DIR (the same value the server runs with) to run this test",
    );
  }
  return new Database(path.join(RECORDINGS_DIR, "recordings.db"));
};

const withDb = <T>(fn: (db: Database.Database) => T): T => {
  const db = openRecordingsDb();
  try {
    return fn(db);
  } finally {
    db.close();
  }
};

// One still-pending frame path, to prove the serving gate refuses it directly.
const peekPendingFilePath = (): string =>
  withDb((db) => {
    const row = db
      .prepare(
        "SELECT file_path FROM frames WHERE face_status = 'pending' LIMIT 1",
      )
      .get() as { file_path: string } | undefined;
    assert.ok(row, "expected a pending frame on disk");
    return row!.file_path;
  });

// Stand in for the face-blur worker: mark every pending frame anonymized.
const markAllAnonymized = (): number =>
  withDb(
    (db) =>
      db
        .prepare(
          "UPDATE frames SET face_status = 'done', face_count = 0, " +
            "face_method = 'smoke', face_completed_at = ? WHERE face_status = 'pending'",
        )
        .run(Date.now()).changes,
  );

// Ingestion-built 5-minute chunks of one participant, ascending.
const getChunks = (
  username: string,
): { chunk_start_ms: number; frame_count: number; status: string }[] =>
  withDb((db) =>
    db
      .prepare(
        "SELECT chunk_start_ms, frame_count, status FROM chunks " +
          "WHERE participant = ? ORDER BY chunk_start_ms",
      )
      .all(username) as {
      chunk_start_ms: number;
      frame_count: number;
      status: string;
    }[],
  );

// Stand in for the VLM chunk worker (and for the idle sweep on the last,
// still-filling window): label one 5-minute chunk as a whole.
const setChunkResult = (
  username: string,
  chunkStartMs: number,
  label: string,
  category: string,
): void =>
  withDb((db) => {
    const changes = db
      .prepare(
        "UPDATE chunks SET status = 'done', vlm_model = 'smoke', " +
          "vlm_label = ?, vlm_category = ?, vlm_completed_at = ? " +
          "WHERE participant = ? AND chunk_start_ms = ?",
      )
      .run(label, category, Date.now(), username, chunkStartMs).changes;
    assert.strictEqual(changes, 1, `chunk update hit ${chunkStartMs}`);
  });

const getChunkCorrections = (
  username: string,
  chunkStartMs: number,
): { category: string | null; activity: string | null } =>
  withDb((db) => {
    const row = db
      .prepare(
        "SELECT user_corrected_category_label AS category, " +
          "user_corrected_activity_label AS activity " +
          "FROM chunks WHERE participant = ? AND chunk_start_ms = ?",
      )
      .get(username, chunkStartMs) as
      | { category: string | null; activity: string | null }
      | undefined;
    assert.ok(row, `expected a chunk at ${chunkStartMs}`);
    return row!;
  });

const getParticipantRow = (
  username: string,
): {
  arm: string;
  push_token: string | null;
  occupation: string | null;
  wake_time: string | null;
  bed_time: string | null;
} =>
  withDb((db) => {
    const row = db
      .prepare(
        "SELECT arm, push_token, occupation, wake_time, bed_time " +
          "FROM participants WHERE username = ?",
      )
      .get(username) as
      | {
          arm: string;
          push_token: string | null;
          occupation: string | null;
          wake_time: string | null;
          bed_time: string | null;
        }
      | undefined;
    assert.ok(row, "participants row exists (created by create-user)");
    return row!;
  });

const getFrameDeletionState = (
  username: string,
  device: string,
  session: number,
  frameIndex: number,
): { file_path: string; deleted_at: number | null } =>
  withDb((db) => {
    const row = db
      .prepare(
        "SELECT file_path, deleted_at FROM frames " +
          "WHERE participant = ? AND device = ? AND session = ? AND frame_index = ?",
      )
      .get(username, device, session, frameIndex) as
      | { file_path: string; deleted_at: number | null }
      | undefined;
    assert.ok(row, `retained frame row ${frameIndex}`);
    return row!;
  });

const countSessionFrameRows = (
  username: string,
  device: string,
  session: number,
): number =>
  withDb((db) => {
    const row = db
      .prepare(
        "SELECT COUNT(*) AS count FROM frames " +
          "WHERE participant = ? AND device = ? AND session = ?",
      )
      .get(username, device, session) as { count: number };
    return row.count;
  });

// Minimal bytes that pass the SOI/EOI JPEG sanity check.
const FAKE_JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x42, 0x42, 0xff, 0xd9]);

const api = async (
  path: string,
  options: {
    method?: string;
    token?: string;
    body?: unknown;
    expectStatus?: number;
  } = {},
): Promise<any> => {
  const response = await fetch(`${BASE_URL}${path}`, {
    method: options.method ?? "GET",
    headers: {
      ...(options.token ? { Authorization: `Bearer ${options.token}` } : {}),
      ...(options.body ? { "Content-Type": "application/json" } : {}),
    },
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  assert.strictEqual(
    response.status,
    options.expectStatus ?? 200,
    `${options.method ?? "GET"} ${path} -> ${response.status}`,
  );
  const contentType = response.headers.get("content-type") ?? "";
  return contentType.includes("application/json")
    ? response.json()
    : response.arrayBuffer();
};

const sendFramesOverWs = (
  token: string,
  session: number,
  frames: { t: number; n: number }[],
  device = "AABBCCDDEEFF",
): Promise<void> =>
  new Promise((resolve, reject) => {
    const ws = new WebSocket(`${WS_URL}/ingest?session=${session}&device=${device}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    ws.on("open", () => {
      for (const frame of frames) {
        ws.send(JSON.stringify(frame));
        ws.send(FAKE_JPEG);
      }
      ws.send("heartbeat");
      setTimeout(() => {
        ws.close();
        resolve();
      }, 300);
    });
    ws.on("error", reject);
  });

const expectWsRejected = (headers?: Record<string, string>): Promise<void> =>
  new Promise((resolve, reject) => {
    const ws = new WebSocket(`${WS_URL}/ingest?session=1&device=X`, { headers });
    ws.on("close", (code: number) => {
      code === 1008
        ? resolve()
        : reject(new Error(`expected close 1008, got ${code}`));
    });
    ws.on("error", () => {}); // close event still fires
  });

const main = async (): Promise<void> => {
  // health is open
  await api("/health");

  // auth required everywhere else
  await api("/api/sessions", { expectStatus: 401 });
  await api("/api/login", {
    method: "POST",
    body: { username: MAIN_USER, password: "wrong-password" },
    expectStatus: 401,
  });

  const { token } = await api("/api/login", {
    method: "POST",
    body: { username: MAIN_USER, password: PASSWORD },
  });
  assert.ok(typeof token === "string" && token.length === 64, "token issued");

  // unauthenticated WS upgrade is rejected
  await expectWsRejected();

  // Before any frames exist: no study day, round 1 is a 404.
  const emptyState = await api("/api/reconstruction/state", { token });
  assert.strictEqual(emptyState.day, null, "no study day before any frames");
  assert.strictEqual(emptyState.available, false);
  await api("/api/reconstruction/round/1", { token, expectStatus: 404 });

  // ingest three frames; phone-stamped capture times anchored at local noon so
  // the DRM day bucketing below is deterministic
  const session = Math.floor(Date.now() / 1000);
  const baseT = TODAY_NOON;
  await sendFramesOverWs(token, session, [
    { t: baseT, n: 1 },
    { t: baseT + 30_000, n: 2 },
    { t: baseT + 60_000, n: 3 },
  ]);

  // reconnect into the same session: frame numbering continues
  await sendFramesOverWs(token, session, [{ t: baseT + 90_000, n: 4 }]);

  const { sessions } = await api("/api/sessions", { token });
  assert.strictEqual(sessions.length, 1, "one session listed");
  assert.strictEqual(sessions[0].frameCount, 4, "4 frames after reconnect");
  assert.strictEqual(sessions[0].startedAtMs, baseT, "phone capture time kept");

  const device = sessions[0].device;

  // Serving gate: until the face-blur worker marks a frame done, it is withheld
  // from both the frame list and direct /frames serving (defense in depth).
  const pendingList = await api(
    `/api/sessions/${device}/${session}/frames`,
    { token },
  );
  assert.strictEqual(
    pendingList.frames.length,
    0,
    "frames withheld until face-blurred",
  );
  const pendingPath = peekPendingFilePath();
  await api(`/frames/${pendingPath}`, { token, expectStatus: 404 });

  // Stand in for the worker finishing, then the same frames become available.
  assert.strictEqual(markAllAnonymized(), 4, "worker marked 4 frames done");

  const { frames } = await api(
    `/api/sessions/${device}/${session}/frames`,
    { token },
  );
  assert.strictEqual(frames.length, 4);
  assert.strictEqual(frames[3].frameIndex, 4, "numbering continued");
  // Anti-leak: the mobile app must never receive VLM output.
  assert.ok(!("vlmStatus" in frames[0]), "no vlmStatus in sessions frames");
  assert.ok(!("vlmLabel" in frames[0]), "no vlmLabel in sessions frames");
  assert.ok(typeof frames[0].captureEpochMs === "number");
  assert.ok(typeof frames[0].imageUrl === "string");

  // image serving with ownership check
  const imageBytes = await api(frames[0].imageUrl, { token });
  assert.strictEqual(imageBytes.byteLength, FAKE_JPEG.length, "jpeg served");
  await api(frames[0].imageUrl, { expectStatus: 401 });
  await api(`/frames/otheruser/some/path.jpg`, { token, expectStatus: 403 });

  // cookie fallback (DRM website <img> tags): /frames/* accepts blinks_token
  const cookieResponse = await fetch(`${BASE_URL}${frames[0].imageUrl}`, {
    headers: { Cookie: `blinks_token=${token}` },
  });
  assert.strictEqual(cookieResponse.status, 200, "cookie auth serves image");
  const badCookieResponse = await fetch(`${BASE_URL}${frames[0].imageUrl}`, {
    headers: { Cookie: "blinks_token=not-a-real-token" },
  });
  assert.strictEqual(badCookieResponse.status, 401, "bad cookie rejected");
  // JSON APIs stay header-only (CSRF hygiene): the cookie must not work there.
  const cookieJsonResponse = await fetch(`${BASE_URL}/api/sessions`, {
    headers: { Cookie: `blinks_token=${token}` },
  });
  assert.strictEqual(cookieJsonResponse.status, 401, "cookie rejected on JSON API");

  // Single delete removes the JPEG, retains a soft-deleted row, clears its
  // serving path, and is idempotent on retry.
  const deletedImageUrl = frames[1].imageUrl;
  const deletedRelativePath = decodeURIComponent(
    deletedImageUrl.slice("/frames/".length),
  );
  const deletedAbsolutePath = path.join(RECORDINGS_DIR!, deletedRelativePath);
  assert.ok(fs.existsSync(deletedAbsolutePath), "frame file exists before delete");
  const singleDelete = await api(
    `/api/sessions/${device}/${session}/frames/2`,
    {
      method: "DELETE",
      token,
    },
  );
  assert.strictEqual(singleDelete.deletedCount, 1);
  assert.strictEqual(singleDelete.alreadyDeletedCount, 0);
  assert.ok(!fs.existsSync(deletedAbsolutePath), "frame file removed");
  const deletedFrameRow = getFrameDeletionState(
    MAIN_USER,
    device,
    session,
    2,
  );
  assert.strictEqual(
    deletedFrameRow.file_path,
    "",
    "soft-deleted row has no serving path",
  );
  assert.ok(
    typeof deletedFrameRow.deleted_at === "number",
    "soft-deleted row carries deletion timestamp",
  );
  await api(deletedImageUrl, { token, expectStatus: 404 });

  const repeatedSingleDelete = await api(
    `/api/sessions/${device}/${session}/frames/2`,
    {
      method: "DELETE",
      token,
    },
  );
  assert.strictEqual(repeatedSingleDelete.deletedCount, 0);
  assert.strictEqual(repeatedSingleDelete.alreadyDeletedCount, 1);

  // Batch delete uses the same soft-delete path, collapses duplicate indexes,
  // and repeated requests do not decrement chunks or counts twice.
  const batchDelete = await api(
    `/api/sessions/${device}/${session}/frames`,
    {
      method: "DELETE",
      token,
      body: { frameIndexes: [3, 4, 4] },
    },
  );
  assert.strictEqual(batchDelete.requestedCount, 2);
  assert.strictEqual(batchDelete.deletedCount, 2);
  assert.strictEqual(batchDelete.alreadyDeletedCount, 0);
  const repeatedBatchDelete = await api(
    `/api/sessions/${device}/${session}/frames`,
    {
      method: "DELETE",
      token,
      body: { frameIndexes: [3, 4] },
    },
  );
  assert.strictEqual(repeatedBatchDelete.deletedCount, 0);
  assert.strictEqual(repeatedBatchDelete.alreadyDeletedCount, 2);
  await api(`/api/sessions/${device}/${session}/frames`, {
    method: "DELETE",
    token,
    body: { frameIndexes: [1, 999_999] },
    expectStatus: 404,
  });
  await api(`/api/sessions/${device}/${session}/frames`, {
    method: "DELETE",
    token,
    body: { frameIndexes: [] },
    expectStatus: 400,
  });

  const afterDelete = await api(
    `/api/sessions/${device}/${session}/frames`,
    { token },
  );
  assert.strictEqual(afterDelete.frames.length, 1, "deleted frames excluded");
  assert.strictEqual(
    countSessionFrameRows(MAIN_USER, device, session),
    4,
    "all database rows retained",
  );
  const afterDeleteSessions = await api("/api/sessions", { token });
  assert.strictEqual(afterDeleteSessions.sessions[0].frameCount, 1);
  assert.strictEqual(afterDeleteSessions.sessions[0].deletedFrameCount, 3);
  const baseSessionCsv = Buffer.from(
    await api(`/api/export.csv?device=${device}&session=${session}`, { token }),
  ).toString("utf8");
  assert.strictEqual(
    baseSessionCsv.trim().split("\n").length,
    2,
    "participant CSV contains only its header and one live frame",
  );

  // pause gate drops ingested frames
  await api("/api/pause", { method: "POST", token });
  await sendFramesOverWs(token, session, [{ t: baseT + 120_000, n: 5 }]);
  const whilePaused = await api(
    `/api/sessions/${device}/${session}/frames`,
    { token },
  );
  assert.strictEqual(whilePaused.frames.length, 1, "paused frame dropped");
  await api("/api/resume", { method: "POST", token });

  // change password: wrong current rejected, then real change + re-login
  await api("/api/change-password", {
    method: "POST",
    token,
    body: { currentPassword: "nope", newPassword: "password456" },
    expectStatus: 403,
  });
  await api("/api/change-password", {
    method: "POST",
    token,
    body: { currentPassword: PASSWORD, newPassword: "password456" },
  });
  await api("/api/login", {
    method: "POST",
    body: { username: MAIN_USER, password: "password456" },
  });

  // =========================================================================
  // DRM subproject: profile (occupation + schedule), push registration,
  // two-round reconstruction API (main arm)
  // =========================================================================

  // profile: arm must never appear; schedule starts empty
  const initialProfile = await api("/api/profile", { token });
  assert.strictEqual(initialProfile.username, MAIN_USER);
  assert.strictEqual(initialProfile.occupation, null);
  assert.strictEqual(initialProfile.workDescription, null);
  assert.strictEqual(initialProfile.wakeTime, null);
  assert.strictEqual(initialProfile.bedTime, null);
  assert.ok(!("arm" in initialProfile), "profile must not reveal the arm");
  assert.ok(
    !("studyDurationDays" in initialProfile),
    "multi-day study length removed",
  );
  assert.strictEqual(initialProfile.drmWebUrl, "http://blinks.win.kit.edu");

  await api("/api/profile", {
    method: "PUT",
    token,
    body: { occupation: 123, workDescription: "x", wakeTime: "07:00", bedTime: "23:00" },
    expectStatus: 400,
  });
  await api("/api/profile", {
    method: "PUT",
    token,
    body: {
      occupation: "PhD student",
      workDescription: "Writes papers.",
      wakeTime: "07:00",
      bedTime: "25:99", // malformed bedtime must be rejected (drives the push)
    },
    expectStatus: 400,
  });
  await api("/api/profile", {
    method: "PUT",
    token,
    body: {
      occupation: "PhD student",
      workDescription: "Writes papers and analyses biosignal data.",
      wakeTime: "07:00",
      bedTime: "23:30",
    },
  });
  const updatedProfile = await api("/api/profile", { token });
  assert.strictEqual(updatedProfile.occupation, "PhD student");
  assert.strictEqual(updatedProfile.wakeTime, "07:00");
  assert.strictEqual(updatedProfile.bedTime, "23:30");
  // Profile PUT must never clobber the provisioned arm.
  assert.strictEqual(
    getParticipantRow(MAIN_USER).arm,
    "main",
    "arm untouched by profile PUT",
  );
  assert.strictEqual(getParticipantRow(MAIN_USER).bed_time, "23:30");

  // push registration
  await api("/api/register-push", {
    method: "POST",
    token,
    body: {},
    expectStatus: 400,
  });
  await api("/api/register-push", {
    method: "POST",
    token,
    body: { expoPushToken: "ExponentPushToken[smoke-test]" },
  });
  assert.strictEqual(
    getParticipantRow(MAIN_USER).push_token,
    "ExponentPushToken[smoke-test]",
    "push token persisted",
  );

  // Ingest the DRM fixture frames: a second block 20 min after the base
  // session (i.e. a >10 min capture gap), shaped to exercise the segmentation
  // generator. Study day = TODAY (the only frame day).
  const assistedSession = session + 2;
  const t0 = baseT + 1_200_000;
  await sendFramesOverWs(token, assistedSession, [
    { t: t0, n: 1 },
    { t: t0 + 120_000, n: 2 },
    { t: t0 + 150_000, n: 3 },
    { t: t0 + 151_000, n: 4 },
    { t: t0 + 300_000, n: 5 },
    { t: t0 + 480_000, n: 6 },
  ]);
  assert.strictEqual(markAllAnonymized(), 6, "face-blur stand-in marked 6 frames");

  // state: study day resolved, round 1 open, round 2 locked with HIDDEN mode
  let state = await api("/api/reconstruction/state", { token });
  assert.strictEqual(state.day, TODAY);
  assert.strictEqual(state.frameCount, 7, "1 base + 6 fixture frames today");
  assert.strictEqual(state.available, true, "DRM_AVAILABLE_FROM_HOUR=0");
  assert.deepStrictEqual(
    state.rounds.map((r: any) => [r.round, r.mode, r.status, r.locked]),
    [
      [1, "self", "none", false],
      [2, null, "none", true],
    ],
    "round 2 locked and its mode hidden until round 1 is submitted",
  );

  // FIXED ORDER, server-enforced: round 2 is inaccessible before round 1 is
  // submitted — reads AND writes.
  await api("/api/reconstruction/round/2", { token, expectStatus: 403 });
  await api("/api/reconstruction/round/2", {
    method: "PUT",
    token,
    body: { activities: [] },
    expectStatus: 403,
  });
  await api("/api/reconstruction/round/3", { token, expectStatus: 400 });

  // Round 1 (self, from memory): no frames, no VLM anything, no proposal.
  const round1 = await api("/api/reconstruction/round/1", { token });
  assert.strictEqual(round1.round, 1);
  assert.strictEqual(round1.mode, "self");
  assert.strictEqual(round1.day, TODAY);
  assert.strictEqual(round1.status, "draft", "pinned on first open");
  assert.deepStrictEqual(round1.activities, []);
  assert.ok(!("frames" in round1), "self round must never include frames");
  assert.ok(
    !("vlmPendingCount" in round1),
    "self round reveals nothing about VLM processing",
  );

  // Self rounds only accept user-sourced activities...
  await api("/api/reconstruction/round/1", {
    method: "PUT",
    token,
    body: {
      activities: [
        {
          startMs: baseT,
          endMs: baseT + 60_000,
          rawLabel: "x",
          categoryLabel: "work",
          source: "vlm",
        },
      ],
    },
    expectStatus: 400,
  });
  // ...and strip any client-smuggled VLM provenance.
  const round1Activities = [
    {
      startMs: baseT - 600_000,
      endMs: baseT + 100_000,
      rawLabel: "Working from memory",
      categoryLabel: "work",
      source: "user",
      vlmRawLabel: "smuggled", // must be dropped server-side
      vlmCategory: "work",
      workloadRating: 7, // top of the 7-point scale, must round-trip
    },
    {
      startMs: t0,
      endMs: t0 + 400_000,
      rawLabel: "Lunch I think",
      categoryLabel: "break",
      source: "user",
      recoveryRating: 2,
    },
  ];
  await api("/api/reconstruction/round/1", {
    method: "PUT",
    token,
    body: { activities: round1Activities },
  });
  const round1Draft = await api("/api/reconstruction/round/1", { token });
  assert.strictEqual(round1Draft.activities.length, 2);
  assert.strictEqual(
    round1Draft.activities[0].vlmRawLabel,
    null,
    "self rounds never store VLM provenance",
  );

  // submit validation: every activity needs a rawLabel AND a categoryLabel
  await api("/api/reconstruction/round/1/submit", {
    method: "POST",
    token,
    body: {
      activities: [
        {
          startMs: baseT,
          endMs: baseT + 90_000,
          rawLabel: "X",
          categoryLabel: null,
          source: "user",
        },
      ],
    },
    expectStatus: 400,
  });

  // ...plus the category's experience rating: a work activity without its
  // workloadRating (or a break without recoveryRating) cannot be submitted,
  // and out-of-range ratings are rejected outright.
  await api("/api/reconstruction/round/1/submit", {
    method: "POST",
    token,
    body: {
      activities: [
        {
          startMs: baseT,
          endMs: baseT + 90_000,
          rawLabel: "X",
          categoryLabel: "work",
          source: "user",
        },
      ],
    },
    expectStatus: 400,
  });
  await api("/api/reconstruction/round/1", {
    method: "PUT",
    token,
    body: {
      activities: [
        {
          startMs: baseT,
          endMs: baseT + 90_000,
          rawLabel: "X",
          categoryLabel: "work",
          source: "user",
          workloadRating: 8, // 7-point Likert: 1-7 only
        },
      ],
    },
    expectStatus: 400,
  });

  const round1Submit = await api("/api/reconstruction/round/1/submit", {
    method: "POST",
    token,
    body: { activities: round1Activities },
  });
  assert.strictEqual(round1Submit.ok, true);
  assert.ok(typeof round1Submit.submittedAt === "number");

  // Experience ratings round-trip: stored and returned per activity.
  const submittedRound1 = await api("/api/reconstruction/round/1", { token });
  assert.deepStrictEqual(
    submittedRound1.activities.map((a: any) => [
      a.workloadRating,
      a.recoveryRating,
    ]),
    [
      [7, null],
      [null, 2],
    ],
    "Likert ratings persist through submit",
  );

  // Round 1 is SELF: submitting must NOT propagate onto the chunks (only the
  // assisted round is chunk-aligned ground truth).
  assert.deepStrictEqual(
    getChunkCorrections(MAIN_USER, baseT),
    { category: null, activity: null },
    "self-round submit does not stamp user_corrected_*",
  );

  // submit is final per round
  await api("/api/reconstruction/round/1", {
    method: "PUT",
    token,
    body: { activities: round1Activities },
    expectStatus: 409,
  });
  await api("/api/reconstruction/round/1/submit", {
    method: "POST",
    token,
    body: { activities: round1Activities },
    expectStatus: 409,
  });

  // state: round 2 unlocked, mode now revealed (main arm -> assisted)
  state = await api("/api/reconstruction/state", { token });
  assert.deepStrictEqual(
    state.rounds.map((r: any) => [r.round, r.mode, r.status, r.locked]),
    [
      [1, "self", "submitted", false],
      [2, "assisted", "none", false],
    ],
    "round 2 unlocks as assisted after round 1 submit (main arm)",
  );

  // Assisted round with pending VLM work: frames served, no proposal yet.
  const pendingRound2 = await api("/api/reconstruction/round/2", { token });
  assert.strictEqual(pendingRound2.mode, "assisted");
  assert.strictEqual(pendingRound2.status, "draft", "pinned on open");
  assert.deepStrictEqual(pendingRound2.activities, []);
  assert.strictEqual(pendingRound2.frames.length, 7, "assisted round lists frames");
  assert.strictEqual(
    pendingRound2.vlmPendingCount,
    7,
    "every frame's chunk still unlabeled -> all 7 pending",
  );

  // Ingestion chunk bookkeeping: the 7 live frames span three clock-aligned
  // 5-minute windows. The two older windows were closed ('ready') by the
  // arrival of later-window frames; the newest stays 'filling' until the
  // idle sweep. The baseT window also proves the frame-delete decrement
  // (4 ingested, 3 soft-deleted -> 1).
  assert.deepStrictEqual(
    getChunks(MAIN_USER).map((c) => [c.chunk_start_ms, c.frame_count, c.status]),
    [
      [baseT, 1, "ready"],
      [t0, 4, "ready"],
      [t0 + 300_000, 2, "filling"],
    ],
    "frames grouped into 5-minute chunks, earlier windows closed",
  );

  // The app's End-session signal (Stop, not Pause) closes the still-filling
  // trailing chunk immediately — no waiting for the idle sweep.
  const ended = await api("/api/recording/ended", { method: "POST", token });
  assert.strictEqual(ended.ok, true);
  assert.strictEqual(ended.closedChunks, 1, "trailing chunk closed on end");
  assert.deepStrictEqual(
    getChunks(MAIN_USER).map((c) => c.status),
    ["ready", "ready", "ready"],
    "every chunk inferable after the end-of-recording signal",
  );
  await api("/api/recording/ended", { method: "POST", expectStatus: 401 });

  // VLM worker stand-in: one label per CHUNK — frames inherit it.
  setChunkResult(MAIN_USER, baseT, "Working at desk", "work");
  setChunkResult(MAIN_USER, t0, "Deep work", "work");
  setChunkResult(MAIN_USER, t0 + 300_000, "Reading paper", "work");

  // assisted round now auto-generates + persists the initial segmentation:
  //   block 1 (base session): lone short segment survives
  //   block 2: two chunks with different labels -> two activities, with
  //   activity bounds at real frame times (not window edges)
  const generated = await api("/api/reconstruction/round/2", { token });
  assert.strictEqual(generated.status, "draft", "generation persisted as draft");
  assert.strictEqual(generated.vlmPendingCount, 0);
  assert.deepStrictEqual(
    generated.activities.map((a: any) => [
      a.startMs,
      a.endMs,
      a.rawLabel,
      a.categoryLabel,
      a.source,
    ]),
    [
      [baseT, baseT, "Working at desk", "work", "vlm"],
      [t0, t0 + 151_000, "Deep work", "work", "vlm"],
      [t0 + 300_000, t0 + 480_000, "Reading paper", "work", "vlm"],
    ],
    "chunk labels group into activities and split at the capture gap",
  );
  assert.strictEqual(generated.activities[1].vlmRawLabel, "Deep work");
  assert.strictEqual(generated.activities[1].vlmCategory, "work");
  assert.strictEqual(generated.frames.length, 7);
  assert.strictEqual(generated.frames[0].vlmLabel, "Working at desk");
  assert.strictEqual(generated.frames[0].vlmCategory, "work");

  // idempotent: a second GET returns the stored draft, no duplicate generation
  const regenerated = await api("/api/reconstruction/round/2", { token });
  assert.strictEqual(regenerated.activities.length, 3, "no re-generation");

  // draft PUT (replace-all): edit a label, insert a user activity; identical
  // spans keep their original VLM proposal for the label-quality analysis
  const editedActivities = [
    {
      startMs: baseT,
      endMs: baseT + 90_000,
      rawLabel: "Working at desk",
      categoryLabel: "work",
      source: "vlm",
      workloadRating: 3,
    },
    {
      startMs: t0,
      endMs: t0 + 151_000,
      rawLabel: "Focused work", // participant corrected the label
      categoryLabel: "work",
      source: "vlm",
      workloadRating: 5,
    },
    {
      startMs: t0 + 152_000,
      endMs: t0 + 299_000,
      rawLabel: "Stretch break",
      categoryLabel: "break",
      source: "user", // participant inserted this one from memory
      recoveryRating: 4,
    },
    {
      startMs: t0 + 300_000,
      endMs: t0 + 480_000,
      rawLabel: "Reading paper",
      categoryLabel: "work",
      source: "vlm",
      workloadRating: 2,
    },
  ];
  await api("/api/reconstruction/round/2", {
    method: "PUT",
    token,
    body: { activities: editedActivities },
  });
  const draft = await api("/api/reconstruction/round/2", { token });
  assert.strictEqual(draft.status, "draft");
  assert.strictEqual(draft.activities.length, 4);
  assert.deepStrictEqual(
    draft.activities.map((a: any) => a.position),
    [0, 1, 2, 3],
    "positions assigned from array order",
  );
  assert.strictEqual(draft.activities[1].rawLabel, "Focused work");
  assert.strictEqual(
    draft.activities[1].vlmRawLabel,
    "Deep work",
    "identical span keeps the original VLM proposal",
  );
  assert.strictEqual(draft.activities[2].source, "user");
  assert.strictEqual(draft.activities[2].vlmRawLabel, null);

  // provenance echo: a boundary edit changes the span (so the DB-side exact
  // span match fails), but the client echoes the original VLM proposal and it
  // survives the save
  const boundaryEdited = editedActivities.map((activity, index) =>
    index === 1
      ? {
          ...activity,
          endMs: t0 + 120_000, // span changed
          vlmRawLabel: "Deep work",
          vlmCategory: "work",
        }
      : activity,
  );
  await api("/api/reconstruction/round/2", {
    method: "PUT",
    token,
    body: { activities: boundaryEdited },
  });
  const afterBoundaryEdit = await api("/api/reconstruction/round/2", { token });
  assert.strictEqual(
    afterBoundaryEdit.activities[1].vlmRawLabel,
    "Deep work",
    "echoed VLM provenance survives a span edit",
  );

  // write validation: overlapping spans and spans outside the study day are
  // rejected
  await api("/api/reconstruction/round/2", {
    method: "PUT",
    token,
    body: {
      activities: [
        { startMs: t0, endMs: t0 + 100_000, rawLabel: "a", categoryLabel: "work", source: "user" },
        { startMs: t0 + 50_000, endMs: t0 + 150_000, rawLabel: "b", categoryLabel: "work", source: "user" },
      ],
    },
    expectStatus: 400,
  });
  await api("/api/reconstruction/round/2", {
    method: "PUT",
    token,
    body: {
      activities: [
        {
          startMs: TODAY_NOON + 86_400_000, // tomorrow: outside the study day
          endMs: TODAY_NOON + 86_460_000,
          rawLabel: "a",
          categoryLabel: "work",
          source: "user",
        },
      ],
    },
    expectStatus: 400,
  });
  // restore the intended draft state before submitting below
  await api("/api/reconstruction/round/2", {
    method: "PUT",
    token,
    body: { activities: editedActivities },
  });

  // participant-facing CSV export must not carry VLM output (anti-leak)
  const { sessions: exportSessions } = await api("/api/sessions", { token });
  const csvBytes = await api(
    `/api/export.csv?device=${exportSessions[0].device}&session=${exportSessions[0].session}`,
    { token },
  );
  const csvText = Buffer.from(csvBytes).toString("utf8");
  assert.ok(
    !csvText.includes("VlmLabel") && !csvText.toLowerCase().includes("vlm"),
    "export.csv carries no VLM columns",
  );

  // submit round 2: atomic save + lock + propagation onto the frames
  const round2Submit = await api("/api/reconstruction/round/2/submit", {
    method: "POST",
    token,
    body: { activities: editedActivities },
  });
  assert.strictEqual(round2Submit.ok, true);

  state = await api("/api/reconstruction/state", { token });
  assert.deepStrictEqual(
    state.rounds.map((r: any) => r.status),
    ["submitted", "submitted"],
  );

  // locked: no further submit or draft save
  await api("/api/reconstruction/round/2/submit", {
    method: "POST",
    token,
    body: { activities: editedActivities },
    expectStatus: 409,
  });
  await api("/api/reconstruction/round/2", {
    method: "PUT",
    token,
    body: { activities: editedActivities },
    expectStatus: 409,
  });

  // propagation (ASSISTED round only): chunks overlapping each span carry the
  // submitted labels. The t0 chunk straddles "Focused work" AND the
  // user-inserted "Stretch break"; activities stamp in position order, so the
  // later one deterministically wins the boundary chunk. Round 1's differing
  // self labels ("Working from memory") must NOT appear anywhere.
  assert.deepStrictEqual(getChunkCorrections(MAIN_USER, baseT), {
    category: "work",
    activity: "Working at desk",
  });
  assert.deepStrictEqual(
    getChunkCorrections(MAIN_USER, t0),
    { category: "break", activity: "Stretch break" },
    "boundary chunk stamped by the later overlapping activity",
  );
  assert.deepStrictEqual(getChunkCorrections(MAIN_USER, t0 + 300_000), {
    category: "work",
    activity: "Reading paper",
  });

  // =========================================================================
  // Control arm: round 2 is SELF again — no frames, no VLM, no propagation
  // =========================================================================

  const { token: controlToken } = await api("/api/login", {
    method: "POST",
    body: { username: CONTROL_USER, password: PASSWORD },
  });
  assert.strictEqual(getParticipantRow(CONTROL_USER).arm, "control");

  const controlSession = session + 3;
  const c0 = TODAY_NOON + 3_600_000; // 13:00 local
  await sendFramesOverWs(
    controlToken,
    controlSession,
    [
      { t: c0, n: 1 },
      { t: c0 + 60_000, n: 2 },
    ],
    "BBCCDDEEFF00",
  );
  assert.strictEqual(markAllAnonymized(), 2, "control frames anonymized");
  // Give the control chunk a VLM label so the no-leak assertions below are
  // meaningful (labels exist server-side but must never reach this user).
  setChunkResult(CONTROL_USER, c0, "Cooking dinner", "other");

  const controlActivities = [
    {
      startMs: c0 - 600_000,
      endMs: c0 + 600_000,
      rawLabel: "Cooking",
      categoryLabel: "other",
      source: "user",
    },
  ];

  // Round 1 self, submit.
  const controlRound1 = await api("/api/reconstruction/round/1", {
    token: controlToken,
  });
  assert.strictEqual(controlRound1.mode, "self");
  assert.ok(!("frames" in controlRound1));
  await api("/api/reconstruction/round/1/submit", {
    method: "POST",
    token: controlToken,
    body: { activities: controlActivities },
  });

  // Round 2 unlocks as SELF (control arm), still without frames or VLM.
  const controlState = await api("/api/reconstruction/state", {
    token: controlToken,
  });
  assert.deepStrictEqual(
    controlState.rounds.map((r: any) => [r.round, r.mode, r.locked]),
    [
      [1, "self", false],
      [2, "self", false],
    ],
    "control arm: round 2 is self again",
  );
  const controlRound2 = await api("/api/reconstruction/round/2", {
    token: controlToken,
  });
  assert.strictEqual(controlRound2.mode, "self");
  assert.deepStrictEqual(controlRound2.activities, []);
  assert.ok(
    !("frames" in controlRound2),
    "control round 2 must never include frames/VLM output",
  );
  assert.ok(!("vlmPendingCount" in controlRound2));

  await api("/api/reconstruction/round/2/submit", {
    method: "POST",
    token: controlToken,
    body: { activities: controlActivities },
  });
  // Self rounds never propagate — the control arm leaves user_corrected_*
  // untouched (its VLM-accuracy value comes from comparing the activities
  // table to vlm_* researcher-side).
  assert.deepStrictEqual(
    getChunkCorrections(CONTROL_USER, c0),
    { category: null, activity: null },
    "control-arm submits never stamp user_corrected_*",
  );

  console.log("SMOKE TEST PASSED");
};

main().catch((error) => {
  console.error("SMOKE TEST FAILED:", error.message);
  process.exit(1);
});
