import fs = require("fs");
import path = require("path");
import Database = require("better-sqlite3");

import {
  ACTIVITY_LABELS,
  ACTIVITY_LABEL_SET,
} from "../src/activity-vocabulary";

const CATEGORY_LABELS = ["work", "break", "other"] as const;
const CATEGORY_LABEL_SET: ReadonlySet<string> = new Set(CATEGORY_LABELS);
const DEFAULT_SELECTED_PROBABILITY = 0.9;
const LEGACY_DEMO_ACTIVITY_LABELS: Readonly<Record<string, string>> = {
  "working at computer": "computer_or_monitor_use",
  "in a meeting": "remote_meeting",
  "drinking coffee or tea": "eating_drinking",
  "eating a meal": "eating_drinking",
  "reading documents": "paper_reading_writing",
  "walking outside": "walking_or_movement",
  "household chores": "cleaning_household",
};

interface Args {
  apply: boolean;
  force: boolean;
  selectedProbability: number;
}

interface DemoChunkRow {
  participant: string;
  chunk_start_ms: number;
  vlm_label: string;
  vlm_category: string;
}

interface StoredChunkProbabilityRow {
  vlm_label: string;
  vlm_category: string;
  vlm_activity_confidence: number;
  vlm_activity_confidences_json: string;
  vlm_category_confidence: number;
  vlm_category_confidences_json: string;
}

interface VlmActivityRow {
  id: number;
  participant: string;
  kind: "vlm_proposal" | "assisted";
  start_ms: number;
  end_ms: number;
  raw_label: string | null;
  category_label: string | null;
  vlm_raw_label: string | null;
  vlm_category: string | null;
}

const usage = (): never => {
  console.error(
    "Usage: npx tsx scripts/backfill-demo-vlm-probabilities.ts " +
      "[--apply] [--force] [--selected-probability 0.9]",
  );
  process.exit(1);
};

const parseArgs = (): Args => {
  let apply = false;
  let force = false;
  let selectedProbability = DEFAULT_SELECTED_PROBABILITY;
  const args = process.argv.slice(2);
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--apply") {
      apply = true;
      continue;
    }
    if (arg === "--force") {
      force = true;
      continue;
    }
    if (arg === "--selected-probability") {
      const value = Number(args[index + 1]);
      if (!Number.isFinite(value) || value <= 0 || value >= 1) usage();
      selectedProbability = value;
      index += 1;
      continue;
    }
    usage();
  }
  return { apply, force, selectedProbability };
};

const distributionFor = (
  labels: readonly string[],
  selectedLabel: string,
  selectedProbability: number,
): Record<string, number> => {
  if (!labels.includes(selectedLabel)) {
    throw new Error(`unsupported selected label ${JSON.stringify(selectedLabel)}`);
  }
  const selected = Number(selectedProbability.toFixed(12));
  const remainder = Number(
    ((1 - selected) / (labels.length - 1)).toFixed(12),
  );
  return Object.fromEntries(
    labels.map((label) => [
      label,
      label === selectedLabel ? selected : remainder,
    ]),
  );
};

const parseDistribution = (
  value: string,
  labels: readonly string[],
): Record<string, number> => {
  const parsed = JSON.parse(value) as unknown;
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    Array.isArray(parsed)
  ) {
    throw new Error("stored probability distribution is not an object");
  }
  const entries = Object.entries(parsed);
  if (
    entries.length !== labels.length ||
    entries.some(
      ([label, probability]) =>
        !labels.includes(label) ||
        typeof probability !== "number" ||
        !Number.isFinite(probability),
    )
  ) {
    throw new Error("stored probability distribution has an invalid shape");
  }
  return Object.fromEntries(entries);
};

const averageDistributions = (
  distributions: Record<string, number>[],
  labels: readonly string[],
): Record<string, number> =>
  Object.fromEntries(
    labels.map((label) => [
      label,
      Number(
        (
          distributions.reduce(
            (total, distribution) => total + distribution[label],
            0,
          ) / distributions.length
        ).toFixed(12),
      ),
    ]),
  );

const averageNumbers = (values: number[]): number =>
  Number(
    (
      values.reduce((total, value) => total + value, 0) / values.length
    ).toFixed(12),
  );

const requiredColumns = {
  chunks: [
    "vlm_activity_confidence",
    "vlm_activity_confidences_json",
    "vlm_category_confidence",
    "vlm_category_confidences_json",
  ],
  activities: [
    "vlm_mean_activity_confidence",
    "vlm_mean_activity_confidences_json",
    "vlm_mean_category_confidence",
    "vlm_mean_category_confidences_json",
  ],
} as const;

