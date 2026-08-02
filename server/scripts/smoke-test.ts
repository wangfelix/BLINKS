import assert = require("assert");
import fs = require("fs");
import path = require("path");
import Database = require("better-sqlite3");
import WebSocket = require("ws");
import { ACTIVITY_LABELS } from "../src/activity-vocabulary";

// End-to-end smoke test against a locally running server. Expects:
//   RECORDINGS_DIR/DATA_DIR pointing at a throwaway directory
//   two users created via create-user:
//     npx tsx scripts/create-user.ts smoketester password123
//     npx tsx scripts/create-user.ts smokesecond password123
//   the server running with DRM_AVAILABLE_FROM_HOUR=0 and DISABLE_PUSH=1
// The test reads RECORDINGS_DIR to reach recordings.db, so it can simulate the
// face-blur worker (face_status='done') and the chunk VLM worker
// (chunks.status='done' + labels/categories) without running Python.
// Run via: npx tsx scripts/smoke-test.ts (against a running server)
//
// Not covered here: the evening-gate hour branch (the server must run with
// DRM_AVAILABLE_FROM_HOUR=0 so the study day is open at all) — isDayAvailable
// is the same three-line comparison as before the rounds rewrite.

const BASE_URL = process.env.SMOKE_BASE_URL ?? "http://127.0.0.1:3100";
const WS_URL = BASE_URL.replace(/^http/, "ws");
const RECORDINGS_DIR = process.env.RECORDINGS_DIR;
const MAIN_USER = "smoketester";
const SECOND_USER = "smokesecond";
const PASSWORD = "password123";
const PRIVATE_PASSWORD = "password456";
const UPDATED_PASSWORD = "password789";
const CATEGORY_LABELS = ["work", "break", "other"] as const;
const confidenceScores = (
  selectedLabel: string,
  selectedScore: number,
): string => {
  const remainder = (1 - selectedScore) / (ACTIVITY_LABELS.length - 1);
  return JSON.stringify(
    Object.fromEntries(
      ACTIVITY_LABELS.map((label) => [
        label,
        label === selectedLabel ? selectedScore : remainder,
      ]),
    ),
  );
};
const categoryConfidenceScores = (
  selectedLabel: string,
  selectedScore: number,
): string => {
  const remainder = (1 - selectedScore) / (CATEGORY_LABELS.length - 1);
  return JSON.stringify(
    Object.fromEntries(
      CATEGORY_LABELS.map((label) => [
        label,
        label === selectedLabel ? selectedScore : remainder,
      ]),
    ),
  );
};

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
  confidence = 0.9,
): void =>
  withDb((db) => {
    const changes = db
      .prepare(
        "UPDATE chunks SET status = 'done', vlm_model = 'smoke', " +
          "vlm_label = ?, vlm_category = ?, vlm_activity_confidence = ?, " +
          "vlm_activity_confidences_json = ?, vlm_category_confidence = ?, " +
          "vlm_category_confidences_json = ?, vlm_completed_at = ? " +
          "WHERE participant = ? AND chunk_start_ms = ?",
      )
      .run(
        label,
        category,
        confidence,
        confidenceScores(label, confidence),
        confidence,
        categoryConfidenceScores(category, confidence),
        Date.now(),
        username,
        chunkStartMs,
      ).changes;
    assert.strictEqual(changes, 1, `chunk update hit ${chunkStartMs}`);
  });

const markChunkFailed = (username: string, chunkStartMs: number): void =>
  withDb((db) => {
    const changes = db
      .prepare(
        "UPDATE chunks SET status = 'failed', vlm_model = 'smoke', " +
          "vlm_label = NULL, vlm_category = NULL, vlm_completed_at = ? " +
          "WHERE participant = ? AND chunk_start_ms = ?",
      )
      .run(Date.now(), username, chunkStartMs).changes;
    assert.strictEqual(changes, 1, `failed chunk update hit ${chunkStartMs}`);
  });

const getRecordingEvents = (
  username: string,
  session: number,
): {
  event_id: string;
  event_type: string;
  client_epoch_ms: number;
  server_received_epoch_ms: number;
  sequence_number: number;
}[] =>
  withDb((db) =>
    db
      .prepare(
        "SELECT event_id, event_type, client_epoch_ms, " +
          "server_received_epoch_ms, sequence_number " +
          "FROM recording_events WHERE participant = ? AND session = ? " +
          "ORDER BY sequence_number",
      )
      .all(username, session) as {
      event_id: string;
      event_type: string;
      client_epoch_ms: number;
      server_received_epoch_ms: number;
      sequence_number: number;
    }[],
  );

