// Runtime tests for the study config (BLINKS-tasks#4, WP1):
//   - loader: exit 2 on invalid/missing files, F1 production rules
//   - client projections + ratings rules against BOTH configs (pure)
//   - HTTP: /api/study-config, /api/app-config, /api/payout,
//     /api/recording/device-info against a server started with
//     config/study.test.yaml (proves nothing is hardcoded to the paper study)
//
//   npm run build && npx tsx scripts/test-study-config-runtime.ts

import assert = require("assert");
import childProcess = require("child_process");
import fs = require("fs");
import os = require("os");
import path = require("path");

import { parseRatingsInput, ratingsResponse, studyConfigResponse, appConfigResponse } from "../src/study-config/client";
import { loadStudyConfigFile } from "../src/study-config/load";

const SERVER_DIR = path.resolve(__dirname, "..");
const REPO_ROOT = path.resolve(SERVER_DIR, "..");
const EXAMPLE = path.join(REPO_ROOT, "config", "study.example.yaml");
const TEST_CONFIG = path.join(REPO_ROOT, "config", "study.test.yaml");
const LOADER = path.join(SERVER_DIR, "dist", "study-config", "index.js");
assert.ok(fs.existsSync(LOADER), "run npm run build first");

const example = loadStudyConfigFile(EXAMPLE);
const testConfig = loadStudyConfigFile(TEST_CONFIG);
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "blinks-config-runtime-"));

let passed = 0;
const tests: [string, () => void | Promise<void>][] = [];
const test = (name: string, fn: () => void | Promise<void>): void => {
  tests.push([name, fn]);
};

// --- loader ------------------------------------------------------------------

const runLoader = (env: Record<string, string | undefined>) => {
  const cleanEnv: NodeJS.ProcessEnv = { PATH: process.env.PATH };
  for (const [key, value] of Object.entries(env)) if (value !== undefined) cleanEnv[key] = value;
  return childProcess.spawnSync(
    process.execPath,
    ["-e", `require(${JSON.stringify(LOADER)}); console.log("LOADED")`],
    { env: cleanEnv, encoding: "utf8", cwd: tmp },
  );
};

// study.test.yaml uses example.org links on purpose; production refuses
// those (m2), so the production cases run on a copy with neutral links.
const productionReady = (source: string): string =>
  source.replace(/https:\/\/([a-z.]*)example\.org/g, "https://$1blinks-test.invalid");
const writeConfig = (name: string, source: string): string => {
  const file = path.join(tmp, name);
  fs.writeFileSync(file, source);
  return file;
};
const testSource = fs.readFileSync(TEST_CONFIG, "utf8");

test("loader: valid explicit config loads (exit 0)", () => {
  const plain = runLoader({ BLINKS_STUDY_CONFIG: TEST_CONFIG });
  assert.strictEqual(plain.status, 0, plain.stderr);
  const result = runLoader({
    BLINKS_STUDY_CONFIG: writeConfig("prod-ok.yaml", productionReady(testSource)),
    NODE_ENV: "production",
  });
  assert.strictEqual(result.status, 0, result.stderr);
  assert.match(result.stdout, /LOADED/);
});