const assertSchemaReady = (db: Database.Database): void => {
  for (const [table, columns] of Object.entries(requiredColumns)) {
    const present = new Set(
      (
        db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]
      ).map((column) => column.name),
    );
    const missing = columns.filter((column) => !present.has(column));
    if (missing.length > 0) {
      throw new Error(
        `${table} is missing ${missing.join(", ")}; start the updated server ` +
          "once so initDb applies the schema migration",
      );
    }
  }
};

const timestampForPath = (): string =>
  new Date().toISOString().replace(/[:.]/g, "-");

const normalizedDemoActivityLabel = (label: string): string | null => {
  if (ACTIVITY_LABEL_SET.has(label)) return label;
  return LEGACY_DEMO_ACTIVITY_LABELS[label] ?? null;
};

const main = async (): Promise<void> => {
  const { apply, force, selectedProbability } = parseArgs();
  const recordingsDir =
    process.env.RECORDINGS_DIR ?? path.join(__dirname, "..", "recordings");
  const dbPath =
    process.env.RECORDINGS_DB ?? path.join(recordingsDir, "recordings.db");
  if (!fs.existsSync(dbPath)) {
    throw new Error(`recordings database not found: ${dbPath}`);
  }

  const db = new Database(dbPath);
  db.pragma("foreign_keys = ON");
  try {
    assertSchemaReady(db);

    const missingChunkProbabilityFilter = force
      ? ""
      : `AND (
           vlm_activity_confidence IS NULL
           OR vlm_activity_confidences_json IS NULL
           OR vlm_category_confidence IS NULL
           OR vlm_category_confidences_json IS NULL
         )`;
    const demoChunks = db
      .prepare(
        `SELECT participant, chunk_start_ms, vlm_label, vlm_category
         FROM chunks
         WHERE status = 'done'
           AND vlm_model = 'seed'
           AND vlm_label IS NOT NULL
           AND vlm_category IS NOT NULL
           ${missingChunkProbabilityFilter}
         ORDER BY participant, chunk_start_ms`,
      )
      .all() as DemoChunkRow[];
    const nonDemoMissingCount = (
      db
        .prepare(
          `SELECT COUNT(*) AS count
           FROM chunks
           WHERE status = 'done'
             AND vlm_label IS NOT NULL
             AND vlm_category IS NOT NULL
             AND COALESCE(vlm_model, '') != 'seed'
             AND (
               vlm_activity_confidence IS NULL
               OR vlm_activity_confidences_json IS NULL
               OR vlm_category_confidence IS NULL
               OR vlm_category_confidences_json IS NULL
             )`,
        )
        .get() as { count: number }
    ).count;
    const unmappedDemoLabels = [
      ...new Set(
        demoChunks
          .filter(
            (chunk) =>
              normalizedDemoActivityLabel(chunk.vlm_label) === null ||
              !CATEGORY_LABEL_SET.has(chunk.vlm_category),
          )
          .map(
            (chunk) =>
              `${JSON.stringify(chunk.vlm_label)} / ${JSON.stringify(chunk.vlm_category)}`,
          ),
      ),
    ];
    if (unmappedDemoLabels.length > 0) {
      throw new Error(
        "seed chunks contain unsupported labels: " +
          unmappedDemoLabels.join(", "),
      );
    }
    const legacyLabelCount = demoChunks.filter(
      (chunk) => !ACTIVITY_LABEL_SET.has(chunk.vlm_label),
    ).length;

    console.log(`Database: ${dbPath}`);
    console.log(`Selected-label fixture probability: ${selectedProbability}`);
    console.log(
      `Seed chunks ${force ? "selected for rewrite" : "needing backfill"}: ${demoChunks.length}`,
    );
    console.log(
      `Non-seed chunks left untouched: ${nonDemoMissingCount}`,
    );
    console.log(`Legacy seed labels to normalize: ${legacyLabelCount}`);
    if (!apply) {
      console.log("Dry run only. Re-run with --apply to write the demo values.");
      return;
    }
    if (demoChunks.length === 0) {
      console.log("Nothing to backfill.");
      return;
    }

    const backupDir = path.join(recordingsDir, "backups");
    fs.mkdirSync(backupDir, { recursive: true });
    const backupPath = path.join(
      backupDir,
      `recordings-before-demo-probability-backfill-${timestampForPath()}.db`,
    );
    await db.backup(backupPath);
    console.log(`Backup: ${backupPath}`);

    const updateChunk = db.prepare(
      `UPDATE chunks
       SET vlm_label = ?,
           vlm_activity_confidence = ?,
           vlm_activity_confidences_json = ?,
           vlm_category_confidence = ?,
           vlm_category_confidences_json = ?,
           updated_at = ?
       WHERE participant = ? AND chunk_start_ms = ?
         AND vlm_model = 'seed'`,
    );
    const missingActivityProbabilityFilter = force
      ? ""
      : `AND (
           a.vlm_mean_activity_confidence IS NULL
           OR a.vlm_mean_activity_confidences_json IS NULL
           OR a.vlm_mean_category_confidence IS NULL
           OR a.vlm_mean_category_confidences_json IS NULL
         )`;
    const candidateActivities = db.prepare(
      `SELECT a.id, l.participant, l.kind, a.start_ms, a.end_ms,
              a.raw_label, a.category_label,
              a.vlm_raw_label, a.vlm_category
       FROM activities a
       JOIN activity_lists l ON l.id = a.activity_list_id
       WHERE l.kind IN ('vlm_proposal', 'assisted')
         AND a.source = 'vlm'
         ${missingActivityProbabilityFilter}
       ORDER BY l.participant, l.kind, a.position`,
    );
    const chunksForActivity = db.prepare(
      `SELECT vlm_label, vlm_category,
              vlm_activity_confidence,
              vlm_activity_confidences_json,
              vlm_category_confidence,
              vlm_category_confidences_json
       FROM chunks
       WHERE participant = ?
         AND status = 'done'
         AND vlm_model = 'seed'
         AND chunk_start_ms < ?
         AND chunk_end_ms > ?
       ORDER BY chunk_start_ms`,
    );
    const updateActivity = db.prepare(
      `UPDATE activities
       SET vlm_mean_activity_confidence = ?,
           vlm_mean_activity_confidences_json = ?,
           vlm_mean_category_confidence = ?,
           vlm_mean_category_confidences_json = ?,
           updated_at = ?
       WHERE id = ?`,
    );

    let updatedActivityCount = 0;
    let skippedActivityCount = 0;
    const applyBackfill = db.transaction(() => {
      const now = Date.now();
      for (const chunk of demoChunks) {
        const activityLabel = normalizedDemoActivityLabel(chunk.vlm_label)!;
        const activityDistribution = distributionFor(
          ACTIVITY_LABELS,
          activityLabel,
          selectedProbability,
        );
        const categoryDistribution = distributionFor(
          CATEGORY_LABELS,
          chunk.vlm_category,
          selectedProbability,
        );
        updateChunk.run(
          activityLabel,
          selectedProbability,
          JSON.stringify(activityDistribution),
          selectedProbability,
          JSON.stringify(categoryDistribution),
          now,
          chunk.participant,
          chunk.chunk_start_ms,
        );
      }

      const activities = candidateActivities.all() as VlmActivityRow[];
      for (const activity of activities) {
        const genuineActivityLabel =
          activity.vlm_raw_label ?? activity.raw_label;
        const genuineCategoryLabel =
          activity.vlm_category ?? activity.category_label;
        if (
          genuineActivityLabel === null ||
          genuineCategoryLabel === null ||
          !ACTIVITY_LABEL_SET.has(genuineActivityLabel) ||
          !CATEGORY_LABEL_SET.has(genuineCategoryLabel)
        ) {
          skippedActivityCount += 1;
          continue;
        }
        const chunks = chunksForActivity.all(
          activity.participant,
          activity.end_ms,
          activity.start_ms,
        ) as StoredChunkProbabilityRow[];
        if (
          chunks.length === 0 ||
          chunks.some(
            (chunk) =>
              chunk.vlm_label !== genuineActivityLabel ||
              chunk.vlm_category !== genuineCategoryLabel,
          )
        ) {
          skippedActivityCount += 1;
          continue;
        }
        const activityDistributions = chunks.map((chunk) =>
          parseDistribution(
            chunk.vlm_activity_confidences_json,
            ACTIVITY_LABELS,
          ),
        );
        const categoryDistributions = chunks.map((chunk) =>
          parseDistribution(
            chunk.vlm_category_confidences_json,
            CATEGORY_LABELS,
          ),
        );
        updateActivity.run(
          averageNumbers(
            chunks.map((chunk) => chunk.vlm_activity_confidence),
          ),
          JSON.stringify(
            averageDistributions(activityDistributions, ACTIVITY_LABELS),
          ),
          averageNumbers(
            chunks.map((chunk) => chunk.vlm_category_confidence),
          ),
          JSON.stringify(
            averageDistributions(categoryDistributions, CATEGORY_LABELS),
          ),
          now,
          activity.id,
        );
        updatedActivityCount += 1;
      }
    });
    applyBackfill();

    console.log(`Updated seed chunks: ${demoChunks.length}`);
    console.log(`Normalized legacy seed labels: ${legacyLabelCount}`);
    console.log(`Updated VLM-backed activities: ${updatedActivityCount}`);
    console.log(`Skipped VLM-backed activities: ${skippedActivityCount}`);
    console.log(
      "Self-DRM rows, non-seed chunks, and intervention fields were unchanged.",
    );
  } finally {
    db.close();
  }
};

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
