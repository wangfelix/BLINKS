// Migration test: activities.workload_rating/recovery_rating ->
// activity_ratings (study config, documentation section 7), plus the removal of
// the camera_form_factor CHECK. Starts from the exact pre-migration schema
// (fixtures/recordings-schema-pre-study-config.sql) with synthetic rows.
//
//   npx tsx scripts/test-ratings-migration.ts

import assert = require("assert");
import fs = require("fs");
import os = require("os");
import path = require("path");
import Database = require("better-sqlite3");

import {
  getLastRatingsMigrationReport,
  initDb,
  listActivitiesByKind,
  parseRatingsJson,
  ratingsMigrationTestHooks,
  replaceActivities,
  setCameraFormFactor,
} from "../src/db";

const SCHEMA = fs.readFileSync(
  path.join(__dirname, "fixtures", "recordings-schema-pre-study-config.sql"),
  "utf8",
);
const day = "2026-07-25";
const t0 = Date.parse(`${day}T08:00:00Z`);

// 3 participants x (self, proposal, assisted); ratings in every combination.
const buildLegacyDb = (dbPath: string): { activities: number } => {
  const legacy = new Database(dbPath);
  legacy.exec(SCHEMA);
  const now = t0;
  const insertParticipant = legacy.prepare(
    `INSERT INTO participants (username, camera_form_factor, created_at)
     VALUES (?, ?, ?)`,
  );
  const insertList = legacy.prepare(
    `INSERT INTO activity_lists (participant, round, day, kind, immutable, status, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  );
  const insertActivity = legacy.prepare(
    `INSERT INTO activities (
       activity_list_id, proposal_activity_id, position, start_ms, end_ms,
       raw_label, category_label, source, workload_rating, recovery_rating,
       created_at
     ) VALUES (?, ?, ?, ?, ?, 'computer_or_monitor_use', ?, ?, ?, ?, ?)`,
  );
  let activities = 0;
  ["p1", "p2", "p3"].forEach((participant, pIndex) => {
    insertParticipant.run(participant, pIndex === 2 ? null : pIndex === 0 ? "necklace" : "glasses", now);
    const self = insertList.run(participant, 1, day, "self", 0, "submitted", now).lastInsertRowid;
    const proposal = insertList.run(participant, 2, day, "vlm_proposal", 1, null, now).lastInsertRowid;
    const assisted = insertList.run(participant, 2, day, "assisted", 0, "draft", now).lastInsertRowid;
    const ratingCases: [string, number | null, number | null][] = [
      ["work", 7, null],
      ["break", null, 1],
      ["other", null, null],
      ["work", 3, 5], // value for the "other" category item is kept, too
    ];
    ratingCases.forEach(([category, workload, recovery], position) => {
      const start = t0 + position * 300_000;
      insertActivity.run(self, null, position, start, start + 300_000, category, "user", workload, recovery, now);
      activities++;
      const proposalId = insertActivity.run(
        proposal, null, position, start, start + 300_000, category, "vlm", null, null, now,
      ).lastInsertRowid;
      activities++;
      insertActivity.run(
        assisted, proposalId, position, start, start + 300_000, category, "vlm",
        workload === null ? null : 8 - workload, recovery, now,
      );
      activities++;
    });
  });
  legacy.close();
  return { activities };
};

type Snapshot = {
  activities: { id: number; proposal_activity_id: number | null; workload: number | null; recovery: number | null }[];
};
const snapshot = (dbPath: string): Snapshot => {
  const db = new Database(dbPath, { readonly: true });
  const rows = db
    .prepare(
      `SELECT id, proposal_activity_id, workload_rating AS workload, recovery_rating AS recovery
       FROM activities ORDER BY id`,
    )
    .all() as Snapshot["activities"];
  db.close();
  return { activities: rows };
};

// Full participants state: schema SQL + every row/column.
const participantsState = (dbPath: string) => {
  const db = new Database(dbPath, { readonly: true });
  const state = {
    sql: (db.prepare(`SELECT sql FROM sqlite_master WHERE name = 'participants'`).get() as { sql: string }).sql,
    rows: db.prepare(`SELECT * FROM participants ORDER BY username`).all(),
  };
  db.close();
  return state;
};

const columnsOf = (dbPath: string, table: string): string[] => {
  const db = new Database(dbPath, { readonly: true });
  const names = (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((c) => c.name);
  db.close();
  return names;
};

let passed = 0;
const test = (name: string, fn: () => void): void => {
  fn();
  passed++;
  console.log(`ok - ${name}`);
};

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "blinks-ratings-mig-"));

test("migrates every rating, maps keys, keeps ids and rows", () => {
  const dbPath = path.join(tmp, "migrate.db");
  const { activities } = buildLegacyDb(dbPath);
  const before = snapshot(dbPath);
  const expectedDemand = before.activities.filter((a) => a.workload !== null).length;
  const expectedRecovery = before.activities.filter((a) => a.recovery !== null).length;

  initDb(dbPath);
  const report = getLastRatingsMigrationReport();
  assert.deepStrictEqual(report, {
    migrated: true,
    activities,
    ratingsByKey: { mental_demand: expectedDemand, mental_recovery: expectedRecovery },
  });

  const cols = columnsOf(dbPath, "activities");
  assert.ok(!cols.includes("workload_rating") && !cols.includes("recovery_rating"));

  const db = new Database(dbPath, { readonly: true });
  const after = db.prepare(`SELECT id, proposal_activity_id FROM activities ORDER BY id`).all();
  assert.deepStrictEqual(
    after,
    before.activities.map(({ id, proposal_activity_id }) => ({ id, proposal_activity_id })),
    "activity ids and proposal links unchanged",
  );
  const ratings = db
    .prepare(`SELECT activity_id, item_key, value FROM activity_ratings ORDER BY activity_id, item_key`)
    .all() as { activity_id: number; item_key: string; value: number }[];
  const expected = before.activities.flatMap((a) => [
    ...(a.workload === null ? [] : [{ activity_id: a.id, item_key: "mental_demand", value: a.workload }]),
    ...(a.recovery === null ? [] : [{ activity_id: a.id, item_key: "mental_recovery", value: a.recovery }]),
  ]);
  assert.deepStrictEqual(ratings, expected, "values 1:1, unanswered = no row");
  assert.deepStrictEqual(db.pragma("foreign_key_check"), []);
  const fks = db.prepare(`PRAGMA foreign_key_list(activity_ratings)`).all() as { table: string }[];
  assert.deepStrictEqual(fks.map((fk) => fk.table), ["activities"], "FK still points at activities");
  db.close();

  // API read path returns the same values.
  const assisted = listActivitiesByKind("p1", 2, "assisted");
  assert.deepStrictEqual(
    assisted.map((a) => parseRatingsJson(a.ratings_json)),
    [{ mental_demand: 1 }, { mental_recovery: 1 }, {}, { mental_demand: 5, mental_recovery: 5 }],
  );
});

test("idempotent: second start changes nothing", () => {
  const dbPath = path.join(tmp, "migrate.db");
  const db1 = new Database(dbPath, { readonly: true });
  const ratingsBefore = db1.prepare(`SELECT * FROM activity_ratings ORDER BY activity_id, item_key`).all();
  const activitiesBefore = db1.prepare(`SELECT * FROM activities ORDER BY id`).all();
  db1.close();
  initDb(dbPath);
  assert.strictEqual(getLastRatingsMigrationReport()?.migrated, false);
  const db2 = new Database(dbPath, { readonly: true });
  assert.deepStrictEqual(db2.prepare(`SELECT * FROM activity_ratings ORDER BY activity_id, item_key`).all(), ratingsBefore);
  assert.deepStrictEqual(db2.prepare(`SELECT * FROM activities ORDER BY id`).all(), activitiesBefore);
  db2.close();
});

test("cascade: replace-all save removes the old ratings", () => {
  replaceActivities({
    participant: "p1",
    round: 2,
    day,
    submit: false,
    activities: [
      {
        start_ms: t0,
        end_ms: t0 + 300_000,
        raw_label: "computer_or_monitor_use",
        category_label: "work",
        source: "user",
        ratings: { mental_demand: 2, mental_recovery: null },
      },
    ],
  });
  const db = new Database(path.join(tmp, "migrate.db"), { readonly: true });
  const orphans = db
    .prepare(
      `SELECT COUNT(*) AS n FROM activity_ratings r
       LEFT JOIN activities a ON a.id = r.activity_id WHERE a.id IS NULL`,
    )
    .get() as { n: number };
  db.close();
  assert.strictEqual(orphans.n, 0);
  assert.deepStrictEqual(
    listActivitiesByKind("p1", 2, "assisted").map((a) => parseRatingsJson(a.ratings_json)),
    [{ mental_demand: 2 }],
  );
});

test("rollback: a failure inside the migration leaves the DB untouched", () => {
  const dbPath = path.join(tmp, "rollback.db");
  buildLegacyDb(dbPath);
  const before = snapshot(dbPath);
  const columnsBefore = columnsOf(dbPath, "activities");
  const participantsBefore = participantsState(dbPath);
  ratingsMigrationTestHooks.failBeforeCommit = true;
  try {
    assert.throws(() => initDb(dbPath), /ratings migration test failure/);
  } finally {
    ratingsMigrationTestHooks.failBeforeCommit = false;
  }
  assert.deepStrictEqual(columnsOf(dbPath, "activities"), columnsBefore);
  assert.deepStrictEqual(snapshot(dbPath), before);
  assert.deepStrictEqual(columnsOf(dbPath, "activity_ratings"), [], "activity_ratings not created");
  // The form-factor rebuild ran (and committed) before the ratings failure:
  // CHECK gone, every participant row identical (separate, idempotent step).
  const participants = participantsState(dbPath);
  assert.ok(!/CHECK/i.test(participants.sql));
  assert.deepStrictEqual(participants.rows, participantsBefore.rows);
  // ... and the next regular start migrates normally.
  initDb(dbPath);
  assert.strictEqual(getLastRatingsMigrationReport()?.migrated, true);
});

test("rollback: a failure inside the form-factor migration leaves participants untouched", () => {
  const dbPath = path.join(tmp, "rollback-form-factor.db");
  buildLegacyDb(dbPath);
  const participantsBefore = participantsState(dbPath);
  assert.ok(/CHECK/i.test(participantsBefore.sql), "fixture has the old CHECK");
  const activitiesBefore = snapshot(dbPath);
  const columnsBefore = columnsOf(dbPath, "activities");
  ratingsMigrationTestHooks.failFormFactorBeforeCommit = true;
  try {
    assert.throws(() => initDb(dbPath), /form-factor migration test failure/);
  } finally {
    ratingsMigrationTestHooks.failFormFactorBeforeCommit = false;
  }
  assert.deepStrictEqual(participantsState(dbPath), participantsBefore, "schema incl. CHECK and rows unchanged");
  const leftovers = new Database(dbPath, { readonly: true });
  assert.strictEqual(
    leftovers.prepare(`SELECT COUNT(*) AS n FROM sqlite_master WHERE name LIKE '%_rebuild'`).get().n,
    0,
    "no rebuild table left",
  );
  leftovers.close();
  // initDb stopped before the ratings migration: legacy columns intact
  assert.deepStrictEqual(columnsOf(dbPath, "activities"), columnsBefore);
  assert.deepStrictEqual(snapshot(dbPath), activitiesBefore);
  // next regular start migrates both
  initDb(dbPath);
  assert.ok(!/CHECK/i.test(participantsState(dbPath).sql));
  assert.deepStrictEqual(participantsState(dbPath).rows, participantsBefore.rows);
  assert.strictEqual(getLastRatingsMigrationReport()?.migrated, true);
});

test("camera_form_factor CHECK removed, values kept", () => {
  const dbPath = path.join(tmp, "migrate.db");
  const db = new Database(dbPath, { readonly: true });
  const sql = (db.prepare(`SELECT sql FROM sqlite_master WHERE name = 'participants'`).get() as { sql: string }).sql;
  const values = db.prepare(`SELECT username, camera_form_factor FROM participants ORDER BY username`).all();
  db.close();
  assert.ok(!/CHECK/i.test(sql), "no CHECK left");
  assert.deepStrictEqual(values, [
    { username: "p1", camera_form_factor: "necklace" },
    { username: "p2", camera_form_factor: "glasses" },
    { username: "p3", camera_form_factor: null },
  ]);
  setCameraFormFactor("p3", "necklace");
});

test("fresh DB: final schema directly", () => {
  const dbPath = path.join(tmp, "fresh.db");
  initDb(dbPath);
  assert.ok(!columnsOf(dbPath, "activities").includes("workload_rating"));
  assert.deepStrictEqual(columnsOf(dbPath, "activity_ratings"), ["activity_id", "item_key", "value"]);
});

fs.rmSync(tmp, { recursive: true, force: true });
console.log(`\n${passed} ratings migration tests passed`);
