// Database-level regression tests for DRM activity-list identity:
//   - migration from the natural-key activity_lists + child list_kind schema
//   - compatibility with the older participant+round-only activities schema
//   - stable parent IDs, enforced child foreign keys, and proposal immutability
//
//   npx tsx scripts/test-activity-lists.ts

import assert = require("assert");
import fs = require("fs");
import os = require("os");
import path = require("path");
import Database = require("better-sqlite3");

import {
  createVlmProposal,
  getActivityList,
  initDb,
  listActivitiesByKind,
  listStudyActivityLists,
  replaceActivities,
} from "../src/db";

const day = "2026-07-25";
const t0 = Date.parse(`${day}T10:00:00Z`);

const createBaseLegacySchema = (
  legacyDb: Database.Database,
  participant: string,
): void => {
  legacyDb.exec(`
    CREATE TABLE frames (
      participant TEXT NOT NULL,
      device TEXT NOT NULL,
      session INTEGER NOT NULL,
      frame_index INTEGER NOT NULL,
      capture_epoch_ms INTEGER NOT NULL,
      received_epoch_ms INTEGER NOT NULL,
      file_path TEXT NOT NULL,
      device_frame INTEGER,
      byte_length INTEGER,
      jpeg_ok INTEGER,
      vlm_status TEXT NOT NULL DEFAULT 'pending',
      vlm_model TEXT,
      vlm_label TEXT,
      vlm_description TEXT,
      vlm_descriptor TEXT,
      vlm_completed_at INTEGER,
      vlm_category TEXT,
      user_corrected_category_label TEXT,
      user_corrected_activity_label TEXT,
      PRIMARY KEY (participant, device, session, frame_index)
    );
    CREATE TABLE chunks (
      participant TEXT NOT NULL,
      chunk_start_ms INTEGER NOT NULL,
      chunk_end_ms INTEGER NOT NULL,
      frame_count INTEGER NOT NULL DEFAULT 0,
      last_frame_received_ms INTEGER,
      status TEXT NOT NULL DEFAULT 'filling',
      vlm_model TEXT,
      vlm_label TEXT,
      vlm_category TEXT,
      vlm_description TEXT,
      vlm_descriptor TEXT,
      vlm_completed_at INTEGER,
      user_corrected_category_label TEXT,
      user_corrected_activity_label TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER,
      PRIMARY KEY (participant, chunk_start_ms)
    );
    CREATE TABLE participants (
      username TEXT PRIMARY KEY,
      occupation TEXT,
      work_description TEXT,
      wake_time TEXT,
      bed_time TEXT,
      arm TEXT NOT NULL DEFAULT 'main',
      push_token TEXT,
      last_reminder_day TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER
    );
    CREATE TABLE reconstructions (
      participant TEXT NOT NULL,
      round INTEGER NOT NULL,
      mode TEXT NOT NULL,
      day TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'draft',
      created_at INTEGER NOT NULL,
      submitted_at INTEGER,
      PRIMARY KEY (participant, round)
    );
  `);
  legacyDb
    .prepare(
      "INSERT INTO participants (username, arm, created_at) VALUES (?, 'main', ?)",
    )
    .run(participant, t0);
  legacyDb
    .prepare(
      "INSERT INTO chunks (" +
        "participant, chunk_start_ms, chunk_end_ms, frame_count, status, " +
        "vlm_model, vlm_label, vlm_category, vlm_description, vlm_descriptor, " +
        "vlm_completed_at, created_at, updated_at" +
        ") VALUES (?, ?, ?, 1, 'done', 'legacy-model', " +
        "'computer_or_monitor_use', 'work', 'Visible computer use.', " +
        "'{\"posture\":\"sitting\"}', ?, ?, ?)",
    )
    .run(participant, t0, t0 + 300_000, t0, t0, t0);
  legacyDb
    .prepare(
      "INSERT INTO reconstructions " +
        "(participant, round, mode, day, status, created_at) " +
        "VALUES (?, 2, 'assisted', ?, 'draft', ?)",
    )
    .run(participant, day, t0);
};

const activityColumnNames = `
  position, start_ms, end_ms, raw_label, category_label, source,
  vlm_raw_label, vlm_category, workload_rating, recovery_rating,
  created_at, updated_at
`;
const activityColumnDefinitions = `
  position INTEGER NOT NULL,
  start_ms INTEGER NOT NULL,
  end_ms INTEGER NOT NULL,
  raw_label TEXT,
  category_label TEXT,
  source TEXT NOT NULL,
  vlm_raw_label TEXT,
  vlm_category TEXT,
  workload_rating INTEGER,
  recovery_rating INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER
`;