test("loader m2: production refuses placeholder links and PINs (copy of the example)", () => {
  const links = runLoader({ BLINKS_STUDY_CONFIG: TEST_CONFIG, NODE_ENV: "production" });
  assert.strictEqual(links.status, 2);
  assert.match(links.stderr, /surveys\.payoutUrl: is a placeholder example\.org/);
  assert.match(links.stderr, /surveys\.onboarding\.url: is a placeholder/);

  // 1:1 copy of the example under another name
  const copy = writeConfig("study.yaml", fs.readFileSync(EXAMPLE, "utf8"));
  const copied = runLoader({ BLINKS_STUDY_CONFIG: copy, NODE_ENV: "production" });
  assert.strictEqual(copied.status, 2);
  assert.match(copied.stderr, /app\.studySettingsPin: is the placeholder PIN/);
  assert.strictEqual(runLoader({ BLINKS_STUDY_CONFIG: copy }).status, 0, "allowed outside production");

  // the retired PIN, found by its hash (not written here in clear text)
  const { RETIRED_PIN_SHA256 } = require("../src/study-config/load");
  const crypto = require("crypto");
  const retired = Array.from({ length: 10_000 }, (_, n) => String(n).padStart(4, "0")).find(
    (pin) => crypto.createHash("sha256").update(pin).digest("hex") === RETIRED_PIN_SHA256[0],
  );
  assert.ok(retired, "retired PIN hash is a 4-digit PIN");
  const old = writeConfig(
    "retired.yaml",
    productionReady(testSource).replace('studySettingsPin: "123456"', `studySettingsPin: "${retired}"`),
  );
  const oldResult = runLoader({ BLINKS_STUDY_CONFIG: old, NODE_ENV: "production" });
  assert.strictEqual(oldResult.status, 2);
  assert.match(oldResult.stderr, /app\.studySettingsPin: is a retired PIN/);
  assert.ok(!oldResult.stderr.includes(retired!), "the PIN is not echoed");
  assert.strictEqual(runLoader({ BLINKS_STUDY_CONFIG: old, BLINKS_ENV: "production" }).status, 0, "BLINKS_ENV is Python-only");
});

test("loader m1: overreliance on with a single category exits 2", () => {
  const source = fs.readFileSync(EXAMPLE, "utf8");
  const start = source.indexOf("\ncategories:\n");
  const end = source.indexOf("\nexperienceItems:", start);
  const block = source.slice(start, end);
  const firstItem = block.split(/\n  - /)[1];
  const single = source.slice(0, start) + "\ncategories:\n  - " + firstItem + source.slice(end);
  const result = runLoader({ BLINKS_STUDY_CONFIG: writeConfig("one-category.yaml", single) });
  assert.strictEqual(result.status, 2, result.stdout);
  assert.match(result.stderr, /overreliance\.enabled: needs at least 2 categories/);
});

test("loader: invalid config exits 2 with path: reason", () => {
  const broken = path.join(tmp, "broken.yaml");
  fs.writeFileSync(
    broken,
    fs
      .readFileSync(TEST_CONFIG, "utf8")
      .replace('reconstructionOpensAt: "00:00"', 'reconstructionOpensAt: "7pm"')
      .replace("  enabled: false\n  rate: 0\n", "  enabled: false\n  rate: 0\n  surprise: 1\n"),
  );
  const result = runLoader({ BLINKS_STUDY_CONFIG: broken });
  assert.strictEqual(result.status, 2);
  assert.match(result.stderr, /FATAL: invalid study config/);
  assert.match(result.stderr, /schedule\.reconstructionOpensAt: must be HH:MM/);
  assert.match(result.stderr, /overreliance: .*surprise/);
});

test("loader: cross-check failure exits 2 (notice set while overreliance off)", () => {
  const broken = path.join(tmp, "notice.yaml");
  fs.writeFileSync(
    broken,
    fs
      .readFileSync(TEST_CONFIG, "utf8")
      .replace("assistedReminderIncorrectLabelsNotice: null", 'assistedReminderIncorrectLabelsNotice: "Some labels are wrong."'),
  );
  const result = runLoader({ BLINKS_STUDY_CONFIG: broken });
  assert.strictEqual(result.status, 2);
  assert.match(result.stderr, /texts\.rounds\.assistedReminderIncorrectLabelsNotice/);
});

test("loader: YAML syntax error exits 2", () => {
  const broken = path.join(tmp, "syntax.yaml");
  fs.writeFileSync(broken, "study: [unclosed\n");
  const result = runLoader({ BLINKS_STUDY_CONFIG: broken });
  assert.strictEqual(result.status, 2);
  assert.match(result.stderr, /YAML syntax error/);
});

test("loader: explicit missing file exits 2", () => {
  const result = runLoader({ BLINKS_STUDY_CONFIG: path.join(tmp, "nope.yaml") });
  assert.strictEqual(result.status, 2);
  assert.match(result.stderr, /file not found \(BLINKS_STUDY_CONFIG\)/);
});

