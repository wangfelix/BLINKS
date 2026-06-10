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
  created_at: number;
}

let db: Database.Database;

export function initAuthDb(dbPath: string): void {
  db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.pragma("synchronous = NORMAL");
  db.pragma("foreign_keys = ON");

  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      username      TEXT    PRIMARY KEY,
      password_hash TEXT    NOT NULL,
      created_at    INTEGER NOT NULL
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
}

export function insertUser(username: string, passwordHash: string): void {
  db.prepare(
    "INSERT INTO users (username, password_hash, created_at) VALUES (?, ?, ?)",
  ).run(username, passwordHash, Date.now());
}

export function getUser(username: string): UserRow | undefined {
  return db
    .prepare("SELECT username, password_hash, created_at FROM users WHERE username = ?")
    .get(username) as UserRow | undefined;
}

export function updatePasswordHash(
  username: string,
  passwordHash: string,
): void {
  db.prepare("UPDATE users SET password_hash = ? WHERE username = ?").run(
    passwordHash,
    username,
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
