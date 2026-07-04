import assert = require("assert");
import path = require("path");
import Database = require("better-sqlite3");
import WebSocket = require("ws");

// End-to-end smoke test against a locally running server. Expects:
//   RECORDINGS_DIR/DATA_DIR pointing at a throwaway directory
//   a user created via create-user (for the DRM assertions below:
//     npx tsx scripts/create-user.ts smoketester password123 --plan control,assisted)
//   the server running with DRM_AVAILABLE_FROM_HOUR=0 and DISABLE_PUSH=1
// The test reads RECORDINGS_DIR to reach recordings.db, so it can simulate the
// face-blur worker (face_status='done') and the VLM worker (vlm_status='done'
// + labels/categories) without running the Python processes.
// Run via: npx tsx scripts/smoke-test.ts (against a running server)

const BASE_URL = process.env.SMOKE_BASE_URL ?? "http://127.0.0.1:3100";
const WS_URL = BASE_URL.replace(/^http/, "ws");
const RECORDINGS_DIR = process.env.RECORDINGS_DIR;
const USERNAME = "smoketester";
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
const YESTERDAY = dayKeyOf(TODAY_NOON - 86_400_000);
const YESTERDAY_NOON = localNoonOf(YESTERDAY);
const TOMORROW = dayKeyOf(TODAY_NOON + 86_400_000);

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

// Stand in for the VLM worker: write label + category for one frame.
const setVlmResult = (
  captureEpochMs: number,
  label: string,
  category: string,
): void =>
  withDb((db) => {
    const changes = db
      .prepare(
        "UPDATE frames SET vlm_status = 'done', vlm_label = ?, vlm_category = ? " +
          "WHERE participant = ? AND capture_epoch_ms = ?",
      )
      .run(label, category, USERNAME, captureEpochMs).changes;
    assert.strictEqual(changes, 1, `vlm update hit frame at ${captureEpochMs}`);
  });

const getFrameCorrections = (
  captureEpochMs: number,
): { category: string | null; activity: string | null } =>
  withDb((db) => {
    const row = db
      .prepare(
        "SELECT user_corrected_category_label AS category, " +
          "user_corrected_activity_label AS activity " +
          "FROM frames WHERE participant = ? AND capture_epoch_ms = ?",
      )
      .get(USERNAME, captureEpochMs) as
      | { category: string | null; activity: string | null }
      | undefined;
    assert.ok(row, `expected a frame at ${captureEpochMs}`);
    return row!;
  });

