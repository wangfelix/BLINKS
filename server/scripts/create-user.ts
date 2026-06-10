import path from "path";
import fs from "fs";

import { hashPassword } from "../src/auth";
import { getUser, initAuthDb, insertUser, updatePasswordHash } from "../src/auth-db";

// Creates a study participant account (or resets a password with --reset).
// Participants are provisioned in the lab before phone handout; there is no
// self-signup. Run on the VM:
//
//   npm run create-user -- participant1 <password>
//   npm run create-user -- participant1 <new-password> --reset

const main = async (): Promise<void> => {
  const [username, password, flag] = process.argv.slice(2);
  if (!username || !password) {
    console.error("Usage: npm run create-user -- <username> <password> [--reset]");
    process.exit(1);
  }
  if (!/^[a-zA-Z0-9_-]+$/.test(username)) {
    console.error(
      "Username may only contain letters, digits, '-' and '_' (it becomes the recordings directory name).",
    );
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

  if (existing && flag === "--reset") {
    updatePasswordHash(username, passwordHash);
    console.log(`Password reset for '${username}'.`);
    return;
  }
  if (existing) {
    console.error(`User '${username}' already exists (use --reset to change the password).`);
    process.exit(1);
  }
  insertUser(username, passwordHash);
  console.log(`Created user '${username}'.`);
};

void main();
