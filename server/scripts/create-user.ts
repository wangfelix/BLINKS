import path from "path";
import fs from "fs";

import { hashPassword } from "../src/auth";
import { getUser, initAuthDb, insertUser, resetPassword } from "../src/auth-db";
import { ensureParticipant, initDb } from "../src/db";

// Creates a study participant account (or resets a password with --reset) and
// provisions the matching participants row in recordings.db (occupation and
// the daily schedule are entered by the participant in the app). Every
// participant completes self round 1 followed by assisted round 2.
// Participants are provisioned in the lab before
// phone handout; there is no self-signup. Run on the VM:
//
//   npm run create-user -- participant1 <password>
//   npm run create-user -- participant1 <new-password> --reset

const usage = (): never => {
  console.error(
    "Usage: npm run create-user -- <username> <password> [--reset]",
  );
  process.exit(1);
};

const main = async (): Promise<void> => {
  const positional: string[] = [];
  let reset = false;

  const args = process.argv.slice(2);
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--reset") {
      reset = true;
    } else if (arg.startsWith("--")) {
      usage();
    } else {
      positional.push(arg);
    }
  }

  const [username, password] = positional;
  if (!username || !password || positional.length !== 2) usage();
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

  // The participants row (occupation, schedule, push token) lives in
  // recordings.db next to the frames, not in the auth DB.
  const recordingsDir =
    process.env.RECORDINGS_DIR ?? path.join(__dirname, "..", "recordings");
  fs.mkdirSync(recordingsDir, { recursive: true });
  initDb(path.join(recordingsDir, "recordings.db"));

  const existing = getUser(username);
  const passwordHash = await hashPassword(password);

  if (existing?.role === "admin") {
    console.error(
      `Account '${username}' is an administrator and was not changed.`,
    );
    process.exit(1);
  }

  if (existing && reset) {
    // A researcher-issued replacement password is temporary too. Require the
    // participant to choose their own password on their next web visit, but do
    // not repeat an already completed pre-study survey.
    resetPassword(username, passwordHash);
    // Never wipe occupation or schedule on a password reset.
    ensureParticipant(username);
    console.log(`Password reset for '${username}'.`);
    return;
  }
  if (existing) {
    console.error(
      `User '${username}' already exists (use --reset to change the password).`,
    );
    process.exit(1);
  }
  insertUser(username, passwordHash);
  ensureParticipant(username);
  console.log(`Created user '${username}'.`);
};

void main();
