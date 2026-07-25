import assert = require("assert");
import fs = require("fs");
import os = require("os");
import path = require("path");
import Database = require("better-sqlite3");

import {
  getRoundResponseList,
  initDb,
  markVlmProposalViewed,
} from "../src/db";

// Starts from the immediately preceding production shape: round workflow and
// timing in reconstructions, stable activity-list parents, and FK children.
// initDb must merge every reconstruction into its response parent, preserve
// parent/child IDs and proposal exposure, convert a legacy round-2 self row to
// the now-invariant assisted response role, then remove reconstructions.
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "blinks-round-list-migration-"));
const dbPath = path.join(dir, "recordings.db");
const before = new Database(dbPath);
before.pragma("foreign_keys = ON");
before.exec(`
  CREATE TABLE reconstructions (
    participant          TEXT NOT NULL,
    round                INTEGER NOT NULL,
    mode                 TEXT NOT NULL,
    day                  TEXT NOT NULL,
    status               TEXT NOT NULL DEFAULT 'draft',
    created_at           INTEGER NOT NULL,
    first_opened_at      INTEGER,
    first_draft_saved_at INTEGER,
    last_draft_saved_at  INTEGER,
    submitted_at         INTEGER,
    PRIMARY KEY (participant, round)
  );
  INSERT INTO reconstructions
    (participant, round, mode, day, status, created_at,
     first_opened_at, first_draft_saved_at, last_draft_saved_at, submitted_at)
  VALUES
    ('existing', 1, 'self', '2026-07-24', 'submitted',
     1000, 1100, 1200, 1900, 2000),
    ('existing', 2, 'self', '2026-07-24', 'draft',
     2100, 2200, 2300, 2400, NULL);

  CREATE TABLE activity_lists (
    id                 INTEGER PRIMARY KEY AUTOINCREMENT,
    participant        TEXT NOT NULL,
    round              INTEGER NOT NULL,
    day                TEXT NOT NULL,
    kind               TEXT NOT NULL,
    immutable          INTEGER NOT NULL DEFAULT 0,
    created_at         INTEGER NOT NULL,
    updated_at         INTEGER,
    proposal_viewed_at INTEGER,
    UNIQUE (participant, round, kind)
  );
  INSERT INTO activity_lists
    (id, participant, round, day, kind, immutable,
     created_at, updated_at, proposal_viewed_at)
  VALUES
    (41, 'existing', 2, '2026-07-24', 'vlm_proposal', 1,
     2500, 2500, 2600),
    (42, 'existing', 2, '2026-07-24', 'assisted', 0,
     2100, 2400, NULL);

  CREATE TABLE activities (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    activity_list_id INTEGER NOT NULL,
    position         INTEGER NOT NULL,
    start_ms         INTEGER NOT NULL,
    end_ms           INTEGER NOT NULL,
    raw_label        TEXT,
    category_label   TEXT,
    source           TEXT NOT NULL,
    vlm_raw_label    TEXT,
    vlm_category     TEXT,
    workload_rating INTEGER,
    recovery_rating INTEGER,
    created_at       INTEGER NOT NULL,
    updated_at       INTEGER,
    FOREIGN KEY (activity_list_id)
      REFERENCES activity_lists(id) ON DELETE CASCADE
  );
  INSERT INTO activities
    (id, activity_list_id, position, start_ms, end_ms, raw_label,
     category_label, source, created_at, updated_at)
  VALUES
    (71, 41, 0, 10000, 20000, 'Original proposal', 'work', 'vlm', 2500, 2500),
    (72, 42, 0, 10000, 20000, 'Edited response', 'work', 'vlm', 2400, 2400);
`);
before.close();

initDb(dbPath);

const migrated = new Database(dbPath);
migrated.pragma("foreign_keys = ON");
assert.deepStrictEqual(
  migrated
    .prepare(
      "SELECT COUNT(*) AS count FROM sqlite_master " +
        "WHERE type = 'table' AND name = 'reconstructions'",
    )
    .get(),
  { count: 0 },
  "reconstructions is removed only after migration",
);

const round1 = migrated
  .prepare(
    `SELECT round, kind, immutable, status, day,
            first_opened_at, first_draft_saved_at,
            last_draft_saved_at, submitted_at, proposal_viewed_at
     FROM activity_lists
     WHERE participant = 'existing' AND round = 1`,
  )
  .get();
assert.deepStrictEqual(round1, {
  round: 1,
  kind: "self",
  immutable: 0,
  status: "submitted",
  day: "2026-07-24",
  first_opened_at: 1100,
  first_draft_saved_at: 1200,
  last_draft_saved_at: 1900,
  submitted_at: 2000,
  proposal_viewed_at: null,
});

const round2Response = migrated
  .prepare(
    `SELECT id, kind, immutable, status, first_opened_at,
            first_draft_saved_at, last_draft_saved_at, submitted_at,
            proposal_viewed_at
     FROM activity_lists WHERE id = 42`,
  )
  .get();
