"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.initAuthDb = initAuthDb;
exports.insertUser = insertUser;
exports.getUser = getUser;
exports.markPasswordChanged = markPasswordChanged;
exports.resetPassword = resetPassword;
exports.completeOnboarding = completeOnboarding;
exports.resetOnboarding = resetOnboarding;
exports.completeStudy = completeStudy;
exports.isStudyComplete = isStudyComplete;
exports.isOnboardingComplete = isOnboardingComplete;
exports.insertToken = insertToken;
exports.getUsernameForTokenHash = getUsernameForTokenHash;
exports.deleteTokensForUser = deleteTokensForUser;
const better_sqlite3_1 = __importDefault(require("better-sqlite3"));
let db;
function initAuthDb(dbPath) {
    db = new better_sqlite3_1.default(dbPath);
    db.pragma("journal_mode = WAL");
    db.pragma("synchronous = NORMAL");
    db.pragma("foreign_keys = ON");
    const existingUserColumns = new Set(db.prepare("PRAGMA table_info(users)").all().map((column) => column.name));
    const hadUsersTable = existingUserColumns.size > 0;
    const hadMustChangePassword = existingUserColumns.has("must_change_password");
    const hadOnboardingCompletedAt = existingUserColumns.has("onboarding_completed_at");
    const hadStudyCompletedAt = existingUserColumns.has("study_completed_at");
    db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      username                TEXT    PRIMARY KEY,
      password_hash           TEXT    NOT NULL,
      must_change_password    INTEGER NOT NULL DEFAULT 1
                                      CHECK (must_change_password IN (0, 1)),
      onboarding_completed_at INTEGER,
      study_completed_at      INTEGER,
      created_at              INTEGER NOT NULL
    );
    -- Opaque bearer tokens, stored as sha256(token) so a leaked DB copy does
    -- not yield usable credentials. No expiry: the study runs 5 days on
    -- lab-provisioned phones; revocation = deleting the row.
    CREATE TABLE IF NOT EXISTS auth_tokens (
      token_hash   TEXT    PRIMARY KEY,
      username     TEXT    NOT NULL REFERENCES users(username) ON DELETE CASCADE,
      created_at   INTEGER NOT NULL,
      last_used_at INTEGER
    );
  `);
    // Existing accounts predate the first-run study flow. Preserve their access
    // during the additive migration; only accounts provisioned after this change
    // start with mandatory onboarding. A researcher can explicitly reset an
    // existing account with the reset-onboarding command.
    db.transaction(() => {
        if (hadUsersTable && !hadMustChangePassword) {
            db.exec(`
        ALTER TABLE users ADD COLUMN must_change_password INTEGER NOT NULL
          DEFAULT 0 CHECK (must_change_password IN (0, 1))
      `);
        }
        if (hadUsersTable && !hadOnboardingCompletedAt) {
            db.exec("ALTER TABLE users ADD COLUMN onboarding_completed_at INTEGER");
        }
        if (hadUsersTable && !hadStudyCompletedAt) {
            db.exec("ALTER TABLE users ADD COLUMN study_completed_at INTEGER");
        }
        if (hadUsersTable && (!hadMustChangePassword || !hadOnboardingCompletedAt)) {
            db.exec(`
        UPDATE users
        SET must_change_password = 0,
            onboarding_completed_at = COALESCE(onboarding_completed_at, created_at)
      `);
        }
    })();
}
function insertUser(username, passwordHash) {
    db.prepare(`INSERT INTO users
       (username, password_hash, must_change_password, onboarding_completed_at, study_completed_at, created_at)
     VALUES (?, ?, 1, NULL, NULL, ?)`).run(username, passwordHash, Date.now());
}
function getUser(username) {
    return db
        .prepare(`SELECT username, password_hash, must_change_password,
              onboarding_completed_at, study_completed_at, created_at
       FROM users WHERE username = ?`)
        .get(username);
}
function markPasswordChanged(username, passwordHash) {
    db.prepare(`UPDATE users
     SET password_hash = ?, must_change_password = 0
     WHERE username = ?`).run(passwordHash, username);
}
function resetPassword(username, passwordHash) {
    db.prepare(`UPDATE users
     SET password_hash = ?, must_change_password = 1
     WHERE username = ?`).run(passwordHash, username);
}
function completeOnboarding(username) {
    const result = db
        .prepare(`UPDATE users
       SET onboarding_completed_at = COALESCE(onboarding_completed_at, ?)
       WHERE username = ? AND must_change_password = 0`)
        .run(Date.now(), username);
    if (result.changes !== 1)
        return undefined;
    return getUser(username).onboarding_completed_at;
}
function resetOnboarding(username) {
    return (db
        .prepare(`UPDATE users
         SET must_change_password = 1, onboarding_completed_at = NULL,
             study_completed_at = NULL
         WHERE username = ?`)
        .run(username).changes === 1);
}
function completeStudy(username) {
    const result = db
        .prepare(`UPDATE users
       SET study_completed_at = COALESCE(study_completed_at, ?)
       WHERE username = ?`)
        .run(Date.now(), username);
    if (result.changes !== 1)
        return undefined;
    return getUser(username).study_completed_at;
}
function isStudyComplete(username) {
    const user = getUser(username);
    return user !== undefined && user.study_completed_at !== null;
}
function isOnboardingComplete(username) {
    const user = getUser(username);
    return (user !== undefined &&
        user.must_change_password === 0 &&
        user.onboarding_completed_at !== null);
}
function insertToken(tokenHash, username) {
    db.prepare("INSERT INTO auth_tokens (token_hash, username, created_at) VALUES (?, ?, ?)").run(tokenHash, username, Date.now());
}
function getUsernameForTokenHash(tokenHash) {
    const row = db
        .prepare("SELECT username FROM auth_tokens WHERE token_hash = ?")
        .get(tokenHash);
    if (row) {
        db.prepare("UPDATE auth_tokens SET last_used_at = ? WHERE token_hash = ?").run(Date.now(), tokenHash);
    }
    return row?.username;
}
function deleteTokensForUser(username) {
    return db
        .prepare("DELETE FROM auth_tokens WHERE username = ?")
        .run(username).changes;
}