const getParticipantRow = (): {
  condition_plan: string;
  push_token: string | null;
  occupation: string | null;
} =>
  withDb((db) => {
    const row = db
      .prepare(
        "SELECT condition_plan, push_token, occupation FROM participants WHERE username = ?",
      )
      .get(USERNAME) as
      | { condition_plan: string; push_token: string | null; occupation: string | null }
      | undefined;
    assert.ok(row, "participants row exists (created by create-user)");
    return row!;
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
): Promise<void> =>
  new Promise((resolve, reject) => {
    const ws = new WebSocket(`${WS_URL}/ingest?session=${session}&device=AABBCCDDEEFF`, {
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
    body: { username: USERNAME, password: "wrong-password" },
    expectStatus: 401,
  });

  const { token } = await api("/api/login", {
    method: "POST",
    body: { username: USERNAME, password: PASSWORD },
  });
  assert.ok(typeof token === "string" && token.length === 64, "token issued");

  // unauthenticated WS upgrade is rejected
  await expectWsRejected();

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
  // Anti-leak: the mobile app must never receive VLM output anymore.
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

  // delete one frame: row + file gone
  await api(`/api/sessions/${device}/${session}/frames/2`, {
    method: "DELETE",
    token,
  });
  const afterDelete = await api(
    `/api/sessions/${device}/${session}/frames`,
    { token },
  );
  assert.strictEqual(afterDelete.frames.length, 3, "frame deleted");
  await api(`/api/sessions/${device}/${session}/frames/2`, {
    method: "DELETE",
    token,
    expectStatus: 404,
  });

  // pause gate drops ingested frames
  await api("/api/pause", { method: "POST", token });
  await sendFramesOverWs(token, session, [{ t: baseT + 120_000, n: 5 }]);
  const whilePaused = await api(
    `/api/sessions/${device}/${session}/frames`,
    { token },
  );
  assert.strictEqual(whilePaused.frames.length, 3, "paused frame dropped");
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
    body: { username: USERNAME, password: "password456" },
  });

  // =========================================================================
  // DRM subproject: profile, push registration, day reconstruction API
  // =========================================================================

  // profile: created by create-user with --plan control,assisted
  const initialProfile = await api("/api/profile", { token });
  assert.strictEqual(initialProfile.username, USERNAME);
  assert.strictEqual(initialProfile.occupation, null);
  assert.strictEqual(initialProfile.workDescription, null);
  assert.strictEqual(
    initialProfile.studyDurationDays,
    2,
    "plan length from create-user --plan control,assisted",
  );
  assert.strictEqual(initialProfile.drmWebUrl, "http://blinks.win.kit.edu");

  await api("/api/profile", {
    method: "PUT",
    token,
    body: { occupation: 123, workDescription: "x" },
    expectStatus: 400,
  });
  await api("/api/profile", {
    method: "PUT",
    token,
    body: {
      occupation: "PhD student",
      workDescription: "Writes papers and analyses biosignal data.",
    },
  });
  const updatedProfile = await api("/api/profile", { token });
  assert.strictEqual(updatedProfile.occupation, "PhD student");
  assert.strictEqual(
    updatedProfile.workDescription,
    "Writes papers and analyses biosignal data.",
  );
  // Profile PUT must never clobber the provisioned condition plan.
  assert.strictEqual(
    getParticipantRow().condition_plan,
    JSON.stringify(["control", "assisted"]),
    "condition_plan untouched by profile PUT",
  );

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
    getParticipantRow().push_token,
    "ExponentPushToken[smoke-test]",
    "push token persisted",
  );

  // Ingest the DRM fixture days.
  // Yesterday (study day 1 -> control): two frames around local noon.
  const yesterdaySession = session + 1;
  await sendFramesOverWs(token, yesterdaySession, [
    { t: YESTERDAY_NOON, n: 1 },
    { t: YESTERDAY_NOON + 60_000, n: 2 },
  ]);
  // Today (study day 2 -> assisted): a second block 20 min after the base
  // session (i.e. a >10 min capture gap), shaped to exercise the generator.
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
  assert.strictEqual(markAllAnonymized(), 8, "face-blur stand-in marked 8 frames");

  // days: sorted desc, day numbering + plan mapping, pending VLM counts
  let { days } = await api("/api/reconstruction/days", { token });
  assert.strictEqual(days.length, 2, "two study days");
  assert.deepStrictEqual(
    days.map((d: any) => [d.day, d.dayNumber, d.condition, d.status]),
    [
      [TODAY, 2, "assisted", "none"],
      [YESTERDAY, 1, "control", "none"],
    ],
    "days sorted desc with plan-mapped conditions",
  );
  assert.strictEqual(days[0].frameCount, 9, "3 base + 6 assisted frames today");
  assert.strictEqual(days[0].vlmPendingCount, 9, "all of today still VLM-pending");
  assert.strictEqual(days[1].frameCount, 2);
  assert.strictEqual(days[1].vlmPendingCount, 2);
  assert.strictEqual(days[0].available, true, "DRM_AVAILABLE_FROM_HOUR=0");
  assert.strictEqual(days[0].availableFromHour, 0);

  // assisted day with pending VLM work: no activities yet. Opening the day
  // pins its condition (a reconstructions row appears -> status 'draft'), but
  // no activities are generated while labels are processing.
  const pendingDay = await api(`/api/reconstruction/${TODAY}`, { token });
  assert.strictEqual(pendingDay.condition, "assisted");
  assert.strictEqual(pendingDay.status, "draft", "condition pinned on open");
  assert.deepStrictEqual(pendingDay.activities, []);
  assert.strictEqual(pendingDay.frames.length, 9, "assisted day lists frames");
  ({ days } = await api("/api/reconstruction/days", { token }));
  assert.strictEqual(
    days[0].status,
    "draft",
    "pinned on open; no activities persisted while pending",
  );

  // VLM worker stand-in: label every frame.
  for (const t of [baseT, baseT + 60_000, baseT + 90_000]) {
    setVlmResult(t, "Working at desk", "work");
  }
  setVlmResult(t0, "Deep work", "work");
  setVlmResult(t0 + 120_000, "Deep work", "work");
  setVlmResult(t0 + 150_000, "coffee", "break");
  setVlmResult(t0 + 151_000, " Coffee ", "break"); // noisy label, same group
  setVlmResult(t0 + 300_000, "Reading paper", "work");
  setVlmResult(t0 + 480_000, "Reading paper", "work");
  setVlmResult(YESTERDAY_NOON, "Cooking dinner", "other");
  setVlmResult(YESTERDAY_NOON + 60_000, "Cooking dinner", "other");

  // assisted day now auto-generates + persists the initial segmentation:
  //   block 1 (base session): lone short segment survives
  //   block 2: short "coffee" run merged into the longer "Deep work" segment
  const generated = await api(`/api/reconstruction/${TODAY}`, { token });
  assert.strictEqual(generated.status, "draft", "generation persisted as draft");
  assert.deepStrictEqual(
    generated.activities.map((a: any) => [
      a.startMs,
      a.endMs,
      a.rawLabel,
      a.categoryLabel,
      a.source,
    ]),
    [
      [baseT, baseT + 90_000, "Working at desk", "work", "vlm"],
      [t0, t0 + 151_000, "Deep work", "work", "vlm"],
      [t0 + 300_000, t0 + 480_000, "Reading paper", "work", "vlm"],
    ],
    "segmentation groups, splits at the gap, and smooths the short break",
  );
  assert.strictEqual(generated.activities[1].vlmRawLabel, "Deep work");
  assert.strictEqual(generated.activities[1].vlmCategory, "work");
  assert.strictEqual(generated.frames.length, 9);
  assert.ok(typeof generated.frames[0].captureEpochMs === "number");
  assert.ok(typeof generated.frames[0].imageUrl === "string");
  assert.strictEqual(generated.frames[0].vlmLabel, "Working at desk");
  assert.strictEqual(generated.frames[0].vlmCategory, "work");

  // idempotent: a second GET returns the stored draft, no duplicate generation
  const regenerated = await api(`/api/reconstruction/${TODAY}`, { token });
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
    },
    {
      startMs: t0,
      endMs: t0 + 151_000,
      rawLabel: "Focused work", // participant corrected the label
      categoryLabel: "work",
      source: "vlm",
    },
    {
      startMs: t0 + 152_000,
      endMs: t0 + 299_000,
      rawLabel: "Stretch break",
      categoryLabel: "break",
      source: "user", // participant inserted this one from memory
    },
    {
      startMs: t0 + 300_000,
      endMs: t0 + 480_000,
      rawLabel: "Reading paper",
      categoryLabel: "work",
      source: "vlm",
    },
  ];
  await api(`/api/reconstruction/${TODAY}`, {
    method: "PUT",
    token,
    body: { activities: editedActivities },
  });
  const draft = await api(`/api/reconstruction/${TODAY}`, { token });
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
  await api(`/api/reconstruction/${TODAY}`, {
    method: "PUT",
    token,
    body: { activities: boundaryEdited },
  });
  const afterBoundaryEdit = await api(`/api/reconstruction/${TODAY}`, { token });
  assert.strictEqual(
    afterBoundaryEdit.activities[1].vlmRawLabel,
    "Deep work",
    "echoed VLM provenance survives a span edit",
  );

  // write validation: overlapping spans and spans outside the day are rejected
  await api(`/api/reconstruction/${TODAY}`, {
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
  await api(`/api/reconstruction/${TODAY}`, {
    method: "PUT",
    token,
    body: {
      activities: [
        {
          startMs: TODAY_NOON + 86_400_000, // tomorrow: outside the day
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
  await api(`/api/reconstruction/${TODAY}`, {
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

  // submit validation: every activity needs a rawLabel AND a categoryLabel
  await api(`/api/reconstruction/${TODAY}/submit`, {
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

  // submit: atomic save + lock + propagation onto the frames
  const submitResult = await api(`/api/reconstruction/${TODAY}/submit`, {
    method: "POST",
    token,
    body: { activities: editedActivities },
  });
  assert.strictEqual(submitResult.ok, true);
  assert.ok(typeof submitResult.submittedAt === "number");

  ({ days } = await api("/api/reconstruction/days", { token }));
  assert.strictEqual(days[0].status, "submitted");

  // locked: no further submit or draft save
  await api(`/api/reconstruction/${TODAY}/submit`, {
    method: "POST",
    token,
    body: { activities: editedActivities },
    expectStatus: 409,
  });
  await api(`/api/reconstruction/${TODAY}`, {
    method: "PUT",
    token,
    body: { activities: editedActivities },
    expectStatus: 409,
  });

  // propagation: frames inside each span carry the submitted labels; the
  // corrected "coffee" frame proves the misclassification signal lands
  assert.deepStrictEqual(getFrameCorrections(baseT), {
    category: "work",
    activity: "Working at desk",
  });
  assert.deepStrictEqual(
    getFrameCorrections(t0 + 150_000),
    { category: "work", activity: "Focused work" },
    "frame the VLM called 'coffee/break' now carries the user's correction",
  );
  assert.deepStrictEqual(getFrameCorrections(t0 + 480_000), {
    category: "work",
    activity: "Reading paper",
  });
  assert.deepStrictEqual(
    getFrameCorrections(YESTERDAY_NOON),
    { category: null, activity: null },
    "frames outside every span stay untouched",
  );

  // control day: NO frames field and no auto-generation (anti-leak), manual
  // entry from memory only
  const controlDay = await api(`/api/reconstruction/${YESTERDAY}`, { token });
  assert.strictEqual(controlDay.condition, "control");
  assert.strictEqual(controlDay.status, "draft", "condition pinned on open");
  assert.deepStrictEqual(controlDay.activities, []);
  assert.ok(
    !("frames" in controlDay),
    "control day must never include frames/VLM output",
  );

  const controlActivities = [
    {
      startMs: YESTERDAY_NOON - 600_000,
      endMs: YESTERDAY_NOON + 600_000,
      rawLabel: "Cooking",
      categoryLabel: "other",
      source: "user",
    },
  ];
  await api(`/api/reconstruction/${YESTERDAY}`, {
    method: "PUT",
    token,
    body: { activities: controlActivities },
  });
  const controlDraft = await api(`/api/reconstruction/${YESTERDAY}`, { token });
  assert.strictEqual(controlDraft.status, "draft");
  assert.strictEqual(controlDraft.activities.length, 1);
  assert.ok(!("frames" in controlDraft), "still no frames on the control day");
  const controlSubmit = await api(`/api/reconstruction/${YESTERDAY}/submit`, {
    method: "POST",
    token,
    body: { activities: controlActivities },
  });
  assert.strictEqual(controlSubmit.ok, true);
  assert.deepStrictEqual(getFrameCorrections(YESTERDAY_NOON), {
    category: "other",
    activity: "Cooking",
  });

  // gate + validation edges
  await api(`/api/reconstruction/${TOMORROW}`, {
    method: "PUT",
    token,
    body: { activities: [] },
    expectStatus: 403, // future days are never available (server-side gate)
  });
  await api(`/api/reconstruction/${TOMORROW}`, { token, expectStatus: 404 });
  await api(`/api/reconstruction/not-a-day`, { token, expectStatus: 400 });

  console.log("SMOKE TEST PASSED");
};

main().catch((error) => {
  console.error("SMOKE TEST FAILED:", error.message);
  process.exit(1);
});