const runNaturalKeyMigrationTest = (): void => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "blinks-list-natural-"));
  const dbPath = path.join(dir, "recordings.db");
  const participant = "natural";
  const legacyDb = new Database(dbPath);
  createBaseLegacySchema(legacyDb, participant);

  // The first three-list implementation: kind is duplicated on child rows
  // and the parent is identified only by its natural composite key.
  legacyDb.exec(`
    CREATE TABLE activity_lists (
      participant TEXT NOT NULL,
      round INTEGER NOT NULL,
      day TEXT NOT NULL,
      kind TEXT NOT NULL,
      immutable INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      updated_at INTEGER,
      PRIMARY KEY (participant, round, kind)
    );
    CREATE TABLE activities (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      participant TEXT NOT NULL,
      round INTEGER NOT NULL,
      list_kind TEXT NOT NULL,
      ${activityColumnDefinitions}
    );
  `);
  const insertList = legacyDb.prepare(
    "INSERT INTO activity_lists " +
      "(participant, round, day, kind, immutable, created_at, updated_at) " +
      "VALUES (?, 2, ?, ?, ?, ?, ?)",
  );
  insertList.run(participant, day, "assisted", 0, t0, t0);
  insertList.run(participant, day, "vlm_proposal", 1, t0, t0);
  const insertActivity = legacyDb.prepare(
    "INSERT INTO activities " +
      `(participant, round, list_kind, ${activityColumnNames}) ` +
      "VALUES (?, 2, ?, 0, ?, ?, ?, 'work', 'vlm', ?, 'work', NULL, NULL, ?, ?)",
  );
  insertActivity.run(
    participant,
    "assisted",
    t0,
    t0 + 60_000,
    "Edited natural-key row",
    "Original proposal",
    t0,
    t0,
  );
  insertActivity.run(
    participant,
    "vlm_proposal",
    t0,
    t0 + 60_000,
    "Original proposal",
    "Original proposal",
    t0,
    t0,
  );
  legacyDb.close();

  initDb(dbPath);
  const migratedSchemaDb = new Database(dbPath, { readonly: true });
  const frameColumns = migratedSchemaDb
    .prepare("PRAGMA table_info(frames)")
    .all() as { name: string }[];
  for (const removed of [
    "vlm_status",
    "vlm_model",
    "vlm_label",
    "vlm_category",
    "vlm_description",
    "vlm_descriptor",
    "vlm_completed_at",
    "user_corrected_activity_label",
    "user_corrected_category_label",
  ]) {
    assert.ok(
      !frameColumns.some((column) => column.name === removed),
      `frames.${removed} removed during migration`,
    );
  }
  const chunkColumns = migratedSchemaDb
    .prepare("PRAGMA table_info(chunks)")
    .all() as { name: string }[];
  for (const removed of [
    "vlm_descriptor",
    "user_corrected_activity_label",
    "user_corrected_category_label",
  ]) {
    assert.ok(
      !chunkColumns.some((column) => column.name === removed),
      `chunks.${removed} removed during migration`,
    );
  }
  assert.deepStrictEqual(
    migratedSchemaDb
      .prepare(
        "SELECT vlm_label, vlm_category, vlm_description " +
          "FROM chunks WHERE participant = ? AND chunk_start_ms = ?",
      )
      .get(participant, t0),
    {
      vlm_label: "computer_or_monitor_use",
      vlm_category: "work",
      vlm_description: "Visible computer use.",
    },
    "dropping derived chunk columns preserves the original VLM result",
  );
  assert.deepStrictEqual(
    migratedSchemaDb
      .prepare("PRAGMA table_info(recording_events)")
      .all()
      .map((column: any) => column.name),
    [
      "participant",
      "event_id",
      "session",
      "event_type",
      "client_epoch_ms",
      "server_received_epoch_ms",
      "sequence_number",
    ],
    "recording event table is created during migration",
  );
  migratedSchemaDb.close();
  const assistedList = getActivityList(participant, 2, "assisted");
  const proposalList = getActivityList(participant, 2, "vlm_proposal");
  assert.ok(assistedList?.id && proposalList?.id, "surrogate parent IDs backfilled");
  assert.notStrictEqual(assistedList!.id, proposalList!.id);
  assert.deepStrictEqual(
    listActivitiesByKind(participant, 2, "assisted").map(
      (activity) => activity.raw_label,
    ),
    ["Edited natural-key row"],
    "editable list survives natural-key migration",
  );
  assert.deepStrictEqual(
    listActivitiesByKind(participant, 2, "vlm_proposal").map(
      (activity) => activity.raw_label,
    ),
    ["Original proposal"],
    "immutable proposal survives natural-key migration",
  );

  const verificationDb = new Database(dbPath);
  verificationDb.pragma("foreign_keys = ON");
  assert.deepStrictEqual(
    verificationDb
      .prepare(
        "SELECT name FROM sqlite_master " +
          "WHERE type = 'table' AND name = 'reconstructions'",
      )
      .all(),
    [],
    "legacy round state is integrated and reconstructions is removed",
  );
  const parentIdColumn = verificationDb
    .prepare(`PRAGMA table_info(activity_lists)`)
    .all()
    .find((column: any) => column.name === "id") as
    | { pk: number }
    | undefined;
  assert.strictEqual(parentIdColumn?.pk, 1, "activity_lists.id is the primary key");
  const childColumnNames = (
    verificationDb.prepare(`PRAGMA table_info(activities)`).all() as {
      name: string;
    }[]
  ).map((column) => column.name);
  assert.ok(childColumnNames.includes("activity_list_id"));
  assert.ok(!childColumnNames.includes("participant"));
  assert.ok(!childColumnNames.includes("round"));
  assert.ok(!childColumnNames.includes("list_kind"));
  assert.deepStrictEqual(
    verificationDb
      .prepare(
        "SELECT kind, status, immutable FROM activity_lists " +
          "WHERE participant = ? AND round = 2 ORDER BY kind",
      )
      .all(participant),
    [
      { kind: "assisted", status: "draft", immutable: 0 },
      {
        kind: "vlm_proposal",
        status: null,
        immutable: 1,
      },
    ],
    "list kind, workflow state, and proposal immutability stay distinct",
  );
  assert.deepStrictEqual(
    verificationDb
      .prepare(`PRAGMA foreign_key_check`)
      .all(),
    [],
    "migrated rows satisfy the foreign key",
  );
  assert.throws(
    () =>
      verificationDb
        .prepare(
          "INSERT INTO activities " +
            "(activity_list_id, position, start_ms, end_ms, source, created_at) " +
            "VALUES (999999, 0, ?, ?, 'user', ?)",
        )
        .run(t0, t0 + 1, t0),
    /FOREIGN KEY constraint failed/,
    "orphan activities are rejected",
  );
  verificationDb.close();

  assert.strictEqual(
    createVlmProposal({
      participant,
      round: 2,
      day,
      activities: [
        {
          start_ms: t0,
          end_ms: t0 + 60_000,
          raw_label: "Must not replace",
          category_label: "other",
          source: "vlm",
        },
      ],
    }),
    false,
    "existing proposal remains write-once after migration",
  );
  replaceActivities({
    participant,
    round: 2,
    day,
    submit: false,
    activities: [
      {
        start_ms: t0,
        end_ms: t0 + 60_000,
        raw_label: "Participant final edit",
        category_label: "work",
        source: "vlm",
        workload_rating: 5,
      },
    ],
  });
  replaceActivities({
    participant,
    round: 1,
    day,
    submit: false,
    activities: [
      {
        start_ms: t0,
        end_ms: t0 + 60_000,
        raw_label: "Self memory",
        category_label: "work",
        source: "user",
        workload_rating: 4,
      },
    ],
  });
  assert.deepStrictEqual(
    listStudyActivityLists(participant, day).map((list) => [
      list.round,
      list.kind,
      list.activities.map((activity) => [
        activity.activity_list_id,
        activity.raw_label,
      ]),
    ]),
    [
      [1, "self", [[getActivityList(participant, 1, "self")!.id, "Self memory"]]],
      [2, "vlm_proposal", [[proposalList!.id, "Original proposal"]]],
      [2, "assisted", [[assistedList!.id, "Participant final edit"]]],
    ],
    "all three lists query through their parent IDs",
  );

  // A second initialization is a no-op migration and preserves stable IDs.
  initDb(dbPath);
  assert.strictEqual(
    getActivityList(participant, 2, "vlm_proposal")?.id,
    proposalList!.id,
    "parent ID remains stable across restart",
  );
};