const hasRealStudyYaml = fs.existsSync(path.join(REPO_ROOT, "config", "study.yaml"));
test("loader F1: example is refused in production, explicit or as fallback", () => {
  const explicit = runLoader({ BLINKS_STUDY_CONFIG: EXAMPLE, NODE_ENV: "production" });
  assert.strictEqual(explicit.status, 2);
  assert.match(explicit.stderr, /not allowed in production/);
  if (!hasRealStudyYaml) {
    const fallback = runLoader({ NODE_ENV: "production" });
    assert.strictEqual(fallback.status, 2);
    assert.match(fallback.stderr, /Production never falls back/);
  }
});

test("loader: outside production the example is used with a warning", () => {
  if (hasRealStudyYaml) return; // a developer's local study.yaml wins
  const result = runLoader({});
  assert.strictEqual(result.status, 0, result.stderr);
  assert.match(result.stderr, /WARNING: using config\/study\.example\.yaml/);
});

test("face blur off: frames are stored as done/disabled (contract 6)", () => {
  const cfg = path.join(tmp, "noblur.yaml");
  fs.writeFileSync(
    cfg,
    fs.readFileSync(TEST_CONFIG, "utf8").replace(
      "faceBlur:\n    enabled: true",
      "faceBlur:\n    enabled: false",
    ),
  );
  assert.strictEqual(loadStudyConfigFile(cfg).privacy.faceBlur.enabled, false);
  const script = `
    const { initDb, insertFrame } = require(${JSON.stringify(path.join(SERVER_DIR, "dist", "db.js"))});
    const Database = require(${JSON.stringify(path.join(SERVER_DIR, "node_modules", "better-sqlite3"))});
    const dbPath = process.argv[1];
    initDb(dbPath);
    insertFrame({ participant: "p", device: "D", session: 1, frame_index: 0,
      capture_epoch_ms: 1792260000000, received_epoch_ms: 1792260000500,
      file_path: "p/1/0.jpg", device_frame: 0, byte_length: 8, jpeg_ok: 1 });
    const row = new Database(dbPath, { readonly: true })
      .prepare("SELECT face_status, face_method, face_count, face_completed_at FROM frames").get();
    console.log(JSON.stringify(row));
  `;
  const run = (configPath: string) => {
    const result = childProcess.spawnSync(
      process.execPath,
      ["-e", script, path.join(tmp, `${path.basename(configPath)}.db`)],
      { env: { PATH: process.env.PATH, BLINKS_STUDY_CONFIG: configPath }, encoding: "utf8" },
    );
    assert.strictEqual(result.status, 0, result.stderr);
    return JSON.parse(result.stdout.trim().split("\n").pop()!);
  };
  assert.deepStrictEqual(run(cfg), {
    face_status: "done",
    face_method: "disabled",
    face_count: null,
    face_completed_at: 1792260000500,
  });
  assert.deepStrictEqual(run(TEST_CONFIG), {
    face_status: "pending",
    face_method: null,
    face_count: null,
    face_completed_at: null,
  });
});

test("face blur back on: requeue-unblurred-frames resets 'disabled' frames (m4)", () => {
  const recordings = path.join(tmp, "requeue");
  fs.mkdirSync(recordings, { recursive: true });
  const dbPath = path.join(recordings, "recordings.db");
  // WAL mode: copy a consistent snapshot, not just the main file
  const SqliteDb = require("better-sqlite3");
  const source = new SqliteDb(path.join(tmp, "noblur.yaml.db"), { readonly: true });
  source.exec(`VACUUM INTO '${dbPath.replace(/'/g, "''")}'`);
  source.close();
  const requeue = (configPath: string, ...args: string[]) =>
    childProcess.spawnSync(
      process.execPath,
      [path.join(SERVER_DIR, "node_modules", "tsx", "dist", "cli.mjs"), path.join(SERVER_DIR, "scripts", "requeue-unblurred-frames.ts"), ...args],
      { env: { PATH: process.env.PATH, BLINKS_STUDY_CONFIG: configPath, RECORDINGS_DIR: recordings }, encoding: "utf8", cwd: SERVER_DIR },
    );
  const dry = requeue(TEST_CONFIG);
  assert.strictEqual(dry.status, 0, dry.stderr);
  assert.match(dry.stdout, /unblurred frames \(face_method='disabled'\): 1 from 1 participant/);
  const refused = requeue(path.join(tmp, "noblur.yaml"), "--apply");
  assert.strictEqual(refused.status, 1);
  assert.match(refused.stderr, /refusing --apply/);
  const applied = requeue(TEST_CONFIG, "--apply");
  assert.strictEqual(applied.status, 0, applied.stderr);
  assert.match(applied.stdout, /requeued 1 frame/);
  const Database = require("better-sqlite3");
  const db = new Database(dbPath, { readonly: true });
  assert.deepStrictEqual(db.prepare("SELECT face_status, face_method, face_completed_at FROM frames").get(), {
    face_status: "pending",
    face_method: null,
    face_completed_at: null,
  });
  db.close();
  assert.match(requeue(TEST_CONFIG).stdout, /: 0 from 0 participant/);
});