assert.deepStrictEqual(round2Response, {
  id: 42,
  kind: "assisted",
  immutable: 0,
  status: "draft",
  first_opened_at: 2200,
  first_draft_saved_at: 2300,
  last_draft_saved_at: 2400,
  submitted_at: null,
  proposal_viewed_at: null,
});

const proposal = migrated
  .prepare(
    `SELECT id, kind, immutable, status, first_opened_at,
            first_draft_saved_at, last_draft_saved_at, submitted_at,
            proposal_viewed_at
     FROM activity_lists WHERE id = 41`,
  )
  .get();
assert.deepStrictEqual(proposal, {
  id: 41,
  kind: "vlm_proposal",
  immutable: 1,
  status: null,
  first_opened_at: null,
  first_draft_saved_at: null,
  last_draft_saved_at: null,
  submitted_at: null,
  proposal_viewed_at: 2600,
});
assert.deepStrictEqual(
  migrated
    .prepare("SELECT id, activity_list_id, raw_label FROM activities ORDER BY id")
    .all(),
  [
    { id: 71, activity_list_id: 41, raw_label: "Original proposal" },
    { id: 72, activity_list_id: 42, raw_label: "Edited response" },
  ],
  "child IDs and parent relationships survive",
);
assert.deepStrictEqual(migrated.prepare("PRAGMA foreign_key_check").all(), []);
assert.ok(
  !(migrated.prepare("PRAGMA table_info(activity_lists)").all() as { name: string }[])
    .some((column) => column.name === "mode"),
  "activity_lists mode column is removed",
);
migrated.close();

assert.strictEqual(getRoundResponseList("existing", 1)?.submitted_at, 2000);
assert.strictEqual(getRoundResponseList("existing", 2)?.id, 42);
assert.deepStrictEqual(
  markVlmProposalViewed(41),
  2600,
  "existing proposal-view timestamp remains write-once",
);
assert.throws(
  () => markVlmProposalViewed(42),
  /VLM proposal activity list not found/,
  "only kind=vlm_proposal can receive proposal exposure",
);

// Restart is idempotent: no compatibility table is recreated and IDs remain.
initDb(dbPath);
const afterRestart = new Database(dbPath);
assert.strictEqual(
  (
    afterRestart
      .prepare("SELECT id FROM activity_lists WHERE kind = 'assisted'")
      .get() as { id: number }
  ).id,
  42,
);
assert.deepStrictEqual(
  afterRestart
    .prepare(
      "SELECT COUNT(*) AS count FROM sqlite_master " +
        "WHERE type = 'table' AND name = 'reconstructions'",
    )
    .get(),
  { count: 0 },
);
afterRestart.close();

// A failed backfill must roll the whole schema change back. In this fixture an
// orphan legacy activity cannot be mapped to the one reconstruction row, so
// the row-count guard aborts and reconstructions must remain intact.
const rollbackDir = fs.mkdtempSync(
  path.join(os.tmpdir(), "blinks-round-list-rollback-"),
);
const rollbackPath = path.join(rollbackDir, "recordings.db");
const rollbackBefore = new Database(rollbackPath);
rollbackBefore.exec(`
  CREATE TABLE reconstructions (
    participant TEXT NOT NULL,
    round INTEGER NOT NULL,
    mode TEXT NOT NULL,
    day TEXT NOT NULL,
    status TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    submitted_at INTEGER,
    PRIMARY KEY (participant, round)
  );
  INSERT INTO reconstructions VALUES
    ('mapped', 2, 'assisted', '2026-07-24', 'draft', 1000, NULL);

  CREATE TABLE activities (
    id INTEGER PRIMARY KEY,
    participant TEXT NOT NULL,
    round INTEGER NOT NULL,
    position INTEGER NOT NULL,
    start_ms INTEGER NOT NULL,
    end_ms INTEGER NOT NULL,
    raw_label TEXT,
    category_label TEXT,
    source TEXT NOT NULL,
    vlm_raw_label TEXT,
    vlm_category TEXT,
    created_at INTEGER NOT NULL
  );
  INSERT INTO activities VALUES
    (1, 'orphan', 2, 0, 10000, 20000, 'Unmapped', 'work',
     'user', NULL, NULL, 1000);
`);
rollbackBefore.close();

assert.throws(
  () => initDb(rollbackPath),
  /activity-list migration preserved 0\/1 activities/,
);
const rollbackAfter = new Database(rollbackPath);
assert.deepStrictEqual(
  rollbackAfter
    .prepare(
      "SELECT name FROM sqlite_master " +
        "WHERE type = 'table' AND name IN ('reconstructions', 'activities') " +
        "ORDER BY name",
    )
    .all(),
  [{ name: "activities" }, { name: "reconstructions" }],
  "failed migration keeps the legacy tables",
);
assert.deepStrictEqual(
  rollbackAfter
    .prepare("SELECT participant, round, status FROM reconstructions")
    .all(),
  [{ participant: "mapped", round: 2, status: "draft" }],
);
rollbackAfter.close();

console.log("ROUND-LIST WORKFLOW MIGRATION TEST PASSED");