const getStoredActivityLists = (
  username: string,
): {
  id: number;
  round: number;
  kind: string;
  immutable: number;
  status: string | null;
  proposal_viewed_at: number | null;
  items: {
    position: number;
    start_ms: number;
    end_ms: number;
    raw_label: string | null;
    category_label: string | null;
    source: string;
    proposal_activity_id: number | null;
    vlm_raw_label: string | null;
    vlm_category: string | null;
    vlm_mean_activity_confidence: number | null;
    vlm_mean_activity_confidences_json: string | null;
    vlm_mean_category_confidence: number | null;
    vlm_mean_category_confidences_json: string | null;
    presented_raw_label: string | null;
    presented_category_label: string | null;
    is_incorrect_annotation_injected: number;
  }[];
}[] =>
  withDb((db) => {
    const lists = db
      .prepare(
        "SELECT id, round, kind, immutable, status, proposal_viewed_at " +
          "FROM activity_lists " +
          "WHERE participant = ? ORDER BY round, kind",
      )
      .all(username) as {
      id: number;
      round: number;
      kind: string;
      immutable: number;
      status: string | null;
      proposal_viewed_at: number | null;
    }[];
    const items = db.prepare(
      "SELECT position, start_ms, end_ms, raw_label, category_label, source, " +
        "proposal_activity_id, vlm_raw_label, vlm_category, " +
        "vlm_mean_activity_confidence, vlm_mean_activity_confidences_json, " +
        "vlm_mean_category_confidence, vlm_mean_category_confidences_json, " +
        "presented_raw_label, presented_category_label, " +
        "is_incorrect_annotation_injected " +
        "FROM activities WHERE activity_list_id = ? " +
        "ORDER BY position",
    );
    return lists.map((list) => ({
      ...list,
      items: items.all(list.id) as {
        position: number;
        start_ms: number;
        end_ms: number;
        raw_label: string | null;
        category_label: string | null;
        source: string;
        proposal_activity_id: number | null;
        vlm_raw_label: string | null;
        vlm_category: string | null;
        vlm_mean_activity_confidence: number | null;
        vlm_mean_activity_confidences_json: string | null;
        vlm_mean_category_confidence: number | null;
        vlm_mean_category_confidences_json: string | null;
        presented_raw_label: string | null;
        presented_category_label: string | null;
        is_incorrect_annotation_injected: number;
      }[],
    }));
  });