// --- pure projections + ratings ----------------------------------------------

const SECRET_FIELDS = /vlmDefinition|prompts|overreliance|minConfidence|faceBlur|studySettingsPin|payoutUrl/;

test("study-config response: whitelist only, surveys only for participants", () => {
  for (const config of [example, testConfig]) {
    const participant = studyConfigResponse(true, config);
    const admin = studyConfigResponse(false, config);
    assert.ok(!SECRET_FIELDS.test(JSON.stringify(participant)), "no VLM/overreliance/PIN/payout data");
    assert.strictEqual(admin.surveys, null);
    assert.deepStrictEqual(participant.surveys, {
      onboarding: config.surveys.onboarding,
      final: config.surveys.final,
    });
    assert.deepStrictEqual(
      participant.activities,
      config.activities.map(({ key, displayLabel }) => ({ key, displayLabel })),
    );
    assert.deepStrictEqual(Object.keys(participant).sort(), [
      "activities", "categories", "experienceItems", "schedule", "study", "surveys", "texts", "ui", "windowing",
    ]);
  }
  assert.strictEqual(studyConfigResponse(true, testConfig).texts.rounds.assistedReminderIncorrectLabelsNotice, null);
});

test("app-config response: interval map, timezone, PIN; nothing else secret", () => {
  const app = appConfigResponse(testConfig);
  assert.deepStrictEqual(app.capture.intervalMsByFormFactor, { necklace: 10000, glasses: 20000, clip: 5000 });
  assert.strictEqual(app.timezone, "Europe/Berlin");
  assert.strictEqual(app.studySettingsPin, "123456");
  assert.deepStrictEqual(Object.keys(app).sort(), ["capture", "devices", "schedule", "studySettingsPin", "texts", "timezone"]);
  assert.ok(!/vlmDefinition|prompts|overreliance|payoutUrl|surveys/.test(JSON.stringify(app)));
});

test("ratings: response lists every configured key, null if unanswered", () => {
  assert.deepStrictEqual(ratingsResponse({ focus: 0 }, testConfig), { focus: 0, stress: null, enjoyment: null });
  assert.deepStrictEqual(ratingsResponse({}, example), { mental_demand: null, mental_recovery: null });
});