const runPreListLegacyMigrationTest = (): void => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "blinks-list-legacy-"));
  const dbPath = path.join(dir, "recordings.db");
  const participant = "legacy";
  const legacyDb = new Database(dbPath);
  createBaseLegacySchema(legacyDb, participant);
  legacyDb.exec(`
    CREATE TABLE activities (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      participant TEXT NOT NULL,
      round INTEGER NOT NULL,
      ${activityColumnDefinitions}
    )
  `);
  legacyDb
    .prepare(
      "INSERT INTO activities " +
        `(participant, round, ${activityColumnNames}) ` +
        "VALUES (?, 2, 0, ?, ?, 'Legacy row', 'work', 'vlm', " +
        "'Legacy proposal provenance', 'work', NULL, NULL, ?, ?)",
    )
    .run(participant, t0, t0 + 60_000, t0, t0);
  legacyDb.close();

  initDb(dbPath);
  const assistedList = getActivityList(participant, 2, "assisted");
  const migrated = listActivitiesByKind(participant, 2, "assisted");
  assert.ok(assistedList?.id);
  assert.deepStrictEqual(
    migrated.map((activity) => [
      activity.activity_list_id,
      activity.raw_label,
    ]),
    [[assistedList!.id, "Legacy row"]],
    "pre-list activities remain compatible and acquire a parent foreign key",
  );
};

