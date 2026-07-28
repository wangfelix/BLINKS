"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.CHUNK_WINDOW_MS = exports.ACTIVITY_LIST_KINDS = void 0;
exports.chunkStartOf = chunkStartOf;
exports.initDb = initDb;
exports.pinRoundResponseList = pinRoundResponseList;
exports.listSessions = listSessions;
exports.listFrames = listFrames;
exports.getFrameDeletionTarget = getFrameDeletionTarget;
exports.getFrameStatusByPath = getFrameStatusByPath;
exports.softDeleteFrameRow = softDeleteFrameRow;
exports.maxFrameIndex = maxFrameIndex;
exports.insertFrame = insertFrame;
exports.closeIdleChunks = closeIdleChunks;
exports.closeFillingChunks = closeFillingChunks;
exports.listChunksOnDay = listChunksOnDay;
exports.getParticipant = getParticipant;
exports.ensureParticipant = ensureParticipant;
exports.upsertParticipantProfile = upsertParticipantProfile;
exports.setPushToken = setPushToken;
exports.setLastReminderDay = setLastReminderDay;
exports.listPushParticipants = listPushParticipants;
exports.aggregateFrameDays = aggregateFrameDays;
exports.listFramesOnDay = listFramesOnDay;
exports.listPhotoFramesOnDay = listPhotoFramesOnDay;
exports.countFramesOnDay = countFramesOnDay;
exports.latestFrameDay = latestFrameDay;
exports.getRoundResponseList = getRoundResponseList;
exports.markRoundResponseOpened = markRoundResponseOpened;
exports.markVlmProposalViewed = markVlmProposalViewed;
exports.listActivities = listActivities;
exports.getActivityList = getActivityList;
exports.listActivitiesByKind = listActivitiesByKind;
exports.listStudyActivityLists = listStudyActivityLists;
exports.createVlmProposal = createVlmProposal;
exports.replaceActivities = replaceActivities;
exports.exportFramesCsv = exportFramesCsv;
const better_sqlite3_1 = __importDefault(require("better-sqlite3"));
const time_1 = require("./time");
exports.ACTIVITY_LIST_KINDS = [
    "self",
    "vlm_proposal",
    "assisted",
];
// --- 5-minute chunks ---------------------------------------------------------
// The chunk is the VLM inference unit: frames are grouped into clock-aligned
// 5-minute windows at ingestion, and the VLM worker labels whole chunks (not
// individual frames). Epoch-aligned windows ARE local-clock-aligned windows:
// every real-world UTC offset is a whole multiple of 5 minutes.
exports.CHUNK_WINDOW_MS = 5 * 60 * 1000;
/** Clock-aligned window start containing the given capture time. */
function chunkStartOf(captureEpochMs) {
    return captureEpochMs - (captureEpochMs % exports.CHUNK_WINDOW_MS);
}
let db;
let insertStmt;
let exportStmt;
let listSessionsStmt;
let listFramesStmt;
let getFrameForDeletionStmt;
let softDeleteFrameStmt;
let maxFrameIndexStmt;
let frameStatusByPathStmt;
// Chunk statements
let upsertChunkStmt;
let closeEarlierChunksStmt;
let closeIdleChunksStmt;
let closeParticipantChunksStmt;
let chunksInRangeStmt;
let getFrameChunkStmt;
let decrementChunkStmt;
let deleteEmptyChunkStmt;
let insertFrameTx;
let softDeleteFrameTx;
// DRM statements
let getParticipantStmt;
let insertParticipantStmt;
let updateProfileStmt;
let updatePushTokenStmt;
let updateLastReminderDayStmt;
let listPushParticipantsStmt;
let frameDayStatsStmt;
let framesInRangeStmt;
let photoFramesInRangeStmt;
let getRoundResponseListStmt;
let insertRoundResponseListStmt;
let markFirstOpenedStmt;
let markDraftSavedStmt;
let markSubmittedStmt;
let markVlmProposalViewedStmt;
let listActivitiesStmt;
let listActivitiesByKindStmt;
let getActivityListStmt;
let listActivityListsForDayStmt;
let upsertEditableActivityListStmt;
let insertVlmProposalListStmt;
let listVlmSpanActivitiesStmt;
let deleteActivitiesStmt;
let insertActivityStmt;
let propagateCorrectionsStmt;
let createVlmProposalTx;
let replaceActivitiesTx;
// Adds a column to the frames table only if it is missing, so an existing
// recordings.db (written before the column was introduced) is upgraded in
// place without losing rows. Must be called after the table exists.
function migrateAddColumn(column, ddl) {
    const cols = db.prepare(`PRAGMA table_info(frames)`).all();
    if (!cols.some((c) => c.name === column)) {
        db.exec(`ALTER TABLE frames ADD COLUMN ${ddl}`);
    }
}
function initDb(dbPath) {
    db = new better_sqlite3_1.default(dbPath);
    // Schema upgrades may rebuild the DRM parent/child tables. Foreign-key
    // enforcement must be disabled outside that transaction, then is enabled
    // and checked before any prepared statement can use the database.
    db.pragma("foreign_keys = OFF");
    // WAL lets the VLM reader run alongside the ingestion writer; NORMAL is the
    // standard fast/consistent pairing (a power loss can drop only the last
    // transaction, whose JPEG is likely lost too).
    db.pragma("journal_mode = WAL");
    db.pragma("synchronous = NORMAL");
    db.exec(`
    CREATE TABLE IF NOT EXISTS frames (
      participant       TEXT    NOT NULL,
      device            TEXT    NOT NULL,
      session           INTEGER NOT NULL,
      frame_index       INTEGER NOT NULL,
      capture_epoch_ms  INTEGER NOT NULL,
      received_epoch_ms INTEGER NOT NULL,
      file_path         TEXT    NOT NULL,
      device_frame      INTEGER,
      byte_length       INTEGER,
      jpeg_ok           INTEGER,
      vlm_status        TEXT    NOT NULL DEFAULT 'pending',
      vlm_model         TEXT,
      vlm_label         TEXT,
      vlm_description   TEXT,
      vlm_descriptor    TEXT,
      vlm_completed_at  INTEGER,
      -- DRM: per-frame work|break|other from the VLM worker, plus the labels
      -- the participant's SUBMITTED reconstruction propagates back onto the
      -- frames (NULL = never touched by a submitted reconstruction).
      vlm_category      TEXT,
      user_corrected_category_label TEXT,
      user_corrected_activity_label TEXT,
      -- Face anonymization, filled by the separate face-blur worker (Python).
      -- Faces are pixelated in place BEFORE the frame is ever served; the read
      -- API only exposes frames whose face_status='done'.
      face_status       TEXT    NOT NULL DEFAULT 'pending',  -- pending|processing|done|failed
      face_count        INTEGER,                             -- faces detected/obscured
      face_method       TEXT,                                -- e.g. 'mosaic:centerface@0.2'
      face_completed_at INTEGER,
      -- Soft deletion keeps the research/audit row while removing the JPEG.
      -- file_path is cleared at deletion so no serving path remains.
      deleted_at        INTEGER,
      PRIMARY KEY (participant, device, session, frame_index)
    );
    CREATE INDEX IF NOT EXISTS idx_frames_time
      ON frames (participant, capture_epoch_ms);
    CREATE INDEX IF NOT EXISTS idx_frames_pending
      ON frames (capture_epoch_ms) WHERE vlm_status = 'pending';
  `);
    // Migrate DBs created before the face_* columns existed (the columns are part
    // of the CREATE above for fresh DBs; ALTER adds them to existing ones). Every
    // pre-existing row gets face_status='pending', so the worker backfills them.
    migrateAddColumn("face_status", "face_status TEXT NOT NULL DEFAULT 'pending'");
    migrateAddColumn("face_count", "face_count INTEGER");
    migrateAddColumn("face_method", "face_method TEXT");
    migrateAddColumn("face_completed_at", "face_completed_at INTEGER");
    migrateAddColumn("deleted_at", "deleted_at INTEGER");
    // Recreate these partial indexes after the migration so older databases do
    // not keep indexing soft-deleted work as pending.
    db.exec(`
    DROP INDEX IF EXISTS idx_frames_pending;
    DROP INDEX IF EXISTS idx_frames_face_pending;
    CREATE INDEX idx_frames_pending
      ON frames (capture_epoch_ms)
      WHERE vlm_status = 'pending' AND deleted_at IS NULL;
    CREATE INDEX idx_frames_face_pending
      ON frames (capture_epoch_ms)
      WHERE face_status = 'pending' AND deleted_at IS NULL;
    CREATE INDEX IF NOT EXISTS idx_frames_deleted
      ON frames (participant, deleted_at)
      WHERE deleted_at IS NOT NULL;
  `);
    // DRM migration (additive, same pattern as face_*): category + propagated
    // user-corrected labels on frames, plus participants and activity lists.
    // NOTE (2026-07 chunk rework): frames.vlm_* and frames.user_corrected_* are
    // FROZEN legacy columns — kept readable for pre-chunk test data but no
    // longer written. The VLM output and the propagated corrections now live on
    // the 5-minute chunks table below.
    migrateAddColumn("vlm_category", "vlm_category TEXT");
    migrateAddColumn("user_corrected_category_label", "user_corrected_category_label TEXT");
    migrateAddColumn("user_corrected_activity_label", "user_corrected_activity_label TEXT");
    // Chunk rework (additive): every frame knows its clock-aligned 5-minute
    // window; NULL marks legacy rows ingested before chunks existed (they keep
    // their frozen per-frame vlm_* data and are excluded from chunk logic).
    migrateAddColumn("chunk_start_ms", "chunk_start_ms INTEGER");
    db.exec(`
    CREATE INDEX IF NOT EXISTS idx_frames_chunk
      ON frames (participant, chunk_start_ms);
    CREATE TABLE IF NOT EXISTS chunks (
      participant     TEXT    NOT NULL,
      chunk_start_ms  INTEGER NOT NULL,  -- clock-aligned 5-min window start
      chunk_end_ms    INTEGER NOT NULL,  -- start + 5 min (exclusive)
      frame_count     INTEGER NOT NULL DEFAULT 0,
      last_frame_received_ms INTEGER,    -- server receipt of the newest frame
      -- Lifecycle: 'filling' while the window can still receive frames;
      -- 'ready' once closed (a later-window frame arrived, or the idle sweep
      -- fired); the VLM worker takes it ready -> processing -> done|failed.
      status          TEXT    NOT NULL DEFAULT 'filling',
      vlm_model       TEXT,
      vlm_label       TEXT,
      vlm_category    TEXT,               -- work|break|other
      vlm_description TEXT,
      vlm_descriptor  TEXT,               -- JSON scene-state descriptor
      vlm_completed_at INTEGER,
      -- Label-quality propagation target (was frames.user_corrected_*): the
      -- submitted ASSISTED reconstruction stamps its labels onto every chunk
      -- overlapping each activity's span.
      user_corrected_category_label TEXT,
      user_corrected_activity_label TEXT,
      created_at      INTEGER NOT NULL,
      updated_at      INTEGER,
      PRIMARY KEY (participant, chunk_start_ms)
    );
    CREATE INDEX IF NOT EXISTS idx_chunks_status
      ON chunks (status, chunk_start_ms);
  `);
    // DRM schema discovery. Workflow state used to live in a separate
    // reconstructions table; the final model moves it onto the response-list
    // parent so an opened-but-empty round still has one durable identity.
    const tableHasColumn = (table, column) => {
        const cols = db.prepare(`PRAGMA table_info(${table})`).all();
        return cols.some((c) => c.name === column);
    };
    const tableExists = (table) => db.prepare(`PRAGMA table_info(${table})`).all().length > 0;
    if (tableExists("participants") && !tableHasColumn("participants", "arm")) {
        db.exec(`DROP TABLE participants;`);
    }
    db.exec(`
    CREATE TABLE IF NOT EXISTS participants (
      username          TEXT PRIMARY KEY,
      occupation        TEXT,
      work_description  TEXT,
      wake_time         TEXT,
      bed_time          TEXT,
      arm               TEXT NOT NULL DEFAULT 'main',
      push_token        TEXT,
      last_reminder_day TEXT,
      created_at        INTEGER NOT NULL,
      updated_at        INTEGER
    );
  `);
    const reconstructionsExist = tableExists("reconstructions");
    if (reconstructionsExist &&
        !tableHasColumn("reconstructions", "round")) {
        throw new Error("cannot safely migrate the obsolete pre-round reconstructions schema");
    }
    const activityListsSchema = `
    CREATE TABLE activity_lists (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      participant  TEXT NOT NULL,
      round        INTEGER NOT NULL,
      day          TEXT NOT NULL,
      -- The list role is the workflow truth: round 1 has a self response;
      -- round 2 has an immutable proposal plus an assisted response.
      kind         TEXT NOT NULL CHECK (kind IN ('self', 'vlm_proposal', 'assisted')),
      immutable    INTEGER NOT NULL DEFAULT 0 CHECK (immutable IN (0, 1)),
      status       TEXT CHECK (status IN ('draft', 'submitted')),
      created_at   INTEGER NOT NULL,
      updated_at   INTEGER,
      first_opened_at INTEGER,
      first_draft_saved_at INTEGER,
      last_draft_saved_at INTEGER,
      submitted_at INTEGER,
      proposal_viewed_at INTEGER,
      CHECK (
        (round = 1 AND kind = 'self')
        OR
        (round = 2 AND kind IN ('vlm_proposal', 'assisted'))
      ),
      CHECK (
        (kind = 'vlm_proposal' AND immutable = 1 AND status IS NULL
          AND first_opened_at IS NULL
          AND first_draft_saved_at IS NULL
          AND last_draft_saved_at IS NULL
          AND submitted_at IS NULL)
        OR
        (kind != 'vlm_proposal' AND immutable = 0 AND status IS NOT NULL
          AND proposal_viewed_at IS NULL)
      ),
      UNIQUE (participant, round, kind)
    )
  `;
    const activitiesSchema = `
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
    )
  `;
    const activityListsExist = tableExists("activity_lists");
    const activitiesExist = tableExists("activities");
    const parentIdColumn = activityListsExist
        ? db.prepare(`PRAGMA table_info(activity_lists)`).all().find((column) => column.name === "id")
        : undefined;
    const parentHasId = parentIdColumn?.pk === 1;
    const childHasForeignKey = activitiesExist && tableHasColumn("activities", "activity_list_id");
    const childHasParentForeignKey = childHasForeignKey &&
        db.prepare(`PRAGMA foreign_key_list(activities)`).all().some((foreignKey) => foreignKey.table === "activity_lists" &&
            foreignKey.from === "activity_list_id" &&
            foreignKey.to === "id" &&
            foreignKey.on_delete.toUpperCase() === "CASCADE");
    const childHasRedundantIdentity = activitiesExist &&
        (tableHasColumn("activities", "participant") ||
            tableHasColumn("activities", "round") ||
            tableHasColumn("activities", "list_kind"));
    const parentHasFinalWorkflow = activityListsExist &&
        [
            "status",
            "first_opened_at",
            "first_draft_saved_at",
            "last_draft_saved_at",
            "submitted_at",
            "proposal_viewed_at",
        ].every((column) => tableHasColumn("activity_lists", column)) &&
        !tableHasColumn("activity_lists", "mode");
    if (!activityListsExist && !activitiesExist && !reconstructionsExist) {
        db.exec(`${activityListsSchema}; ${activitiesSchema};`);
    }
    else if (reconstructionsExist ||
        !parentHasId ||
        !parentHasFinalWorkflow ||
        !childHasForeignKey ||
        !childHasParentForeignKey ||
        childHasRedundantIdentity) {
        // SQLite cannot add a primary key or foreign key with ALTER TABLE. Rebuild
        // both tables transactionally, preserving IDs where they already exist.
        // This handles, in one atomic migration:
        //   1. legacy activities keyed only by participant+round;
        //   2. the natural-key three-list implementation (activities.list_kind);
        //   3. the parent/child implementation plus reconstructions workflow;
        //   4. a partially upgraded parent/child schema.
        const parentHasUpdatedAt = activityListsExist && tableHasColumn("activity_lists", "updated_at");
        const parentHasStatus = activityListsExist && tableHasColumn("activity_lists", "status");
        const parentHasFirstOpened = activityListsExist && tableHasColumn("activity_lists", "first_opened_at");
        const parentHasFirstDraftSaved = activityListsExist &&
            tableHasColumn("activity_lists", "first_draft_saved_at");
        const parentHasLastDraftSaved = activityListsExist &&
            tableHasColumn("activity_lists", "last_draft_saved_at");
        const parentHasSubmitted = activityListsExist && tableHasColumn("activity_lists", "submitted_at");
        const parentHasProposalViewedAt = activityListsExist &&
            tableHasColumn("activity_lists", "proposal_viewed_at");
        const reconstructionHasFirstOpened = reconstructionsExist &&
            tableHasColumn("reconstructions", "first_opened_at");
        const reconstructionHasFirstDraftSaved = reconstructionsExist &&
            tableHasColumn("reconstructions", "first_draft_saved_at");
        const reconstructionHasLastDraftSaved = reconstructionsExist &&
            tableHasColumn("reconstructions", "last_draft_saved_at");
        const childHasListKind = activitiesExist && tableHasColumn("activities", "list_kind");
        const childHasWorkload = activitiesExist && tableHasColumn("activities", "workload_rating");
        const childHasRecovery = activitiesExist && tableHasColumn("activities", "recovery_rating");
        const childHasUpdatedAt = activitiesExist && tableHasColumn("activities", "updated_at");
        const legacyActivityCount = activitiesExist
            ? db.prepare(`SELECT COUNT(*) AS count FROM activities`).get().count
            : 0;
        if (activityListsExist) {
            const conflictingParents = db
                .prepare(`
          SELECT participant, round,
                 CASE WHEN round = 1 THEN 'self'
                      WHEN kind = 'vlm_proposal' THEN 'vlm_proposal'
                      ELSE 'assisted' END AS target_kind,
                 COUNT(*) AS count
          FROM activity_lists
          GROUP BY participant, round, target_kind
          HAVING COUNT(*) > 1
        `)
                .all();
            if (conflictingParents.length > 0) {
                const conflict = conflictingParents[0];
                throw new Error(`cannot merge ${conflict.count} activity lists into ` +
                    `${conflict.participant}/round ${conflict.round}/${conflict.target_kind}`);
            }
        }
        db.exec("BEGIN IMMEDIATE");
        try {
            db.exec(`
        DROP INDEX IF EXISTS idx_activities_round;
        DROP INDEX IF EXISTS idx_activities_list_position;
        DROP INDEX IF EXISTS idx_activities_parent;
        DROP INDEX IF EXISTS idx_activity_lists_day;
        DROP INDEX IF EXISTS idx_activity_lists_response;
      `);
            if (activityListsExist) {
                db.exec(`ALTER TABLE activity_lists RENAME TO activity_lists_legacy`);
            }
            if (activitiesExist) {
                db.exec(`ALTER TABLE activities RENAME TO activities_legacy`);
            }
            if (reconstructionsExist) {
                db.exec(`ALTER TABLE reconstructions RENAME TO reconstructions_legacy`);
            }
            db.exec(`${activityListsSchema}; ${activitiesSchema};`);
            if (activityListsExist) {
                const idColumn = parentHasId ? "id, " : "";
                const idValue = parentHasId ? "id, " : "";
                const updatedAtValue = parentHasUpdatedAt
                    ? "p.updated_at"
                    : "p.created_at";
                const kindValue = "CASE WHEN p.round = 1 THEN 'self' " +
                    "WHEN p.kind = 'vlm_proposal' THEN 'vlm_proposal' ELSE 'assisted' END";
                const reconstructionJoin = reconstructionsExist
                    ? `LEFT JOIN reconstructions_legacy r
               ON r.participant = p.participant AND r.round = p.round`
                    : "";
                const reconstructionStatus = reconstructionsExist
                    ? "r.status"
                    : "NULL";
                const statusValue = parentHasStatus
                    ? reconstructionsExist
                        ? "COALESCE(p.status, r.status)"
                        : "p.status"
                    : reconstructionStatus;
                const firstOpenedValue = parentHasFirstOpened
                    ? reconstructionHasFirstOpened
                        ? "COALESCE(p.first_opened_at, r.first_opened_at)"
                        : "p.first_opened_at"
                    : reconstructionHasFirstOpened
                        ? "r.first_opened_at"
                        : "NULL";
                const firstDraftSavedValue = parentHasFirstDraftSaved
                    ? reconstructionHasFirstDraftSaved
                        ? "COALESCE(p.first_draft_saved_at, r.first_draft_saved_at)"
                        : "p.first_draft_saved_at"
                    : reconstructionHasFirstDraftSaved
                        ? "r.first_draft_saved_at"
                        : "NULL";
                const lastDraftSavedValue = parentHasLastDraftSaved
                    ? reconstructionHasLastDraftSaved
                        ? "COALESCE(p.last_draft_saved_at, r.last_draft_saved_at)"
                        : "p.last_draft_saved_at"
                    : reconstructionHasLastDraftSaved
                        ? "r.last_draft_saved_at"
                        : "NULL";
                const submittedValue = parentHasSubmitted
                    ? reconstructionsExist
                        ? "COALESCE(p.submitted_at, r.submitted_at)"
                        : "p.submitted_at"
                    : reconstructionsExist
                        ? "r.submitted_at"
                        : "NULL";
                const proposalViewedAtValue = parentHasProposalViewedAt
                    ? "p.proposal_viewed_at"
                    : "NULL";
                db.exec(`
          INSERT INTO activity_lists (
            ${idColumn}participant, round, day, kind, immutable, status,
            created_at, updated_at, first_opened_at,
            first_draft_saved_at, last_draft_saved_at, submitted_at,
            proposal_viewed_at
          )
          SELECT ${idValue}p.participant, p.round, p.day, ${kindValue},
                 CASE WHEN ${kindValue} = 'vlm_proposal' THEN 1 ELSE 0 END,
                 CASE WHEN ${kindValue} = 'vlm_proposal' THEN NULL
                      ELSE COALESCE(${statusValue}, 'draft') END,
                 p.created_at, ${updatedAtValue},
                 CASE WHEN ${kindValue} = 'vlm_proposal' THEN NULL
                      ELSE ${firstOpenedValue} END,
                 CASE WHEN ${kindValue} = 'vlm_proposal' THEN NULL
                      ELSE ${firstDraftSavedValue} END,
                 CASE WHEN ${kindValue} = 'vlm_proposal' THEN NULL
                      ELSE ${lastDraftSavedValue} END,
                 CASE WHEN ${kindValue} = 'vlm_proposal' THEN NULL
                      ELSE ${submittedValue} END,
                 CASE WHEN ${kindValue} = 'vlm_proposal'
                      THEN ${proposalViewedAtValue} ELSE NULL END
          FROM activity_lists_legacy p
          ${reconstructionJoin}
        `);
            }
            if (reconstructionsExist) {
                const firstOpenedValue = reconstructionHasFirstOpened
                    ? "first_opened_at"
                    : "NULL";
                const firstDraftSavedValue = reconstructionHasFirstDraftSaved
                    ? "first_draft_saved_at"
                    : "NULL";
                const lastDraftSavedValue = reconstructionHasLastDraftSaved
                    ? "last_draft_saved_at"
                    : "NULL";
                // Every legacy reconstruction becomes its participant-facing response
                // list, including opened/submitted rounds with zero activity children.
                db.exec(`
          INSERT OR IGNORE INTO activity_lists (
            participant, round, day, kind, immutable, status,
            created_at, updated_at, first_opened_at,
            first_draft_saved_at, last_draft_saved_at, submitted_at,
            proposal_viewed_at
          )
          SELECT participant, round, day,
                 CASE WHEN round = 1 THEN 'self' ELSE 'assisted' END,
                 0, status, created_at, COALESCE(submitted_at, created_at),
                 ${firstOpenedValue}, ${firstDraftSavedValue},
                 ${lastDraftSavedValue}, submitted_at, NULL
          FROM reconstructions_legacy
          WHERE round IN (1, 2)
        `);
            }
            if (activitiesExist) {
                const workloadValue = childHasWorkload
                    ? "a.workload_rating"
                    : "NULL";
                const recoveryValue = childHasRecovery
                    ? "a.recovery_rating"
                    : "NULL";
                const updatedAtValue = childHasUpdatedAt ? "a.updated_at" : "a.created_at";
                let relationshipJoin;
                let activityListIdValue;
                if (childHasForeignKey) {
                    relationshipJoin = "";
                    activityListIdValue = "a.activity_list_id";
                }
                else if (childHasListKind) {
                    relationshipJoin = `
            JOIN activity_lists l
              ON l.participant = a.participant
             AND l.round = a.round
             AND l.kind = CASE
               WHEN a.round = 1 THEN 'self'
               WHEN a.list_kind = 'vlm_proposal' THEN 'vlm_proposal'
               ELSE 'assisted'
             END
          `;
                    activityListIdValue = "l.id";
                }
                else {
                    if (!reconstructionsExist) {
                        throw new Error("participant/round activities require legacy reconstruction metadata");
                    }
                    relationshipJoin = `
            JOIN reconstructions_legacy r
              ON r.participant = a.participant AND r.round = a.round
            JOIN activity_lists l
              ON l.participant = a.participant
             AND l.round = a.round
             AND l.kind = CASE WHEN a.round = 1 THEN 'self' ELSE 'assisted' END
          `;
                    activityListIdValue = "l.id";
                }
                db.exec(`
          INSERT INTO activities (
            id, activity_list_id, position, start_ms, end_ms,
            raw_label, category_label, source, vlm_raw_label, vlm_category,
            workload_rating, recovery_rating, created_at, updated_at
          )
          SELECT a.id, ${activityListIdValue}, a.position, a.start_ms, a.end_ms,
                 a.raw_label, a.category_label, a.source,
                 a.vlm_raw_label, a.vlm_category,
                 ${workloadValue}, ${recoveryValue},
                 a.created_at, ${updatedAtValue}
          FROM activities_legacy a
          ${relationshipJoin}
        `);
            }
            const migratedActivityCount = db.prepare(`SELECT COUNT(*) AS count FROM activities`).get().count;
            if (migratedActivityCount !== legacyActivityCount) {
                throw new Error(`activity-list migration preserved ${migratedActivityCount}/${legacyActivityCount} activities`);
            }
            if (reconstructionsExist) {
                const unmappedReconstructions = db.prepare(`
            SELECT COUNT(*) AS count
            FROM reconstructions_legacy r
            LEFT JOIN activity_lists l
              ON l.participant = r.participant
             AND l.round = r.round
             AND l.kind = CASE WHEN r.round = 1 THEN 'self' ELSE 'assisted' END
            WHERE l.id IS NULL
          `).get().count;
                if (unmappedReconstructions !== 0) {
                    throw new Error(`${unmappedReconstructions} reconstruction row(s) could not be migrated`);
                }
            }
            if (activitiesExist)
                db.exec(`DROP TABLE activities_legacy`);
            if (activityListsExist)
                db.exec(`DROP TABLE activity_lists_legacy`);
            if (reconstructionsExist)
                db.exec(`DROP TABLE reconstructions_legacy`);
            db.exec("COMMIT");
        }
        catch (error) {
            db.exec("ROLLBACK");
            throw error;
        }
    }
    db.exec(`
    CREATE INDEX IF NOT EXISTS idx_activities_parent
      ON activities (activity_list_id, position);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_activities_list_position
      ON activities (activity_list_id, position);
    CREATE INDEX IF NOT EXISTS idx_activity_lists_day
      ON activity_lists (participant, day, round, kind);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_activity_lists_response
      ON activity_lists (participant, round)
      WHERE kind != 'vlm_proposal';
  `);
    db.pragma("foreign_keys = ON");
    const foreignKeyViolations = db.pragma("foreign_key_check");
    if (foreignKeyViolations.length > 0) {
        throw new Error(`activity-list migration left ${foreignKeyViolations.length} foreign-key violation(s)`);
    }
    insertStmt = db.prepare(`
    INSERT INTO frames (
      participant, device, session, frame_index,
      capture_epoch_ms, received_epoch_ms, file_path,
      device_frame, byte_length, jpeg_ok, chunk_start_ms
    ) VALUES (
      @participant, @device, @session, @frame_index,
      @capture_epoch_ms, @received_epoch_ms, @file_path,
      @device_frame, @byte_length, @jpeg_ok, @chunk_start_ms
    )
  `);
    upsertChunkStmt = db.prepare(`
    INSERT INTO chunks (
      participant, chunk_start_ms, chunk_end_ms, frame_count,
      last_frame_received_ms, created_at, updated_at
    ) VALUES (
      @participant, @chunk_start_ms, @chunk_end_ms, 1, @received_ms, @now, @now
    )
    ON CONFLICT (participant, chunk_start_ms) DO UPDATE SET
      frame_count = frame_count + 1,
      last_frame_received_ms = excluded.last_frame_received_ms,
      updated_at = excluded.updated_at
  `);
    // Frames upload in capture order per participant (single camera, FIFO
    // queue), so the arrival of a frame for a LATER window proves every earlier
    // window can no longer grow: close them.
    closeEarlierChunksStmt = db.prepare(`
    UPDATE chunks SET status = 'ready', updated_at = @now
    WHERE participant = @participant AND status = 'filling'
      AND chunk_start_ms < @chunk_start_ms
  `);
    // Idle sweep (the day's LAST chunk never sees a later frame): close any
    // still-filling chunk whose newest frame arrived longer than the idle
    // window ago. Keyed on server receipt time so an offline phone's delayed
    // catch-up upload keeps its chunk open while frames are still streaming in.
    closeIdleChunksStmt = db.prepare(`
    UPDATE chunks SET status = 'ready', updated_at = @now
    WHERE status = 'filling' AND last_frame_received_ms < @cutoff_ms
  `);
    // The app's explicit End-session signal: every still-filling chunk of the
    // participant closes immediately (the idle sweep stays as the fallback).
    closeParticipantChunksStmt = db.prepare(`
    UPDATE chunks SET status = 'ready', updated_at = @now
    WHERE participant = @participant AND status = 'filling'
  `);
    chunksInRangeStmt = db.prepare(`
    SELECT c.chunk_start_ms, c.status, c.vlm_label, c.vlm_category,
           MIN(f.capture_epoch_ms) AS first_frame_ms,
           MAX(f.capture_epoch_ms) AS last_frame_ms,
           COUNT(f.capture_epoch_ms) AS served_frame_count
    FROM chunks c
    LEFT JOIN frames f
      ON f.participant = c.participant
     AND f.chunk_start_ms = c.chunk_start_ms
     AND f.face_status = 'done'
     AND f.deleted_at IS NULL
    WHERE c.participant = ? AND c.chunk_start_ms BETWEEN ? AND ?
    GROUP BY c.chunk_start_ms
    ORDER BY c.chunk_start_ms
  `);
    getFrameChunkStmt = db.prepare(`
    SELECT chunk_start_ms, deleted_at FROM frames
    WHERE participant = ? AND device = ? AND session = ? AND frame_index = ?
  `);
    decrementChunkStmt = db.prepare(`
    UPDATE chunks SET frame_count = frame_count - 1, updated_at = ?
    WHERE participant = ? AND chunk_start_ms = ?
  `);
    deleteEmptyChunkStmt = db.prepare(`
    DELETE FROM chunks
    WHERE participant = ? AND chunk_start_ms = ? AND frame_count <= 0
  `);
    exportStmt = db.prepare(`
    SELECT frame_index, capture_epoch_ms, received_epoch_ms, device_frame,
           byte_length, jpeg_ok, file_path
    FROM frames
    WHERE participant = @participant AND device = @device AND session = @session
      AND deleted_at IS NULL
    ORDER BY frame_index
  `);
    listSessionsStmt = db.prepare(`
    SELECT device, session,
           COALESCE(
             MIN(CASE WHEN deleted_at IS NULL THEN capture_epoch_ms END),
             MIN(capture_epoch_ms)
           ) AS started_at_ms,
           COALESCE(
             MAX(CASE WHEN deleted_at IS NULL THEN capture_epoch_ms END),
             MAX(capture_epoch_ms)
           ) AS ended_at_ms,
           COUNT(CASE WHEN deleted_at IS NULL THEN 1 END)     AS frame_count,
           COUNT(CASE WHEN deleted_at IS NOT NULL THEN 1 END) AS deleted_frame_count
    FROM frames
    WHERE participant = ?
    GROUP BY device, session
    ORDER BY started_at_ms DESC
  `);
    // Only anonymized frames are exposed: a frame still pending (or being
    // processed / failed) in the face-blur worker is withheld so an unblurred
    // face is never listed or served.
    listFramesStmt = db.prepare(`
    SELECT frame_index, capture_epoch_ms, file_path
    FROM frames
    WHERE participant = ? AND device = ? AND session = ?
      AND face_status = 'done'
      AND deleted_at IS NULL
    ORDER BY frame_index
  `);
    getFrameForDeletionStmt = db.prepare(`
    SELECT file_path, deleted_at FROM frames
    WHERE participant = ? AND device = ? AND session = ? AND frame_index = ?
  `);
    softDeleteFrameStmt = db.prepare(`
    UPDATE frames SET deleted_at = ?, file_path = ''
    WHERE participant = ? AND device = ? AND session = ? AND frame_index = ?
      AND deleted_at IS NULL
  `);
    maxFrameIndexStmt = db.prepare(`
    SELECT COALESCE(MAX(frame_index), 0) AS max_index FROM frames
    WHERE participant = ? AND device = ? AND session = ?
  `);
    frameStatusByPathStmt = db.prepare(`
    SELECT face_status FROM frames
    WHERE participant = ? AND file_path = ? AND deleted_at IS NULL
  `);
    // --- DRM statements --------------------------------------------------------
    getParticipantStmt = db.prepare(`
    SELECT username, occupation, work_description, wake_time, bed_time, arm,
           push_token, last_reminder_day, created_at, updated_at
    FROM participants WHERE username = ?
  `);
    insertParticipantStmt = db.prepare(`
    INSERT OR IGNORE INTO participants (username, created_at) VALUES (?, ?)
  `);
    updateProfileStmt = db.prepare(`
    UPDATE participants
    SET occupation = ?, work_description = ?, wake_time = ?, bed_time = ?,
        updated_at = ?
    WHERE username = ?
  `);
    updatePushTokenStmt = db.prepare(`
    UPDATE participants SET push_token = ?, updated_at = ? WHERE username = ?
  `);
    updateLastReminderDayStmt = db.prepare(`
    UPDATE participants SET last_reminder_day = ? WHERE username = ?
  `);
    listPushParticipantsStmt = db.prepare(`
    SELECT username, occupation, work_description, wake_time, bed_time, arm,
           push_token, last_reminder_day, created_at, updated_at
    FROM participants WHERE push_token IS NOT NULL
  `);
    frameDayStatsStmt = db.prepare(`
    SELECT f.capture_epoch_ms, f.face_status, c.status AS chunk_status
    FROM frames f
    LEFT JOIN chunks c
      ON c.participant = f.participant AND c.chunk_start_ms = f.chunk_start_ms
    WHERE f.participant = ? AND f.deleted_at IS NULL
    ORDER BY f.capture_epoch_ms
  `);
    // Frames inherit their chunk's VLM output; the label is only surfaced once
    // the chunk reached 'done' (mirrors the old per-frame vlm_status gate).
    framesInRangeStmt = db.prepare(`
    SELECT f.device, f.session, f.frame_index, f.capture_epoch_ms,
           f.file_path, f.face_status,
           c.status AS chunk_status,
           CASE WHEN c.status = 'done' THEN c.vlm_label    ELSE NULL END AS vlm_label,
           CASE WHEN c.status = 'done' THEN c.vlm_category ELSE NULL END AS vlm_category
    FROM frames f
    LEFT JOIN chunks c
      ON c.participant = f.participant AND c.chunk_start_ms = f.chunk_start_ms
    WHERE f.participant = ? AND f.capture_epoch_ms BETWEEN ? AND ?
      AND f.deleted_at IS NULL
    ORDER BY f.capture_epoch_ms
  `);
    // Photo management keeps soft-deleted rows visible as timestamped
    // tombstones. Only frames that completed face anonymization are included:
    // live rows may expose their image path, while deleted rows have file_path=''
    // and can therefore expose metadata only.
    photoFramesInRangeStmt = db.prepare(`
    SELECT device, session, frame_index, capture_epoch_ms, file_path, deleted_at
    FROM frames
    WHERE participant = ? AND capture_epoch_ms BETWEEN ? AND ?
      AND face_status = 'done'
    ORDER BY capture_epoch_ms, device, session, frame_index
  `);
    getRoundResponseListStmt = db.prepare(`
    SELECT id, participant, round, day, kind, immutable, status,
           created_at, updated_at, first_opened_at, first_draft_saved_at,
           last_draft_saved_at, submitted_at, proposal_viewed_at
    FROM activity_lists
    WHERE participant = ? AND round = ?
      AND kind = CASE WHEN round = 1 THEN 'self' ELSE 'assisted' END
  `);
    insertRoundResponseListStmt = db.prepare(`
    INSERT OR IGNORE INTO activity_lists (
      participant, round, day, kind, immutable, status,
      created_at, updated_at
    )
    VALUES (?, ?, ?, ?, 0, 'draft', ?, ?)
  `);
    markFirstOpenedStmt = db.prepare(`
    UPDATE activity_lists
    SET first_opened_at = COALESCE(first_opened_at, ?)
    WHERE participant = ? AND round = ? AND kind != 'vlm_proposal'
  `);
    markDraftSavedStmt = db.prepare(`
    UPDATE activity_lists
    SET first_draft_saved_at = COALESCE(first_draft_saved_at, ?),
        last_draft_saved_at = ?,
        updated_at = ?
    WHERE participant = ? AND round = ? AND kind != 'vlm_proposal'
  `);
    markSubmittedStmt = db.prepare(`
    UPDATE activity_lists
    SET status = 'submitted', submitted_at = ?, updated_at = ?
    WHERE participant = ? AND round = ? AND kind != 'vlm_proposal'
  `);
    listActivitiesStmt = db.prepare(`
    SELECT a.id, a.activity_list_id, a.position, a.start_ms, a.end_ms,
           a.raw_label, a.category_label, a.source,
           a.vlm_raw_label, a.vlm_category,
           a.workload_rating, a.recovery_rating
    FROM activities a
    JOIN activity_lists l ON l.id = a.activity_list_id
    WHERE l.participant = ? AND l.round = ? AND l.kind != 'vlm_proposal'
    ORDER BY a.position
  `);
    listActivitiesByKindStmt = db.prepare(`
    SELECT a.id, a.activity_list_id, a.position, a.start_ms, a.end_ms,
           a.raw_label, a.category_label, a.source,
           a.vlm_raw_label, a.vlm_category,
           a.workload_rating, a.recovery_rating
    FROM activities a
    JOIN activity_lists l ON l.id = a.activity_list_id
    WHERE l.participant = ? AND l.round = ? AND l.kind = ?
    ORDER BY a.position
  `);
    getActivityListStmt = db.prepare(`
    SELECT id, participant, round, day, kind, immutable, status,
           created_at, updated_at, first_opened_at, first_draft_saved_at,
           last_draft_saved_at, submitted_at, proposal_viewed_at
    FROM activity_lists
    WHERE participant = ? AND round = ? AND kind = ?
  `);
    listActivityListsForDayStmt = db.prepare(`
    SELECT id, participant, round, day, kind, immutable, status,
           created_at, updated_at, first_opened_at, first_draft_saved_at,
           last_draft_saved_at, submitted_at, proposal_viewed_at
    FROM activity_lists
    WHERE participant = ? AND day = ?
    ORDER BY round, CASE kind
      WHEN 'self' THEN 0
      WHEN 'vlm_proposal' THEN 1
      ELSE 2
    END
  `);
    upsertEditableActivityListStmt = db.prepare(`
    INSERT INTO activity_lists (
      participant, round, day, kind, immutable, status,
      created_at, updated_at
    ) VALUES (?, ?, ?, ?, 0, 'draft', ?, ?)
    ON CONFLICT (participant, round, kind) DO UPDATE SET
      updated_at = excluded.updated_at
    WHERE activity_lists.immutable = 0
    RETURNING id
  `);
    insertVlmProposalListStmt = db.prepare(`
    INSERT OR IGNORE INTO activity_lists (
      participant, round, day, kind, immutable, status,
      created_at, updated_at
    ) VALUES (?, ?, ?, 'vlm_proposal', 1, NULL, ?, ?)
  `);
    markVlmProposalViewedStmt = db.prepare(`
    UPDATE activity_lists
    SET proposal_viewed_at = COALESCE(proposal_viewed_at, ?)
    WHERE id = ? AND kind = 'vlm_proposal'
    RETURNING proposal_viewed_at
  `);
    listVlmSpanActivitiesStmt = db.prepare(`
    SELECT a.start_ms, a.end_ms, a.vlm_raw_label, a.vlm_category
    FROM activities a
    JOIN activity_lists l ON l.id = a.activity_list_id
    WHERE l.participant = ? AND l.round = ? AND l.kind = 'vlm_proposal'
  `);
    deleteActivitiesStmt = db.prepare(`
    DELETE FROM activities WHERE activity_list_id = ?
  `);
    insertActivityStmt = db.prepare(`
    INSERT INTO activities (
      activity_list_id, position, start_ms, end_ms,
      raw_label, category_label, source, vlm_raw_label, vlm_category,
      workload_rating, recovery_rating,
      created_at, updated_at
    ) VALUES (
      @activity_list_id, @position, @start_ms, @end_ms,
      @raw_label, @category_label, @source, @vlm_raw_label, @vlm_category,
      @workload_rating, @recovery_rating,
      @created_at, @updated_at
    )
  `);
    // Label-quality propagation (contract): a submitted activity stamps its
    // labels onto every CHUNK overlapping its time span. A chunk straddling two
    // activities is stamped by both; activities are written in position order,
    // so the later activity deterministically wins the boundary chunk.
    propagateCorrectionsStmt = db.prepare(`
    UPDATE chunks
    SET user_corrected_category_label = ?, user_corrected_activity_label = ?
    WHERE participant = ? AND chunk_start_ms < ? AND chunk_end_ms > ?
  `);
    // The original generated proposal is a write-once list. The metadata row's
    // primary key makes repeated generation a no-op, and this transaction is
    // the only code path that inserts vlm_proposal items.
    createVlmProposalTx = db.transaction((participant, round, day, activities, now) => {
        const inserted = insertVlmProposalListStmt.run(participant, round, day, now, now);
        if (inserted.changes === 0)
            return false;
        const proposalList = getActivityListStmt.get(participant, round, "vlm_proposal");
        if (proposalList === undefined) {
            throw new Error("created VLM proposal list could not be reloaded");
        }
        activities.forEach((activity, position) => {
            insertActivityStmt.run({
                activity_list_id: proposalList.id,
                position,
                start_ms: activity.start_ms,
                end_ms: activity.end_ms,
                raw_label: activity.raw_label,
                category_label: activity.category_label,
                source: "vlm",
                vlm_raw_label: activity.raw_label,
                vlm_category: activity.category_label,
                workload_rating: null,
                recovery_rating: null,
                created_at: now,
                updated_at: now,
            });
        });
        return true;
    });
    // Replace-all write for a round's EDITABLE activities. Draft saves and
    // submissions share it; submit additionally locks the round and — for the
    // ASSISTED round only — propagates the labels onto chunks, all atomically.
    // The immutable vlm_proposal list is never deleted or updated here.
    // Self rounds must never propagate: both rounds cover the same day, so a
    // self-round propagation would overwrite (or pre-empt) the assisted
    // round's chunk-level ground truth.
    replaceActivitiesTx = db.transaction((participant, round, day, activities, submit, recordDraftSave, now) => {
        const listKind = round === 1 ? "self" : "assisted";
        // Match against the immutable original proposal so unchanged spans keep
        // their vlm_* provenance even after any number of editable-list saves.
        const existingVlmRows = listVlmSpanActivitiesStmt.all(participant, round);
        const vlmBySpan = new Map(existingVlmRows.map((row) => [`${row.start_ms}|${row.end_ms}`, row]));
        const editableList = upsertEditableActivityListStmt.get(participant, round, day, listKind, now, now);
        if (editableList === undefined) {
            throw new Error(`could not create or update ${listKind} activity list`);
        }
        deleteActivitiesStmt.run(editableList.id);
        activities.forEach((activity, position) => {
            const matched = vlmBySpan.get(`${activity.start_ms}|${activity.end_ms}`);
            insertActivityStmt.run({
                activity_list_id: editableList.id,
                position,
                start_ms: activity.start_ms,
                end_ms: activity.end_ms,
                raw_label: activity.raw_label,
                category_label: activity.category_label,
                source: activity.source,
                vlm_raw_label: activity.vlm_raw_label ?? matched?.vlm_raw_label ?? null,
                vlm_category: activity.vlm_category ?? matched?.vlm_category ?? null,
                workload_rating: activity.workload_rating ?? null,
                recovery_rating: activity.recovery_rating ?? null,
                created_at: now,
                updated_at: now,
            });
        });
        if (recordDraftSave) {
            markDraftSavedStmt.run(now, now, now, participant, round);
        }
        if (!submit)
            return null;
        markSubmittedStmt.run(now, now, participant, round);
        if (round !== 2)
            return now;
        // Defense in depth: the API validates every span against the day, but
        // the propagation additionally clamps to the day's UTC range so a bug
        // upstream can never rewrite chunks outside the pinned study day.
        const { fromMs, toMs } = (0, time_1.dayUtcRange)(day);
        for (const activity of activities) {
            propagateCorrectionsStmt.run(activity.category_label, activity.raw_label, participant, Math.min(activity.end_ms, toMs), // chunk_start_ms < clamped end
            Math.max(activity.start_ms, fromMs));
        }
        return now;
    });
    // Ingest one frame atomically with its chunk bookkeeping: attach the frame
    // to its clock-aligned window, create/grow the chunk row, and close every
    // earlier still-filling chunk of this participant (frames arrive in capture
    // order, so an older window can no longer grow once a newer one starts).
    insertFrameTx = db.transaction((row) => {
        const chunkStart = chunkStartOf(row.capture_epoch_ms);
        const now = Date.now();
        insertStmt.run({ ...row, chunk_start_ms: chunkStart });
        upsertChunkStmt.run({
            participant: row.participant,
            chunk_start_ms: chunkStart,
            chunk_end_ms: chunkStart + exports.CHUNK_WINDOW_MS,
            received_ms: row.received_epoch_ms,
            now,
        });
        closeEarlierChunksStmt.run({
            participant: row.participant,
            chunk_start_ms: chunkStart,
            now,
        });
    });
    // GDPR per-frame soft delete keeps the audit row but removes it from every
    // active data path. Chunk bookkeeping still tracks only live imagery: the
    // count drops once, and a chunk left with no live frames disappears.
    softDeleteFrameTx = db.transaction((participant, device, session, frameIndex) => {
        const frame = getFrameChunkStmt.get(participant, device, session, frameIndex);
        if (!frame || frame.deleted_at !== null)
            return false;
        const deleted = softDeleteFrameStmt.run(Date.now(), participant, device, session, frameIndex).changes > 0;
        if (deleted && frame?.chunk_start_ms != null) {
            decrementChunkStmt.run(Date.now(), participant, frame.chunk_start_ms);
            deleteEmptyChunkStmt.run(participant, frame.chunk_start_ms);
        }
        return deleted;
    });
}
// Pins a round's response-list identity + study day on first open
// (INSERT OR IGNORE = no-op when a row already exists). Without pinning, the
// study day would keep deriving from the participant's latest frame day —
// mutable data: a new frame the next morning (or a frame deletion) could
// silently shift an already-seen round onto a different day.
function pinRoundResponseList(participant, round, day) {
    const now = Date.now();
    const kind = round === 1 ? "self" : "assisted";
    insertRoundResponseListStmt.run(participant, round, day, kind, now, now);
}
function listSessions(participant) {
    return listSessionsStmt.all(participant);
}
function listFrames(participant, device, session) {
    return listFramesStmt.all(participant, device, session);
}
function getFrameDeletionTarget(participant, device, session, frameIndex) {
    const row = getFrameForDeletionStmt.get(participant, device, session, frameIndex);
    return row
        ? { filePath: row.file_path, deletedAt: row.deleted_at }
        : undefined;
}
// Serving gate: returns the face anonymization status for a frame identified by
// its on-disk path, scoped to the owner. Used by /frames to refuse a frame
// whose face has not been blurred yet. Returns undefined if no such row.
function getFrameStatusByPath(participant, filePath) {
    const row = frameStatusByPathStmt.get(participant, filePath);
    return row?.face_status;
}
function softDeleteFrameRow(participant, device, session, frameIndex) {
    return softDeleteFrameTx(participant, device, session, frameIndex);
}
// Lets a reconnecting phone continue a session's frame numbering instead of
// colliding with rows already written under the same (participant, device,
// session) key.
function maxFrameIndex(participant, device, session) {
    const row = maxFrameIndexStmt.get(participant, device, session);
    return row.max_index;
}
function insertFrame(row) {
    insertFrameTx(row);
}
// Closes 'filling' chunks whose newest frame arrived more than idleMs ago
// (the tail of a session that no later window will ever close). Called from
// the server's periodic sweep. Returns how many chunks were closed.
function closeIdleChunks(idleMs) {
    const now = Date.now();
    return closeIdleChunksStmt.run({ now, cutoff_ms: now - idleMs }).changes;
}
// The app's End-session signal: the participant deliberately stopped
// recording, so no more frames are coming — every still-filling chunk goes to
// the VLM immediately instead of waiting for the idle sweep.
function closeFillingChunks(participant) {
    return closeParticipantChunksStmt.run({ participant, now: Date.now() })
        .changes;
}
// Every chunk of one local day with the real frame bounds of its servable
// frames, ordered by window start. Windows are clock-aligned, so a chunk
// never straddles the local-midnight day boundary.
function listChunksOnDay(participant, day) {
    const { fromMs, toMs } = (0, time_1.dayUtcRange)(day);
    const rows = chunksInRangeStmt.all(participant, fromMs, toMs);
    return rows.filter((row) => (0, time_1.dayKeyFromEpochMs)(row.chunk_start_ms) === day);
}
// --- DRM: participants -------------------------------------------------------
function getParticipant(username) {
    return getParticipantStmt.get(username);
}
// Creates the participants row if missing (condition_plan gets the schema
// default); never touches an existing row.
function ensureParticipant(username) {
    insertParticipantStmt.run(username, Date.now());
}
// Profile upsert: occupation, work description and the daily schedule —
// deliberately never touches the legacy arm column.
function upsertParticipantProfile(username, occupation, workDescription, wakeTime, bedTime) {
    ensureParticipant(username);
    updateProfileStmt.run(occupation, workDescription, wakeTime, bedTime, Date.now(), username);
}
function setPushToken(username, pushToken) {
    ensureParticipant(username);
    updatePushTokenStmt.run(pushToken, Date.now(), username);
}
function setLastReminderDay(username, day) {
    updateLastReminderDayStmt.run(day, username);
}
function listPushParticipants() {
    return listPushParticipantsStmt.all();
}
// --- DRM: day aggregation ----------------------------------------------------
// Distinct local study days (>=1 frame) for a participant, ascending by day,
// with frame + VLM-pending counts. Day keys are computed in the study TZ from
// capture_epoch_ms (SQLite has no timezone support, so bucketing happens here;
// a participant's whole study is a few thousand rows).
function aggregateFrameDays(participant) {
    const rows = frameDayStatsStmt.all(participant);
    const byDay = new Map();
    for (const row of rows) {
        const day = (0, time_1.dayKeyFromEpochMs)(row.capture_epoch_ms);
        let aggregate = byDay.get(day);
        if (!aggregate) {
            aggregate = { day, frameCount: 0, vlmPendingCount: 0 };
            byDay.set(day, aggregate);
        }
        aggregate.frameCount += 1;
        // Pending = the frame's chunk has not reached a terminal state. Legacy
        // frames without a chunk (NULL) are frozen, never pending. A
        // face_status='failed' frame can never contribute to a chunk's VLM input,
        // so it must not count as pending — otherwise one failed blur could keep
        // an assisted day in "still processing" forever.
        if (row.chunk_status !== null &&
            row.chunk_status !== "done" &&
            row.chunk_status !== "failed" &&
            row.face_status !== "failed") {
            aggregate.vlmPendingCount += 1;
        }
    }
    return Array.from(byDay.values()).sort((a, b) => (a.day < b.day ? -1 : 1));
}
// Every frame of one local day, ordered by capture time. A conservative UTC
// range narrows the indexed scan; the exact local-day filter happens here.
function listFramesOnDay(participant, day) {
    const { fromMs, toMs } = (0, time_1.dayUtcRange)(day);
    const rows = framesInRangeStmt.all(participant, fromMs, toMs);
    return rows.filter((row) => (0, time_1.dayKeyFromEpochMs)(row.capture_epoch_ms) === day);
}
// Every anonymized frame audit row on one local day, including soft-deleted
// tombstones in their original chronological position.
function listPhotoFramesOnDay(participant, day) {
    const { fromMs, toMs } = (0, time_1.dayUtcRange)(day);
    const rows = photoFramesInRangeStmt.all(participant, fromMs, toMs);
    return rows.filter((row) => (0, time_1.dayKeyFromEpochMs)(row.capture_epoch_ms) === day);
}
function countFramesOnDay(participant, day) {
    return listFramesOnDay(participant, day).length;
}
// The participant's most recent local date with >=1 frame — the candidate
// study day while no round is pinned yet (a Day-0 lab test run is superseded
// as soon as the real field day produces frames).
function latestFrameDay(participant) {
    const days = aggregateFrameDays(participant);
    return days.length > 0 ? days[days.length - 1].day : undefined;
}
// --- DRM: response lists + activity children --------------------------------
function getRoundResponseList(participant, round) {
    return getRoundResponseListStmt.get(participant, round);
}
// Records the first successful editor response once. Pinning and exposure are
// deliberately separate: the response-list row can exist before a response is
// successfully assembled.
function markRoundResponseOpened(participant, round) {
    markFirstOpenedStmt.run(Date.now(), participant, round);
}
// Atomically returns the stable first-view timestamp for the immutable
// proposal. The kind predicate prevents any editable/self list from being
// marked accidentally.
function markVlmProposalViewed(activityListId) {
    const row = markVlmProposalViewedStmt.get(Date.now(), activityListId);
    if (!row) {
        throw new Error("VLM proposal activity list not found");
    }
    return row.proposal_viewed_at;
}
function listActivities(participant, round) {
    return listActivitiesStmt.all(participant, round);
}
function getActivityList(participant, round, kind) {
    return getActivityListStmt.get(participant, round, kind);
}
function listActivitiesByKind(participant, round, kind) {
    return listActivitiesByKindStmt.all(participant, round, kind);
}
// Researcher-facing DB query helper: returns the explicitly identified lists
// for one participant/day. Round 1 self, immutable VLM proposal, and the
// editable/final assisted list remain distinguishable after submission.
function listStudyActivityLists(participant, day) {
    const lists = listActivityListsForDayStmt.all(participant, day);
    return lists.map((list) => ({
        ...list,
        activities: listActivitiesByKind(list.participant, list.round, list.kind),
    }));
}
// Stores the original generated VLM proposal exactly once. Returns false when
// the immutable proposal list already exists; existing items are never
// replaced, even if chunk labels are later reprocessed.
function createVlmProposal(options) {
    return createVlmProposalTx(options.participant, options.round, options.day, options.activities, Date.now());
}
// Atomic replace-all save of a round's activities (creates its response-list
// parent on first save). With submit=true also locks the round
// and — round 2 only — propagates each activity's labels onto the
// chunks in its span; returns the submitted_at timestamp (null for drafts).
function replaceActivities(options) {
    const submittedAt = replaceActivitiesTx(options.participant, options.round, options.day, options.activities, options.submit, options.recordDraftSave ?? false, Date.now());
    return { submittedAt };
}
// Reconstructs a per-session CSV from the DB on demand (the DB is the live
// index now). CaptureDatetime is intentionally dropped (derive it from
// capture_epoch_ms if needed). NO vlm_* columns: participant-facing output
// must never carry VLM labels (see ExportRow).
function exportFramesCsv(q) {
    const rows = exportStmt.all(q);
    const header = "FrameIndex;CaptureEpochMs;ReceivedEpochMs;DeviceFrame;ByteLength;JpegOk;FilePath";
    const lines = rows.map((r) => [
        r.frame_index,
        r.capture_epoch_ms,
        r.received_epoch_ms,
        r.device_frame ?? "",
        r.byte_length ?? "",
        r.jpeg_ok ?? "",
        r.file_path,
    ].join(";"));
    return [header, ...lines].join("\n") + "\n";
}