test("ratings: request rules and exact error texts (test config)", () => {
  assert.deepStrictEqual(parseRatingsInput(undefined, undefined, testConfig), { ratings: {} });
  assert.deepStrictEqual(parseRatingsInput({ focus: 0, enjoyment: null }, undefined, testConfig), {
    ratings: { focus: 0, enjoyment: null },
  });
  assert.deepStrictEqual(parseRatingsInput("x", undefined, testConfig), { error: "ratings must be an object" });
  assert.deepStrictEqual(parseRatingsInput([1], undefined, testConfig), { error: "ratings must be an object" });
  assert.deepStrictEqual(parseRatingsInput({ mental_demand: 3 }, undefined, testConfig), {
    error: 'unknown rating item "mental_demand"',
  });
  assert.deepStrictEqual(parseRatingsInput({ focus: 5 }, undefined, testConfig), {
    error: "ratings.focus must be an integer 0-4 or null",
  });
  assert.deepStrictEqual(parseRatingsInput({ stress: 0 }, undefined, testConfig), {
    error: "ratings.stress must be an integer 1-5 or null",
  });
  assert.deepStrictEqual(parseRatingsInput({ stress: "3" }, undefined, testConfig), {
    error: "ratings.stress must be an integer 1-5 or null",
  });
  // submit: all required items of the FINAL category
  assert.deepStrictEqual(parseRatingsInput({ focus: 2 }, "work", testConfig), {
    error: "ratings.stress is required to submit a work activity",
  });
  assert.deepStrictEqual(parseRatingsInput({ focus: 2, stress: 1 }, "work", testConfig), {
    ratings: { focus: 2, stress: 1 },
  });
  // optional item / other-category values are stored, never required
  assert.deepStrictEqual(parseRatingsInput({ focus: 1 }, "break", testConfig), { ratings: { focus: 1 } });
  assert.deepStrictEqual(parseRatingsInput({}, "break", testConfig), { ratings: {} });
  // paper config: other has no items
  assert.deepStrictEqual(parseRatingsInput(undefined, "other", example), { ratings: {} });
  assert.deepStrictEqual(parseRatingsInput({ mental_recovery: 4 }, "work", example), {
    error: "ratings.mental_demand is required to submit a work activity",
  });
});

// --- HTTP against a server running study.test.yaml ------------------------------

const PORT = 3100 + Math.floor(Math.random() * 500);
const BASE = `http://127.0.0.1:${PORT}`;
const serverEnv: NodeJS.ProcessEnv = {
  ...process.env,
  BLINKS_STUDY_CONFIG: TEST_CONFIG,
  DATA_DIR: path.join(tmp, "data"),
  RECORDINGS_DIR: path.join(tmp, "recordings"),
  CAMERA_PORT: String(PORT),
  HOST: "127.0.0.1",
  DISABLE_PUSH: "1",
};
fs.mkdirSync(serverEnv.DATA_DIR!, { recursive: true });
fs.mkdirSync(serverEnv.RECORDINGS_DIR!, { recursive: true });

const runScript = (script: string, args: string[]): void => {
  const result = childProcess.spawnSync(
    process.execPath,
    [path.join(SERVER_DIR, "node_modules", "tsx", "dist", "cli.mjs"), path.join(SERVER_DIR, "scripts", script), ...args],
    { env: serverEnv, encoding: "utf8", cwd: SERVER_DIR },
  );
  assert.strictEqual(result.status, 0, `${script}: ${result.stderr}`);
};

let server: childProcess.ChildProcess | undefined;
let serverLog = "";
let participantToken = "";
let adminToken = "";

