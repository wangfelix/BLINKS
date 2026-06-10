"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.initAuthDb = initAuthDb;
exports.insertUser = insertUser;
exports.getUser = getUser;
exports.updatePasswordHash = updatePasswordHash;
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
function insertUser(username, passwordHash) {
    db.prepare("INSERT INTO users (username, password_hash, created_at) VALUES (?, ?, ?)").run(username, passwordHash, Date.now());
}
function getUser(username) {
    return db
        .prepare("SELECT username, password_hash, created_at FROM users WHERE username = ?")
        .get(username);
}
function updatePasswordHash(username, passwordHash) {
    db.prepare("UPDATE users SET password_hash = ? WHERE username = ?").run(passwordHash, username);
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