const runModeColumnMigrationTest = (): void => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "blinks-list-mode-"));
  const dbPath = path.join(dir, "recordings.db");
  const legacyDb = new Database(dbPath);
  legacyDb.pragma("foreign_keys = ON");
  legacyDb.exec(`
    CREATE TABLE activity_lists (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      participant TEXT NOT NULL,
      round INTEGER NOT NULL,
      day TEXT NOT NULL,
      mode TEXT NOT NULL,
      kind TEXT NOT NULL,
      immutable INTEGER NOT NULL,
      status TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER,
      first_opened_at INTEGER,
      first_draft_saved_at INTEGER,
      last_draft_saved_at INTEGER,
      submitted_at INTEGER,
      proposal_viewed_at INTEGER,
      UNIQUE (participant, round, kind)
    );
    CREATE TABLE activities (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      activity_list_id INTEGER NOT NULL,
      ${activityColumnDefinitions},
      FOREIGN KEY (activity_list_id)
        REFERENCES activity_lists(id) ON DELETE CASCADE
    );
    INSERT INTO activity_lists
      (id, participant, round, day, mode, kind, immutable, status,
       created_at, updated_at, first_opened_at, first_draft_saved_at,
       last_draft_saved_at, submitted_at)
    VALUES
      (77, 'retired-control', 2, '${day}', 'self', 'self', 0, 'submitted',
       1000, 2000, 1100, 1200, 1900, 2000);
    INSERT INTO activities
      (id, activity_list_id, ${activityColumnNames})
    VALUES
      (88, 77, 0, ${t0}, ${t0 + 60_000}, 'Legacy round 2 response',
       'other', 'user', NULL, NULL, NULL, NULL, 1000, 2000);
  `);
  legacyDb.close();

  initDb(dbPath);
  const migrated = new Database(dbPath);
  const columns = (
    migrated.prepare("PRAGMA table_info(activity_lists)").all() as {
      name: string;
    }[]
  ).map((column) => column.name);
  assert.ok(!columns.includes("mode"), "obsolete mode column is removed");
  assert.deepStrictEqual(
    migrated
      .prepare(
        "SELECT id, round, kind, status, first_opened_at, submitted_at " +
          "FROM activity_lists WHERE participant = 'retired-control'",
      )
      .get(),
    {
      id: 77,
      round: 2,
      kind: "assisted",
      status: "submitted",
      first_opened_at: 1100,
      submitted_at: 2000,
    },
    "legacy round-2 self response becomes assisted without losing identity or timing",
  );
  assert.deepStrictEqual(
    migrated
      .prepare(
        "SELECT id, activity_list_id, raw_label FROM activities WHERE id = 88",
      )
      .get(),
    {
      id: 88,
      activity_list_id: 77,
      raw_label: "Legacy round 2 response",
    },
    "legacy response child remains attached to its stable parent",
  );
  assert.deepStrictEqual(migrated.prepare("PRAGMA foreign_key_check").all(), []);
  migrated.close();
};

runNaturalKeyMigrationTest();
runPreListLegacyMigrationTest();
runModeColumnMigrationTest();
console.log("ACTIVITY LIST TESTS PASSED");