const request = async (
  method: string,
  route: string,
  token?: string,
  body?: unknown,
  extraHeaders: Record<string, string> = {},
): Promise<{ status: number; json: any; headers: Headers; text: string }> => {
  const response = await fetch(`${BASE}${route}`, {
    method,
    redirect: "manual",
    headers: {
      ...extraHeaders,
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  let json: any = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* text body */
  }
  return { status: response.status, json, headers: response.headers, text };
};

test("http: server starts with the test config", async () => {
  runScript("create-user.ts", ["cfgtester", "password123"]);
  runScript("create-admin.ts", ["cfgadmin", "password123"]);
  server = childProcess.spawn(process.execPath, [path.join(SERVER_DIR, "dist", "server.js")], {
    env: serverEnv,
    cwd: SERVER_DIR,
  });
  server.stdout!.on("data", (chunk) => (serverLog += chunk));
  server.stderr!.on("data", (chunk) => (serverLog += chunk));
  for (let attempt = 0; attempt < 100; attempt++) {
    try {
      if ((await fetch(`${BASE}/health`)).ok) break;
    } catch {
      /* not up yet */
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.match(serverLog, /Study config: .*study\.test\.yaml/);
  participantToken = (await request("POST", "/api/login", undefined, { username: "cfgtester", password: "password123" })).json.token;
  adminToken = (await request("POST", "/api/admin/login", undefined, { username: "cfgadmin", password: "password123" })).json.token;
  assert.ok(participantToken && adminToken);
});

test("http: GET /api/study-config (participant, admin, none)", async () => {
  const participant = await request("GET", "/api/study-config", participantToken);
  assert.strictEqual(participant.status, 200);
  assert.strictEqual(participant.headers.get("cache-control"), "no-store");
  assert.deepStrictEqual(participant.json, JSON.parse(JSON.stringify(studyConfigResponse(true, testConfig))));
  assert.strictEqual(participant.json.windowing.windowMinutes, 10);
  const admin = await request("GET", "/api/study-config", adminToken);
  assert.strictEqual(admin.status, 200);
  assert.strictEqual(admin.json.surveys, null);
  assert.deepStrictEqual((await request("GET", "/api/study-config")).json, { error: "unauthorized" });
  assert.strictEqual((await request("GET", "/api/study-config", "bogus")).status, 401);
});

test("http: GET /api/app-config (participant only, PIN never logged)", async () => {
  const response = await request("GET", "/api/app-config", participantToken);
  assert.strictEqual(response.status, 200);
  assert.strictEqual(response.headers.get("cache-control"), "no-store");
  assert.deepStrictEqual(response.json, JSON.parse(JSON.stringify(appConfigResponse(testConfig))));
  assert.strictEqual((await request("GET", "/api/app-config", adminToken)).status, 401);
  assert.strictEqual((await request("GET", "/api/app-config")).status, 401);
  assert.ok(!serverLog.includes("123456"), "PIN must not be logged");
});

test("http: GET /api/payout needs a participant session with completed onboarding", async () => {
  const cookie = (token: string) => ({ Cookie: `other=1; blinks_token=${encodeURIComponent(token)}` });
  const anonymous = await request("GET", "/api/payout");
  assert.deepStrictEqual([anonymous.status, anonymous.json], [401, { error: "unauthorized" }]);
  assert.strictEqual(anonymous.headers.get("location"), null, "no payout link without login");
  assert.strictEqual(anonymous.headers.get("cache-control"), "no-store");
  assert.strictEqual((await request("GET", "/api/payout", undefined, undefined, cookie("bogus"))).status, 401);
  assert.strictEqual((await request("GET", "/api/payout", adminToken)).status, 401, "admin is not a participant");
  assert.strictEqual(
    (await request("GET", "/api/payout", undefined, undefined, { Cookie: `blinks_admin_token=${adminToken}` })).status,
    401,
  );
  const notOnboarded = await request("GET", "/api/payout", undefined, undefined, cookie(participantToken));
  assert.deepStrictEqual([notOnboarded.status, notOnboarded.json?.code], [403, "onboarding_required"]);
  assert.strictEqual(notOnboarded.headers.get("location"), null);

  // complete onboarding (lab password -> own password, then confirm)
  const changed = await request("POST", "/api/onboarding/password", participantToken, { newPassword: "private-password-42" });
  assert.strictEqual(changed.status, 200, changed.text);
  const completed = await request("POST", "/api/onboarding/complete", participantToken);
  assert.strictEqual(completed.status, 200, completed.text);

  for (const response of [
    await request("GET", "/api/payout", undefined, undefined, cookie(participantToken)),
    await request("GET", "/api/payout", participantToken),
  ]) {
    assert.strictEqual(response.status, 302);
    assert.strictEqual(response.headers.get("location"), "https://payout.example.org/test");
    assert.strictEqual(response.headers.get("cache-control"), "no-store");
  }
});

test("http: POST /api/recording/device-info (201, 200 replay, 409, 400, 401)", async () => {
  const body = {
    eventId: "dev-1",
    session: 1792260000,
    device: "AABBCCDDEEFF",
    clientEpochMs: 1792260001234,
    requestedIntervalMs: 5000,
    settingsFormFactor: "clip",
    info: { v: 1, fw: "1.2.0", formFactor: "glasses", intervalMs: 5000, defaultMs: 30000, minMs: 5000, maxMs: 600000, battery: 80 },
  };
  const created = await request("POST", "/api/recording/device-info", participantToken, body);
  assert.deepStrictEqual([created.status, created.json], [201, { ok: true, duplicate: false }]);
  const replay = await request("POST", "/api/recording/device-info", participantToken, body);
  assert.deepStrictEqual([replay.status, replay.json], [200, { ok: true, duplicate: true }]);
  const conflict = await request("POST", "/api/recording/device-info", participantToken, { ...body, requestedIntervalMs: 6000 });
  assert.deepStrictEqual([conflict.status, conflict.json], [409, { error: "eventId already used with a different payload" }]);
  const oldFirmware = await request("POST", "/api/recording/device-info", participantToken, {
    ...body, eventId: "dev-2", requestedIntervalMs: null, settingsFormFactor: null, info: null,
  });
  assert.strictEqual(oldFirmware.status, 201);
  const badCases: [Record<string, unknown>, string][] = [
    [{ session: 0 }, "session must be a positive integer"],
    [{ eventId: "" }, "eventId must be a string of 1-128 characters"],
    [{ device: "AA:BB" }, "device must be 1-64 characters [A-Za-z0-9]"],
    [{ info: [] }, "info must be an object or null"],
    [{ info: undefined }, "info must be an object or null"],
    [{ info: { ...body.info, intervalMs: "5000" } }, "info.intervalMs must be an integer"],
    [{ info: { ...body.info, fw: 1 } }, "info.fw must be a string"],
    [{ requestedIntervalMs: -1 }, "requestedIntervalMs must be a positive integer or null"],
  ];
  for (const [patch, error] of badCases) {
    const response = await request("POST", "/api/recording/device-info", participantToken, { ...body, eventId: "bad", ...patch });
    assert.deepStrictEqual([response.status, response.json], [400, { error }], JSON.stringify(patch));
  }
  assert.strictEqual((await request("POST", "/api/recording/device-info", adminToken, body)).status, 401);

  const Database = require("better-sqlite3");
  const db = new Database(path.join(serverEnv.RECORDINGS_DIR!, "recordings.db"), { readonly: true });
  const rows = db.prepare("SELECT * FROM device_info_reports ORDER BY event_id").all();
  db.close();
  assert.strictEqual(rows.length, 2);
  assert.strictEqual(rows[0].firmware_version, "1.2.0");
  assert.strictEqual(rows[0].form_factor, "glasses");
  assert.strictEqual(rows[0].settings_form_factor, "clip");
  assert.strictEqual(rows[0].interval_ms, 5000);
  assert.strictEqual(rows[0].default_ms, 30000);
  assert.deepStrictEqual(JSON.parse(rows[0].info_json), body.info, "info stored verbatim incl. extra fields");
  assert.strictEqual(rows[1].info_json, null);

  const tables = await request("GET", "/api/admin/tables/device_info_reports?limit=10&offset=0", adminToken);
  assert.strictEqual(tables.status, 200);
  assert.strictEqual(tables.json.total, 2);
});

test("http: form factor validated against devices.formFactors", async () => {
  // The test config adds "clip"; the old DB CHECK would have rejected it.
  const ok = await request("PUT", "/api/study-settings/camera-form-factor", participantToken, { cameraFormFactor: "clip" });
  assert.strictEqual(ok.status, 200, ok.text);
  const bad = await request("PUT", "/api/study-settings/camera-form-factor", participantToken, { cameraFormFactor: "pendant" });
  assert.strictEqual(bad.status, 400);
});

test("http: reconstruction state exposes availableFrom", async () => {
  const state = await request("GET", "/api/reconstruction/state", participantToken);
  if (state.status === 403) return; // onboarding gate: covered by the smoke test
  assert.strictEqual(state.json.availableFrom, "00:00");
});

(async () => {
  try {
    for (const [name, fn] of tests) {
      await fn();
      passed++;
      console.log(`ok - ${name}`);
    }
  } catch (error) {
    console.error(serverLog);
    throw error;
  } finally {
    server?.kill();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  console.log(`\n${passed} study-config runtime tests passed`);
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
