import fs from "fs";
import path from "path";

import { initAuthDb, resetOnboarding } from "../src/auth-db";

const username = process.argv[2];
if (!username || process.argv.length !== 3) {
  console.error("Usage: npm run reset-onboarding -- <username>");
  process.exit(1);
}
if (!/^[a-zA-Z0-9_-]+$/.test(username)) {
  console.error("Username may only contain letters, digits, '-' and '_'.");
  process.exit(1);
}

const dataDir = process.env.DATA_DIR ?? path.join(__dirname, "..", "data");
fs.mkdirSync(dataDir, { recursive: true });
initAuthDb(process.env.AUTH_DB_PATH ?? path.join(dataDir, "auth.db"));

if (!resetOnboarding(username)) {
  console.error(`User '${username}' does not exist.`);
  process.exit(1);
}

console.log(
  `Onboarding reset for '${username}'. Their next web sign-in starts at the password step.`,
);