const getParticipantRow = (
  username: string,
): {
  push_token: string | null;
  occupation: string | null;
  wake_time: string | null;
  bed_time: string | null;
} =>
  withDb((db) => {
    const row = db
      .prepare(
        "SELECT push_token, occupation, wake_time, bed_time " +
          "FROM participants WHERE username = ?",
      )
      .get(username) as
      | {
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

  const loginResponse = await api("/api/login", {
    method: "POST",
    body: { username: MAIN_USER, password: PASSWORD },
  });
  const { token } = loginResponse;
  assert.ok(typeof token === "string" && token.length === 64, "token issued");
  assert.strictEqual(loginResponse.onboarding.mustChangePassword, true);
  assert.strictEqual(loginResponse.onboarding.completed, false);

  // The first-run gate protects the DRM web workflow while leaving mobile
  // capture/profile APIs available for lab device setup.
  await api("/api/sessions", { token });
  const onboardingGate = await api("/api/reconstruction/state", {
    token,
    expectStatus: 403,
  });
  assert.strictEqual(onboardingGate.code, "onboarding_required");
  await api("/api/onboarding/complete", {
    method: "POST",
    token,
    expectStatus: 409,
  });
  await api("/api/onboarding/password", {
    method: "POST",
    token,
    body: { newPassword: "short" },
    expectStatus: 400,
  });
  await api("/api/onboarding/password", {
    method: "POST",
    token,
    body: { newPassword: PASSWORD },
    expectStatus: 400,
  });
  const passwordChanged = await api("/api/onboarding/password", {
    method: "POST",
    token,
    body: { newPassword: PRIVATE_PASSWORD },
  });
  assert.strictEqual(passwordChanged.mustChangePassword, false);
  assert.strictEqual(passwordChanged.completed, false);
  await api("/api/onboarding/password", {
    method: "POST",
    token,
    body: { newPassword: UPDATED_PASSWORD },
    expectStatus: 409,
  });
  const onboardingCompleted = await api("/api/onboarding/complete", {
    method: "POST",
    token,
  });
  assert.strictEqual(onboardingCompleted.completed, true);
  assert.ok(onboardingCompleted.onboardingCompletedAt > 0);
  await api("/api/login", {
    method: "POST",
    body: { username: MAIN_USER, password: PASSWORD },
    expectStatus: 401,
  });
  const relogin = await api("/api/login", {
    method: "POST",
    body: { username: MAIN_USER, password: PRIVATE_PASSWORD },
  });
  assert.strictEqual(relogin.onboarding.completed, true);

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
  const startedEvent = {
    eventId: `${session}-0`,
    session,
    clientEpochMs: baseT,
    sequenceNumber: 0,
  };
  const started = await api("/api/recording/started", {
    method: "POST",
    token,
    body: startedEvent,
  });
  assert.strictEqual(started.paused, false);
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

  // Recording events are append-only and idempotent; a pause event also drives
  // the defense-in-depth ingestion gate.
  const pauseEvent = {
    eventId: `${session}-1`,
    session,
    clientEpochMs: baseT + 110_000,
    sequenceNumber: 1,
  };
  const paused = await api("/api/pause", {
    method: "POST",
    token,
    body: pauseEvent,
  });
  assert.strictEqual(paused.paused, true);
  await api("/api/pause", {
    method: "POST",
    token,
    body: pauseEvent,
  });
  assert.strictEqual(
    getRecordingEvents(MAIN_USER, session).length,
    2,
    "replaying an event does not duplicate it",
  );
  await sendFramesOverWs(token, session, [{ t: baseT + 120_000, n: 5 }]);
  const whilePaused = await api(
    `/api/sessions/${device}/${session}/frames`,
    { token },
  );
  assert.strictEqual(whilePaused.frames.length, 1, "paused frame dropped");
  const resumed = await api("/api/resume", {
    method: "POST",
    token,
    body: {
      eventId: `${session}-2`,
      session,
      clientEpochMs: baseT + 130_000,
      sequenceNumber: 2,
    },
  });
  assert.strictEqual(resumed.paused, false);

  // change password: wrong current rejected, then real change + re-login
  await api("/api/change-password", {
    method: "POST",
    token,
    body: { currentPassword: "nope", newPassword: UPDATED_PASSWORD },
    expectStatus: 403,
  });
  await api("/api/change-password", {
    method: "POST",
    token,
    body: { currentPassword: PRIVATE_PASSWORD, newPassword: UPDATED_PASSWORD },
  });
  await api("/api/login", {
    method: "POST",
    body: { username: MAIN_USER, password: UPDATED_PASSWORD },
  });

  // =========================================================================
  // DRM subproject: profile (occupation + schedule), push registration,
  // invariant two-round reconstruction API
  // =========================================================================

  // profile: legacy arm metadata must never appear; schedule starts empty
  const initialProfile = await api("/api/profile", { token });
  assert.strictEqual(initialProfile.username, MAIN_USER);
  assert.strictEqual(initialProfile.occupation, null);
  assert.strictEqual(initialProfile.workDescription, null);
  assert.strictEqual(initialProfile.wakeTime, null);
  assert.strictEqual(initialProfile.bedTime, null);
  assert.ok(!("arm" in initialProfile), "profile omits legacy arm metadata");
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

  // Ingest the DRM fixture frames: a second block 20 min later in the same
  // recording session, shaped to exercise the segmentation generator without
  // treating that capture gap as a special boundary. Study day = TODAY.
  const assistedSession = session;
  const t0 = baseT + 1_200_000;
  await sendFramesOverWs(token, assistedSession, [
    { t: t0, n: 1 },
    { t: t0 + 120_000, n: 2 },
    { t: t0 + 150_000, n: 3 },
    { t: t0 + 151_000, n: 4 },
    { t: t0 + 300_000, n: 5 },
    { t: t0 + 480_000, n: 6 },
    { t: t0 + 600_000, n: 7 },
  ]);
  assert.strictEqual(markAllAnonymized(), 7, "face-blur stand-in marked 7 frames");

  // state: study day resolved, round 1 open, round 2 locked.
  let state = await api("/api/reconstruction/state", { token });
  assert.strictEqual(state.day, TODAY);
  assert.strictEqual(state.frameCount, 8, "1 base + 7 fixture frames today");
  assert.strictEqual(state.available, true, "DRM_AVAILABLE_FROM_HOUR=0");
  assert.deepStrictEqual(
    state.rounds.map((r: any) => [r.round, r.status, r.locked]),
    [
      [1, "none", false],
      [2, "none", true],
    ],
    "round 2 remains locked until round 1 is submitted",
  );
  assert.ok(
    state.rounds.every((r: any) => !("mode" in r)),
    "state API does not expose redundant mode",
  );
  assert.strictEqual(state.rounds[0].firstOpenedAt, null);
  assert.strictEqual(state.rounds[0].firstDraftSavedAt, null);
  assert.strictEqual(state.rounds[0].lastDraftSavedAt, null);
  assert.strictEqual(state.rounds[0].submittedAt, null);
  assert.strictEqual(
    state.rounds[1].firstOpenedAt,
    null,
    "locked round 2 timing stays hidden",
  );

  // FIXED ORDER, server-enforced: round 2 is inaccessible before round 1 is
  // submitted — reads AND writes.
  await api("/api/reconstruction/round/2", { token, expectStatus: 403 });
  await api("/api/photos", { token, expectStatus: 403 });
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
  assert.ok(!("mode" in round1), "round API does not expose redundant mode");
  assert.strictEqual(round1.day, TODAY);
  assert.strictEqual(round1.status, "draft", "pinned on first open");
  assert.deepStrictEqual(round1.activities, []);
  assert.ok(!("frames" in round1), "self round must never include frames");
  assert.ok(
    !("vlmPendingCount" in round1),
    "self round reveals nothing about VLM processing",
  );
  assert.ok(typeof round1.firstOpenedAt === "number");
  assert.strictEqual(round1.firstDraftSavedAt, null);
  assert.strictEqual(round1.lastDraftSavedAt, null);
  assert.strictEqual(round1.submittedAt, null);
  const round1FirstOpenedAt = round1.firstOpenedAt;
  const round1Reload = await api("/api/reconstruction/round/1", { token });
  assert.strictEqual(
    round1Reload.firstOpenedAt,
    round1FirstOpenedAt,
    "first-open timestamp is stable across reloads",
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
          rawLabel: "computer_or_monitor_use",
          categoryLabel: "work",
          source: "vlm",
        },
      ],
    },
    expectStatus: 400,
  });
  // ...and ignore any client-smuggled hidden VLM provenance.
  const round1Activities = [
    {
      startMs: baseT - 600_000,
      endMs: baseT + 100_000,
      rawLabel: "computer_or_monitor_use",
      categoryLabel: "work",
      source: "user",
      vlmRawLabel: "smuggled", // must be dropped server-side
      vlmCategory: "work",
      workloadRating: 7, // top of the 7-point scale, must round-trip
    },
    {
      startMs: t0,
      endMs: t0 + 400_000,
      rawLabel: "eating_drinking",
      categoryLabel: "break",
      source: "user",
      recoveryRating: 2,
    },
  ];
  const round1FirstSave = await api("/api/reconstruction/round/1", {
    method: "PUT",
    token,
    body: { activities: round1Activities },
  });
  assert.ok(typeof round1FirstSave.firstDraftSavedAt === "number");
  assert.strictEqual(
    round1FirstSave.lastDraftSavedAt,
    round1FirstSave.firstDraftSavedAt,
    "first successful draft save initializes both save timestamps",
  );
  const round1Draft = await api("/api/reconstruction/round/1", { token });
  assert.strictEqual(round1Draft.activities.length, 2);
  assert.ok(
    !("vlmRawLabel" in round1Draft.activities[0]),
    "participant responses never expose hidden VLM provenance",
  );

  // Drafts reject labels outside the same closed enum used by the VLM and
  // participant dropdowns.
  await api("/api/reconstruction/round/1", {
    method: "PUT",
    token,
    body: {
      activities: [
        {
          startMs: baseT,
          endMs: baseT + 90_000,
          rawLabel: "not_in_activity_vocabulary",
          categoryLabel: "work",
          source: "user",
        },
      ],
    },
    expectStatus: 400,
  });

  // submit validation: every activity needs a rawLabel AND a categoryLabel
  await api("/api/reconstruction/round/1/submit", {
    method: "POST",
    token,
    body: {
      activities: [
        {
          startMs: baseT,
          endMs: baseT + 90_000,
          rawLabel: "computer_or_monitor_use",
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
          rawLabel: "computer_or_monitor_use",
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
          rawLabel: "computer_or_monitor_use",
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
  assert.strictEqual(
    round1Submit.firstDraftSavedAt,
    round1FirstSave.firstDraftSavedAt,
    "submit preserves first draft-save time",
  );
  assert.ok(round1Submit.submittedAt >= round1Submit.lastDraftSavedAt);

  // Global photo management unlocks with Step 2 and returns live frames plus
  // timestamped tombstones for the three earlier soft deletions. Tombstones
  // retain their database identity but never regain a serving path.
  const managedPhotos = await api("/api/photos", { token });
  assert.strictEqual(managedPhotos.day, TODAY);
  assert.strictEqual(managedPhotos.frames.length, 11);
  assert.strictEqual(
    managedPhotos.frames.filter((frame: any) => frame.deletedAt !== null)
      .length,
    3,
  );
  assert.ok(
    managedPhotos.frames
      .filter((frame: any) => frame.deletedAt !== null)
      .every(
        (frame: any) =>
          frame.imageUrl === null &&
          typeof frame.device === "string" &&
          Number.isInteger(frame.session) &&
          Number.isInteger(frame.frameIndex) &&
          typeof frame.captureEpochMs === "number",
      ),
    "deleted photo records expose identity + time but no file path",
  );

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
  assert.strictEqual(submittedRound1.firstOpenedAt, round1FirstOpenedAt);
  assert.strictEqual(submittedRound1.submittedAt, round1Submit.submittedAt);

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

  // state: round 2 unlocks after round 1 submission.
  state = await api("/api/reconstruction/state", { token });
  assert.deepStrictEqual(
    state.rounds.map((r: any) => [r.round, r.status, r.locked]),
    [
      [1, "submitted", false],
      [2, "none", false],
    ],
    "round 2 unlocks after round 1 submit",
  );

  // Assisted round with pending VLM work: frames served, no proposal yet.
  const pendingRound2 = await api("/api/reconstruction/round/2", { token });
  assert.ok(!("mode" in pendingRound2));
  assert.strictEqual(pendingRound2.status, "draft", "pinned on open");
  assert.deepStrictEqual(pendingRound2.activities, []);
  assert.strictEqual(
    pendingRound2.frames.length,
    11,
    "assisted round lists live frames and deleted placeholders",
  );
  assert.strictEqual(
    pendingRound2.frames.filter((frame: any) => frame.deletedAt !== null)
      .length,
    3,
  );
  assert.strictEqual(
    pendingRound2.vlmPendingCount,
    8,
    "every live frame's chunk still unlabeled -> all 8 pending",
  );
  assert.ok(typeof pendingRound2.firstOpenedAt === "number");
  assert.strictEqual(pendingRound2.firstDraftSavedAt, null);
  assert.ok(
    !("vlmProposal" in pendingRound2),
    "pending assisted response does not expose or mark the proposal",
  );
  assert.strictEqual(
    pendingRound2.recordingEnded,
    false,
    "proposal creation waits for the app's end-session event",
  );

  // Ingestion chunk bookkeeping: the 8 live frames span four clock-aligned
  // 5-minute windows. The three older windows were closed ('ready') by the
  // arrival of later-window frames; the newest stays 'filling' until the
  // idle sweep. The baseT window also proves the frame-delete decrement
  // (4 ingested, 3 soft-deleted -> 1).
  assert.deepStrictEqual(
    getChunks(MAIN_USER).map((c) => [c.chunk_start_ms, c.frame_count, c.status]),
    [
      [baseT, 1, "ready"],
      [t0, 4, "ready"],
      [t0 + 300_000, 2, "ready"],
      [t0 + 600_000, 1, "filling"],
    ],
    "frames grouped into 5-minute chunks, earlier windows closed",
  );

  // Ending while paused closes the pause, clears the ingestion gate, and
  // closes the session's still-filling trailing chunk immediately.
  await api("/api/pause", {
    method: "POST",
    token,
    body: {
      eventId: `${session}-3`,
      session,
      clientEpochMs: t0 + 700_000,
      sequenceNumber: 3,
    },
  });
  const ended = await api("/api/recording/ended", {
    method: "POST",
    token,
    body: {
      eventId: `${session}-4`,
      session,
      clientEpochMs: t0 + 710_000,
      sequenceNumber: 4,
    },
  });
  assert.strictEqual(ended.ok, true);
  assert.strictEqual(ended.paused, false, "end clears a current pause");
  assert.strictEqual(ended.closedChunks, 1, "trailing chunk closed on end");
  assert.deepStrictEqual(
    getChunks(MAIN_USER).map((c) => c.status),
    ["ready", "ready", "ready", "ready"],
    "every chunk inferable after the end-of-recording signal",
  );
  assert.deepStrictEqual(
    getRecordingEvents(MAIN_USER, session).map((event) => [
      event.event_type,
      event.sequence_number,
    ]),
    [
      ["start", 0],
      ["pause", 1],
      ["resume", 2],
      ["pause", 3],
      ["end", 4],
    ],
    "recording lifecycle retains pause count and timing order",
  );
  assert.ok(
    getRecordingEvents(MAIN_USER, session).every(
      (event) =>
        Number.isInteger(event.client_epoch_ms) &&
        Number.isInteger(event.server_received_epoch_ms),
    ),
    "client and server event timestamps are stored",
  );
  await api("/api/recording/ended", {
    method: "POST",
    body: {
      eventId: `${session}-4`,
      session,
      clientEpochMs: t0 + 710_000,
      sequenceNumber: 4,
    },
    expectStatus: 401,
  });

  // VLM worker stand-in: one label per CHUNK — frames inherit it.
  setChunkResult(MAIN_USER, baseT, "no_task_engagement", "other", 0.81);
  setChunkResult(MAIN_USER, t0, "computer_or_monitor_use", "work", 0.95);
  setChunkResult(
    MAIN_USER,
    t0 + 300_000,
    "paper_reading_writing",
    "work",
    0.9,
  );
  markChunkFailed(MAIN_USER, t0 + 600_000);
  assert.strictEqual(
    getChunks(MAIN_USER).filter((chunkRow) => chunkRow.status === "failed")
      .length,
    1,
    "failed VLM chunks remain countable for the failure-rate analysis",
  );

  // assisted round now auto-generates + persists the initial segmentation:
  // Every proposal row uses complete clock-aligned 5-minute windows. The
  // capture gap between baseT and t0 receives no special boundary logic; the
  // different classifications still keep those chunks as separate rows.
  const generated = await api("/api/reconstruction/round/2", { token });
  assert.strictEqual(generated.status, "draft", "generation persisted as draft");
  assert.strictEqual(generated.vlmPendingCount, 0);
  assert.strictEqual(generated.recordingEnded, true);
  assert.deepStrictEqual(
    generated.activities.map((a: any) => [a.startMs, a.endMs, a.source]),
    [
      [baseT, baseT + 300_000, "vlm"],
      [t0, t0 + 300_000, "vlm"],
      [t0 + 300_000, t0 + 600_000, "vlm"],
      [t0 + 600_000, t0 + 900_000, "vlm"],
    ],
    "chunk labels use full five-minute windows",
  );
  assert.strictEqual(
    generated.activities[0].rawLabel,
    "no_task_engagement",
    "lower-confidence eligible rows remain unchanged",
  );
  assert.notStrictEqual(
    generated.activities[1].rawLabel,
    "computer_or_monitor_use",
    "highest-confidence row receives a different presented activity label",
  );
  assert.notStrictEqual(
    generated.activities[1].categoryLabel,
    "work",
    "highest-confidence row receives a different presented category",
  );
  assert.strictEqual(
    generated.activities[2].rawLabel,
    "paper_reading_writing",
  );
  assert.strictEqual(generated.activities[3].rawLabel, null);
  assert.ok(
    generated.activities.every(
      (activity: any) =>
        Number.isSafeInteger(activity.proposalActivityId) &&
        !("vlmRawLabel" in activity) &&
        !("vlmCategory" in activity) &&
        !("isIncorrectAnnotationInjected" in activity),
    ),
    "production API carries only opaque proposal IDs, not hidden manipulation data",
  );
  assert.strictEqual(generated.frames.length, 11);
  assert.ok(
    generated.frames.every(
      (frame: any) =>
        typeof frame.device === "string" &&
        Number.isInteger(frame.session) &&
        Number.isInteger(frame.frameIndex) &&
        frame.deletedAt !== undefined,
    ),
    "assisted frame payload carries stable photo identity and deletion state",
  );
  assert.ok(
    generated.frames.every(
      (frame: any) =>
        !("vlmLabel" in frame) && !("vlmCategory" in frame),
    ),
    "assisted photo payload does not reveal genuine chunk labels",
  );
  assert.strictEqual(
    generated.firstDraftSavedAt,
    null,
    "automatic proposal bootstrap is not a participant draft save",
  );
  assert.strictEqual(generated.vlmProposal.kind, "vlm_proposal");
  assert.strictEqual(generated.vlmProposal.immutable, true);
  assert.ok(typeof generated.vlmProposal.proposalViewedAt === "number");
  assert.ok(
    !("activities" in generated.vlmProposal),
    "immutable genuine proposal contents remain server-side",
  );

  const generatedLists = getStoredActivityLists(MAIN_USER);
  const originalProposal = generatedLists.find(
    (list) => list.round === 2 && list.kind === "vlm_proposal",
  );
  assert.ok(originalProposal, "immutable VLM proposal list is persisted");
  assert.strictEqual(originalProposal!.immutable, 1);
  assert.strictEqual(originalProposal!.status, null);
  assert.ok(originalProposal!.id > 0, "proposal has a stable parent-list id");
  assert.strictEqual(
    originalProposal!.proposal_viewed_at,
    generated.vlmProposal.proposalViewedAt,
  );
  assert.deepStrictEqual(
    originalProposal!.items.map((item) => [
      item.raw_label,
      item.category_label,
      item.vlm_raw_label,
      item.vlm_category,
      item.vlm_mean_activity_confidence,
      item.vlm_mean_category_confidence,
      item.is_incorrect_annotation_injected,
    ]),
    [
      [
        "no_task_engagement",
        "other",
        "no_task_engagement",
        "other",
        0.81,
        0.81,
        0,
      ],
      [
        "computer_or_monitor_use",
        "work",
        "computer_or_monitor_use",
        "work",
        0.95,
        0.95,
        1,
      ],
      [
        "paper_reading_writing",
        "work",
        "paper_reading_writing",
        "work",
        0.9,
        0.9,
        0,
      ],
      [null, null, null, null, null, null, 0],
    ],
    "immutable proposal keeps genuine labels, confidence means, and injection flag",
  );
  const injectedProposalActivity = originalProposal!.items[1];
  assert.notStrictEqual(
    injectedProposalActivity.presented_raw_label,
    injectedProposalActivity.raw_label,
  );
  assert.notStrictEqual(
    injectedProposalActivity.presented_category_label,
    injectedProposalActivity.category_label,
  );
  assert.strictEqual(
    Object.keys(
      JSON.parse(
        injectedProposalActivity.vlm_mean_activity_confidences_json!,
      ),
    ).length,
    17,
    "full mean confidence vector is retained for analysis",
  );
  assert.deepStrictEqual(
    Object.keys(
      JSON.parse(
        injectedProposalActivity.vlm_mean_category_confidences_json!,
      ),
    ).sort(),
    [...CATEGORY_LABELS].sort(),
    "full mean category probability vector is retained for analysis",
  );
  const initialAssisted = generatedLists.find(
    (list) => list.round === 2 && list.kind === "assisted",
  )!;
  assert.strictEqual(
    initialAssisted.items[1].raw_label,
    injectedProposalActivity.presented_raw_label,
  );
  assert.strictEqual(
    initialAssisted.items[1].vlm_raw_label,
    injectedProposalActivity.raw_label,
    "only the assisted row may differ from its genuine VLM provenance",
  );

  // An emptied draft still self-heals, but now by copying the immutable
  // snapshot rather than re-running segmentation. Changing a chunk label
  // after generation must not change the restored proposal.
  setChunkResult(MAIN_USER, t0, "other", "other");
  const round2FirstSave = await api("/api/reconstruction/round/2", {
    method: "PUT",
    token,
    body: { activities: [] },
  });
  assert.ok(typeof round2FirstSave.firstDraftSavedAt === "number");
  assert.strictEqual(
    round2FirstSave.lastDraftSavedAt,
    round2FirstSave.firstDraftSavedAt,
  );
  const regenerated = await api("/api/reconstruction/round/2", { token });
  assert.strictEqual(regenerated.activities.length, 4, "draft restored");
  assert.strictEqual(
    regenerated.activities[1].rawLabel,
    generated.activities[1].rawLabel,
    "restore uses the original snapshot, not current chunk labels",
  );
  assert.deepStrictEqual(
    getStoredActivityLists(MAIN_USER).find(
      (list) => list.round === 2 && list.kind === "vlm_proposal",
    ),
    originalProposal,
    "repeated round reads never mutate or duplicate the proposal",
  );

  // draft PUT (replace-all): edit a label, insert a user activity; identical
  // spans keep their original VLM proposal provenance
  const editedActivities = [
    {
      startMs: baseT,
      endMs: baseT + 300_000,
      rawLabel: "no_task_engagement",
      categoryLabel: "other",
      source: "vlm",
      proposalActivityId: generated.activities[0].proposalActivityId,
    },
    {
      startMs: t0,
      endMs: t0 + 151_000,
      rawLabel: "handheld_device_use", // participant corrected the label
      categoryLabel: "work",
      source: "vlm",
      proposalActivityId: generated.activities[1].proposalActivityId,
      workloadRating: 5,
    },
    {
      startMs: t0 + 152_000,
      endMs: t0 + 299_000,
      rawLabel: "walking_or_movement",
      categoryLabel: "break",
      source: "user", // participant inserted this one from memory
      proposalActivityId: null,
      recoveryRating: 4,
    },
    {
      startMs: t0 + 300_000,
      endMs: t0 + 600_000,
      rawLabel: "paper_reading_writing",
      categoryLabel: "work",
      source: "vlm",
      proposalActivityId: generated.activities[2].proposalActivityId,
      workloadRating: 2,
    },
    {
      startMs: t0 + 600_000,
      endMs: t0 + 900_000,
      rawLabel: "other",
      categoryLabel: "other",
      source: "vlm",
      proposalActivityId: generated.activities[3].proposalActivityId,
    },
  ];
  const round2EditedSave = await api("/api/reconstruction/round/2", {
    method: "PUT",
    token,
    body: { activities: editedActivities },
  });
  assert.strictEqual(
    round2EditedSave.firstDraftSavedAt,
    round2FirstSave.firstDraftSavedAt,
    "later saves preserve first draft-save time",
  );
  assert.ok(
    round2EditedSave.lastDraftSavedAt >= round2FirstSave.lastDraftSavedAt,
  );
  const draft = await api("/api/reconstruction/round/2", { token });
  assert.strictEqual(draft.status, "draft");
  assert.strictEqual(draft.activities.length, 5);
  assert.deepStrictEqual(
    draft.activities.map((a: any) => a.position),
    [0, 1, 2, 3, 4],
    "positions assigned from array order",
  );
  assert.strictEqual(draft.activities[1].rawLabel, "handheld_device_use");
  assert.strictEqual(
    draft.activities[1].proposalActivityId,
    generated.activities[1].proposalActivityId,
    "editable row keeps its opaque immutable-proposal link",
  );
  assert.strictEqual(draft.activities[2].source, "user");
  assert.strictEqual(draft.activities[2].proposalActivityId, null);
  assert.deepStrictEqual(
    getStoredActivityLists(MAIN_USER).find(
      (list) => list.round === 2 && list.kind === "vlm_proposal",
    ),
    originalProposal,
    "draft edits leave the complete proposal snapshot untouched",
  );

  // Opaque proposal link: a boundary edit changes the span (so the DB-side
  // exact-span fallback fails), but provenance still survives the save.
  const boundaryEdited = editedActivities.map((activity, index) =>
    index === 1
      ? {
          ...activity,
          endMs: t0 + 120_000, // span changed
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
    afterBoundaryEdit.activities[1].proposalActivityId,
    generated.activities[1].proposalActivityId,
    "opaque proposal provenance survives a span edit",
  );

  // write validation: overlapping spans and spans outside the study day are
  // rejected
  await api("/api/reconstruction/round/2", {
    method: "PUT",
    token,
    body: {
      activities: [
        { startMs: t0, endMs: t0 + 100_000, rawLabel: "computer_or_monitor_use", categoryLabel: "work", source: "user" },
        { startMs: t0 + 50_000, endMs: t0 + 150_000, rawLabel: "paper_reading_writing", categoryLabel: "work", source: "user" },
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
          rawLabel: "computer_or_monitor_use",
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

  // submit round 2: atomic save + lock; proposal and assisted lists remain separately queryable
  const round2Submit = await api("/api/reconstruction/round/2/submit", {
    method: "POST",
    token,
    body: { activities: editedActivities },
  });
  assert.strictEqual(round2Submit.ok, true);
  assert.ok(round2Submit.submittedAt >= round2Submit.lastDraftSavedAt);

  state = await api("/api/reconstruction/state", { token });
  assert.deepStrictEqual(
    state.rounds.map((r: any) => r.status),
    ["submitted", "submitted"],
  );
  assert.deepStrictEqual(
    getStoredActivityLists(MAIN_USER).map((list) => [
      list.round,
      list.kind,
      list.immutable,
      list.status,
      list.items.length,
    ]),
    [
      [1, "self", 0, "submitted", 2],
      [2, "assisted", 0, "submitted", 5],
      [2, "vlm_proposal", 1, null, 4],
    ],
    "list kind, workflow status, and three-list identity stay distinct",
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

  // =========================================================================
  // A second participant follows the same invariant self -> assisted flow.
  // =========================================================================

  const { token: secondToken } = await api("/api/login", {
    method: "POST",
    body: { username: SECOND_USER, password: PASSWORD },
  });
  await api("/api/onboarding/password", {
    method: "POST",
    token: secondToken,
    body: { newPassword: PRIVATE_PASSWORD },
  });
  await api("/api/onboarding/complete", {
    method: "POST",
    token: secondToken,
  });

  const secondSession = session + 3;
  const s0 = TODAY_NOON + 3_600_000; // 13:00 local
  await api("/api/recording/started", {
    method: "POST",
    token: secondToken,
    body: {
      eventId: `${secondSession}-0`,
      session: secondSession,
      clientEpochMs: s0,
      sequenceNumber: 0,
    },
  });
  await sendFramesOverWs(
    secondToken,
    secondSession,
    [
      { t: s0, n: 1 },
      { t: s0 + 60_000, n: 2 },
    ],
    "BBCCDDEEFF00",
  );
  assert.strictEqual(markAllAnonymized(), 2, "second participant frames anonymized");
  setChunkResult(SECOND_USER, s0, "food_preparation", "other");
  await api("/api/recording/ended", {
    method: "POST",
    token: secondToken,
    body: {
      eventId: `${secondSession}-1`,
      session: secondSession,
      clientEpochMs: s0 + 70_000,
      sequenceNumber: 1,
    },
  });

  const secondActivities = [
    {
      startMs: s0,
      endMs: s0 + 60_000,
      rawLabel: "food_preparation",
      categoryLabel: "other",
      source: "user",
    },
  ];

  // Round 1 self, submit.
  const secondRound1 = await api("/api/reconstruction/round/1", {
    token: secondToken,
  });
  assert.ok(!("mode" in secondRound1));
  assert.ok(!("frames" in secondRound1));
  await api("/api/reconstruction/round/1/submit", {
    method: "POST",
    token: secondToken,
    body: { activities: secondActivities },
  });

  const secondState = await api("/api/reconstruction/state", {
    token: secondToken,
  });
  assert.deepStrictEqual(
    secondState.rounds.map((r: any) => [r.round, r.locked]),
    [
      [1, false],
      [2, false],
    ],
    "second participant unlocks the same round-2 workflow",
  );
  const secondRound2 = await api("/api/reconstruction/round/2", {
    token: secondToken,
  });
  assert.ok(!("mode" in secondRound2));
  assert.ok(
    Array.isArray(secondRound2.frames) && secondRound2.frames.length === 2,
    "round 2 always includes the participant's frames",
  );
  assert.strictEqual(secondRound2.vlmPendingCount, 0);
  assert.strictEqual(secondRound2.vlmProposal.kind, "vlm_proposal");
  assert.notStrictEqual(
    secondRound2.activities[0].rawLabel,
    "food_preparation",
    "fallback still injects one wrong row when a day has only one activity",
  );

  await api("/api/reconstruction/round/2/submit", {
    method: "POST",
    token: secondToken,
    body: { activities: secondActivities },
  });

  console.log("SMOKE TEST PASSED");
};

main().catch((error) => {
  console.error("SMOKE TEST FAILED:", error.stack ?? error.message);
  process.exit(1);
});
