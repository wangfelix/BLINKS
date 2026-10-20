// Dry run of the study-config schema migration on a copy of a real recordings.db.
// Prints aggregated numbers only (no participant data). Refuses to run
// outside the OS temp dir.
//
//   mkdir -p /tmp/mig-test && cp <prod-copy>.db /tmp/mig-test/work.db
//   npx tsx scripts/check-ratings-migration-copy.ts /tmp/mig-test/work.db [--rollback | --rollback-form-factor]
//   rm -rf /tmp/mig-test
//
// --rollback: forces a failure inside the ratings migration transaction and
// checks that activities are unchanged and participants keep every row (the
// form-factor rebuild before it commits on its own).
// --rollback-form-factor: forces a failure inside the form-factor rebuild and
// checks that participants (schema + rows) and activities are unchanged.

import assert = require("assert");
import fs = require("fs");
import os = require("os");
import path = require("path");
import Database = require("better-sqlite3");

import {
  getLastRatingsMigrationReport,
  initDb,
  ratingsMigrationTestHooks,
} from "../src/db";

const dbPath = path.resolve(process.argv[2] ?? "");
const rollback = process.argv.includes("--rollback");
const rollbackFormFactor = process.argv.includes("--rollback-form-factor");
if (!process.argv[2] || !fs.existsSync(dbPath)) {
  console.error("usage: check-ratings-migration-copy.ts <copy.db> [--rollback]");
  process.exit(1);
}
if (!dbPath.startsWith(fs.realpathSync(os.tmpdir()) + path.sep)) {
  console.error(`refusing: ${dbPath} is not under ${os.tmpdir()} (work on a copy)`);
  process.exit(1);
}

type Legacy = { id: number; w: number | null; r: number | null };
const open = () => new Database(dbPath, { readonly: true });
const count = (db: Database.Database, sql: string): number =>
  (db.prepare(sql).get() as { n: number }).n;
const hasColumn = (db: Database.Database, table: string, column: string) =>
  (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).some((c) => c.name === column);
