import assert from "assert";
import fs from "fs";
import os from "os";
import path from "path";
import Database from "better-sqlite3";

import {
  completeOnboarding,
  getUser,
  initAuthDb,
  insertUser,
  isOnboardingComplete,
  markPasswordChanged,
  resetOnboarding,
  resetPassword,
} from "../src/auth-db";

const tempDir = fs.mkdtempSync(
  path.join(os.tmpdir(), "blinks-auth-onboarding-"),
);
const authDbPath = path.join(tempDir, "auth.db");

try {
  // Stand in for a database created before first-run onboarding existed.
  const legacyDb = new Database(authDbPath);
  legacyDb.exec(`
    CREATE TABLE users (
      username TEXT PRIMARY KEY,
      password_hash TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE auth_tokens (
      token_hash TEXT PRIMARY KEY,
      username TEXT NOT NULL REFERENCES users(username) ON DELETE CASCADE,
      created_at INTEGER NOT NULL,
      last_used_at INTEGER
    );
    INSERT INTO users (username, password_hash, created_at)
    VALUES ('legacy', 'legacy-hash', 1234);
  `);
  legacyDb.close();

  initAuthDb(authDbPath);

  const legacyUser = getUser("legacy");
  assert.ok(legacyUser);
  assert.strictEqual(legacyUser.must_change_password, 0);
  assert.strictEqual(legacyUser.onboarding_completed_at, 1234);
  assert.strictEqual(isOnboardingComplete("legacy"), true);

  insertUser("new-user", "initial-hash");
  let newUser = getUser("new-user")!;
  assert.strictEqual(newUser.must_change_password, 1);
  assert.strictEqual(newUser.onboarding_completed_at, null);
  assert.strictEqual(isOnboardingComplete("new-user"), false);
  assert.strictEqual(completeOnboarding("new-user"), undefined);

  markPasswordChanged("new-user", "private-hash");
  newUser = getUser("new-user")!;
  assert.strictEqual(newUser.must_change_password, 0);
  assert.strictEqual(newUser.onboarding_completed_at, null);
  assert.ok(completeOnboarding("new-user") !== undefined);
  assert.strictEqual(isOnboardingComplete("new-user"), true);

  const completedAt = getUser("new-user")!.onboarding_completed_at;
  resetPassword("new-user", "replacement-hash");
  newUser = getUser("new-user")!;
  assert.strictEqual(newUser.must_change_password, 1);
  assert.strictEqual(newUser.onboarding_completed_at, completedAt);
  markPasswordChanged("new-user", "replacement-private-hash");
  assert.strictEqual(isOnboardingComplete("new-user"), true);

  assert.strictEqual(resetOnboarding("new-user"), true);
  newUser = getUser("new-user")!;
  assert.strictEqual(newUser.must_change_password, 1);
  assert.strictEqual(newUser.onboarding_completed_at, null);
  assert.strictEqual(resetOnboarding("missing-user"), false);

  console.log("Auth onboarding migration/state tests passed.");
} finally {
  fs.rmSync(tempDir, { recursive: true, force: true });
}
