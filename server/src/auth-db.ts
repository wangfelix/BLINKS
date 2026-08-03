import Database from "better-sqlite3";

// ===========================================================================
// Auth store (data/auth.db) — deliberately SEPARATE from recordings.db.
//
// recordings.db lives inside recordings/, the tree that gets rsynced for
// backup and shared for analysis; keeping credentials (password hashes,
// token hashes) in their own database outside that tree means no research-data
// copy ever carries auth material.
//
// One user = one study participant; the username IS the participant id used
// throughout the frame store and the recordings/ directory layout.
// ===========================================================================

export interface UserRow {
  username: string;
  password_hash: string;
  must_change_password: number;
  onboarding_completed_at: number | null;
  study_completed_at: number | null;
  created_at: number;
}

let db: Database.Database;

export function initAuthDb(dbPath: string): void {
  db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.pragma("synchronous = NORMAL");
  db.pragma("foreign_keys = ON");

  const existingUserColumns = new Set(
    (db.prepare("PRAGMA table_info(users)").all() as { name: string }[]).map(
      (column) => column.name,
    ),
  );
  const hadUsersTable = existingUserColumns.size > 0;
  const hadMustChangePassword = existingUserColumns.has("must_change_password");
  const hadOnboardingCompletedAt = existingUserColumns.has(
    "onboarding_completed_at",
  );
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

export function insertUser(username: string, passwordHash: string): void {
  db.prepare(
    `INSERT INTO users
       (username, password_hash, must_change_password, onboarding_completed_at, study_completed_at, created_at)
     VALUES (?, ?, 1, NULL, NULL, ?)`,
  ).run(username, passwordHash, Date.now());
}

export function getUser(username: string): UserRow | undefined {
  return db
    .prepare(
      `SELECT username, password_hash, must_change_password,
              onboarding_completed_at, study_completed_at, created_at
       FROM users WHERE username = ?`,
    )
    .get(username) as UserRow | undefined;
}

export function markPasswordChanged(
  username: string,
  passwordHash: string,
): void {
  db.prepare(
    `UPDATE users
     SET password_hash = ?, must_change_password = 0
     WHERE username = ?`,
  ).run(passwordHash, username);
}

export function resetPassword(username: string, passwordHash: string): void {
  db.prepare(
    `UPDATE users
     SET password_hash = ?, must_change_password = 1
     WHERE username = ?`,
  ).run(passwordHash, username);
}

export function completeOnboarding(username: string): number | undefined {
  const result = db
    .prepare(
      `UPDATE users
       SET onboarding_completed_at = COALESCE(onboarding_completed_at, ?)
       WHERE username = ? AND must_change_password = 0`,
    )
    .run(Date.now(), username);
  if (result.changes !== 1) return undefined;
  return getUser(username)!.onboarding_completed_at!;
}

export function resetOnboarding(username: string): boolean {
  return (
    db
      .prepare(
        `UPDATE users
         SET must_change_password = 1, onboarding_completed_at = NULL,
             study_completed_at = NULL
         WHERE username = ?`,
      )
      .run(username).changes === 1
  );
}

export function completeStudy(username: string): number | undefined {
  const result = db
    .prepare(
      `UPDATE users
       SET study_completed_at = COALESCE(study_completed_at, ?)
       WHERE username = ?`,
    )
    .run(Date.now(), username);
  if (result.changes !== 1) return undefined;
  return getUser(username)!.study_completed_at!;
}

export function isStudyComplete(username: string): boolean {
  const user = getUser(username);
  return user !== undefined && user.study_completed_at !== null;
}

export function isOnboardingComplete(username: string): boolean {
  const user = getUser(username);
  return (
    user !== undefined &&
    user.must_change_password === 0 &&
    user.onboarding_completed_at !== null
  );
}

export function insertToken(tokenHash: string, username: string): void {
  db.prepare(
    "INSERT INTO auth_tokens (token_hash, username, created_at) VALUES (?, ?, ?)",
  ).run(tokenHash, username, Date.now());
}

export function getUsernameForTokenHash(
  tokenHash: string,
): string | undefined {
  const row = db
    .prepare("SELECT username FROM auth_tokens WHERE token_hash = ?")
    .get(tokenHash) as { username: string } | undefined;
  if (row) {
    db.prepare("UPDATE auth_tokens SET last_used_at = ? WHERE token_hash = ?").run(
      Date.now(),
      tokenHash,
    );
  }
  return row?.username;
}

export function deleteTokensForUser(username: string): number {
  return db
    .prepare("DELETE FROM auth_tokens WHERE username = ?")
    .run(username).changes;
}