const tableCounts = (db: Database.Database): Record<string, number> =>
  Object.fromEntries(
    (db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name`).all() as { name: string }[])
      .map(({ name }) => [name, count(db, `SELECT COUNT(*) AS n FROM "${name}"`)]),
  );

const before = open();
assert.ok(hasColumn(before, "activities", "workload_rating"), "copy is not a pre-migration database");
const legacy = before
  .prepare(`SELECT id, workload_rating AS w, recovery_rating AS r FROM activities ORDER BY id`)
  .all() as Legacy[];
const countsBefore = tableCounts(before);
const activityRowsBefore = before
  .prepare(`SELECT * FROM activities ORDER BY id`)
  .all() as Record<string, unknown>[];
const participantsBefore = before.prepare(`SELECT * FROM participants ORDER BY username`).all();
const participantsSql = (db: Database.Database) =>
  (db.prepare(`SELECT sql FROM sqlite_master WHERE name = 'participants'`).get() as { sql: string }).sql;
const participantsSqlBefore = participantsSql(before);
before.close();

const nonNull = (key: "w" | "r") => legacy.filter((row) => row[key] !== null).length;
const dist = (key: "w" | "r") => {
  const out: Record<string, number> = {};
  for (const row of legacy) if (row[key] !== null) out[String(row[key])] = (out[String(row[key])] ?? 0) + 1;
  return out;
};
console.log("BEFORE", JSON.stringify({
  tables: countsBefore,
  workload_rating_non_null: nonNull("w"),
  recovery_rating_non_null: nonNull("r"),
  both_non_null: legacy.filter((row) => row.w !== null && row.r !== null).length,
  workload_value_distribution: dist("w"),
  recovery_value_distribution: dist("r"),
}));

if (rollbackFormFactor) {
  ratingsMigrationTestHooks.failFormFactorBeforeCommit = true;
  assert.throws(() => initDb(dbPath), /form-factor migration test failure/);
  ratingsMigrationTestHooks.failFormFactorBeforeCommit = false;
  const db = open();
  assert.strictEqual(participantsSql(db), participantsSqlBefore, "participants schema unchanged");
  assert.deepStrictEqual(db.prepare(`SELECT * FROM participants ORDER BY username`).all(), participantsBefore);
  assert.ok(hasColumn(db, "activities", "workload_rating"), "ratings migration not reached");
  assert.deepStrictEqual(db.prepare(`SELECT * FROM activities ORDER BY id`).all(), activityRowsBefore);
  console.log("ROLLBACK FORM-FACTOR OK", JSON.stringify({
    participants: count(db, "SELECT COUNT(*) AS n FROM participants"),
    activities: count(db, "SELECT COUNT(*) AS n FROM activities"),
  }));
  db.close();
  process.exit(0);
}

if (rollback) {
  ratingsMigrationTestHooks.failBeforeCommit = true;
  assert.throws(() => initDb(dbPath), /ratings migration test failure/);
  ratingsMigrationTestHooks.failBeforeCommit = false;
  const db = open();
  assert.ok(hasColumn(db, "activities", "workload_rating"), "legacy columns restored");
  assert.ok(!(db.prepare(`PRAGMA table_info(activity_ratings)`).all().length), "no activity_ratings");
  assert.deepStrictEqual(db.prepare(`SELECT * FROM activities ORDER BY id`).all(), activityRowsBefore);
  assert.deepStrictEqual(db.prepare(`SELECT * FROM participants ORDER BY username`).all(), participantsBefore);
  console.log("ROLLBACK OK", JSON.stringify({
    activities: count(db, "SELECT COUNT(*) AS n FROM activities"),
    participants_rows_unchanged: true,
    participants_check_removed: !/camera_form_factor\s+IN\s*\(/i.test(participantsSql(db)),
  }));
  db.close();
  process.exit(0);
}

initDb(dbPath);
const report = getLastRatingsMigrationReport();
const after = open();
const ratings = after
  .prepare(`SELECT activity_id, item_key, value FROM activity_ratings`)
  .all() as { activity_id: number; item_key: string; value: number }[];
const byKey = new Map<string, Map<number, number>>();
for (const row of ratings) {
  if (!byKey.has(row.item_key)) byKey.set(row.item_key, new Map());
  byKey.get(row.item_key)!.set(row.activity_id, row.value);
}
let mismatches = 0;
for (const row of legacy) {
  if ((byKey.get("mental_demand")?.get(row.id) ?? null) !== row.w) mismatches++;
  if ((byKey.get("mental_recovery")?.get(row.id) ?? null) !== row.r) mismatches++;
}
const otherKeys = [...byKey.keys()].filter((k) => k !== "mental_demand" && k !== "mental_recovery");
const activityRowsAfter = after.prepare(`SELECT * FROM activities ORDER BY id`).all() as Record<string, unknown>[];
let rowDiffs = 0;
activityRowsBefore.forEach((row, index) => {
  const { workload_rating: _w, recovery_rating: _r, ...rest } = row;
  try {
    assert.deepStrictEqual(activityRowsAfter[index], rest);
  } catch {
    rowDiffs++;
  }
});
const participantsAfter = after.prepare(`SELECT * FROM participants ORDER BY username`).all();
const result = {
  report,
  tables: tableCounts(after),
  activity_ratings_rows: ratings.length,
  mental_demand_rows: byKey.get("mental_demand")?.size ?? 0,
  mental_recovery_rows: byKey.get("mental_recovery")?.size ?? 0,
  value_mismatches: mismatches,
  unexpected_item_keys: otherKeys.length,
  activities_rows_changed_besides_rating_columns: rowDiffs + Math.abs(activityRowsAfter.length - activityRowsBefore.length),
  participants_unchanged: JSON.stringify(participantsAfter) === JSON.stringify(participantsBefore),
  legacy_columns_left: hasColumn(after, "activities", "workload_rating") || hasColumn(after, "activities", "recovery_rating"),
  foreign_key_violations: (after.pragma("foreign_key_check") as unknown[]).length,
  integrity_check: (after.pragma("integrity_check") as { integrity_check: string }[])[0]?.integrity_check,
};
after.close();
console.log("AFTER", JSON.stringify(result));

// Idempotency: a second start must not change anything.
const snap = () => {
  const db = open();
  const out = JSON.stringify([
    db.prepare(`SELECT * FROM activity_ratings ORDER BY activity_id, item_key`).all(),
    db.prepare(`SELECT * FROM activities ORDER BY id`).all(),
    tableCounts(db),
  ]);
  db.close();
  return out;
};
const first = snap();
initDb(dbPath);
const second = snap();
console.log("IDEMPOTENT", JSON.stringify({ unchanged: first === second, migratedAgain: getLastRatingsMigrationReport()?.migrated }));

assert.strictEqual(mismatches, 0);
assert.strictEqual(rowDiffs, 0);
assert.strictEqual(result.mental_demand_rows, nonNull("w"));
assert.strictEqual(result.mental_recovery_rows, nonNull("r"));
assert.strictEqual(result.foreign_key_violations, 0);
assert.strictEqual(result.integrity_check, "ok");
assert.ok(first === second);
console.log("MIGRATION CHECK PASSED");
