import fs from "fs";
import path from "path";

import { hashPassword } from "../src/auth";
import {
  getUser,
  initAuthDb,
  insertAdmin,
  resetAdminPassword,
} from "../src/auth-db";

// Provisions a research administrator in auth.db only. Admin accounts are
// deliberately not participants and therefore have no recordings.db profile.
//
//   npm run create-admin -- researcher <password>
//   npm run create-admin -- researcher <new-password> --reset

const usage = (): never => {
  console.error(
    "Usage: npm run create-admin -- <username> <password> [--reset]",
  );
  process.exit(1);
};

const main = async (): Promise<void> => {
  const positional: string[] = [];
  let reset = false;

  for (const arg of process.argv.slice(2)) {
    if (arg === "--reset") reset = true;
    else if (arg.startsWith("--")) usage();
    else positional.push(arg);
  }

  const [username, password] = positional;
  if (!username || !password || positional.length !== 2) usage();
  if (!/^[a-zA-Z0-9_-]+$/.test(username)) {
    console.error("Username may only contain letters, digits, '-' and '_'.");
    process.exit(1);
  }
  if (password.length < 8) {
    console.error("Password needs at least 8 characters.");
    process.exit(1);
  }

  const dataDir = process.env.DATA_DIR ?? path.join(__dirname, "..", "data");
  fs.mkdirSync(dataDir, { recursive: true });
  initAuthDb(process.env.AUTH_DB_PATH ?? path.join(dataDir, "auth.db"));

  const existing = getUser(username);
  const passwordHash = await hashPassword(password);

  if (existing) {
    if (existing.role !== "admin") {
      console.error(
        `Account '${username}' already exists as a participant and was not changed.`,
      );
      process.exit(1);
    }
    if (!reset) {
      console.error(
        `Admin '${username}' already exists (use --reset to change the password).`,
      );
      process.exit(1);
    }
    resetAdminPassword(username, passwordHash);
    console.log(
      `Password reset and active sessions revoked for admin '${username}'.`,
    );
    return;
  }

  if (reset) {
    console.error(`Admin '${username}' does not exist.`);
    process.exit(1);
  }
  insertAdmin(username, passwordHash);
  console.log(`Created admin '${username}'.`);
};

void main();
