import path from "path";
import fs from "fs";

import { hashPassword } from "../src/auth";
import { getUser, initAuthDb, insertUser, updatePasswordHash } from "../src/auth-db";
import {
  StudyArm,
  ensureParticipant,
  initDb,
  setArm,
} from "../src/db";

// Creates a study participant account (or resets a password with --reset) and
// provisions the matching participants row in recordings.db (occupation and
// the daily schedule are entered by the participant in the app; the study ARM
// is set here, at provisioning: main = round 2 is VLM-assisted, control =
// round 2 is self again). Participants are provisioned in the lab before
// phone handout; there is no self-signup. Run on the VM:
//
//   npm run create-user -- participant1 <password>                # main arm
//   npm run create-user -- participant7 <password> --arm control  # control arm
//   npm run create-user -- participant1 <new-password> --reset
//
// --reset keeps the existing arm unless --arm is given explicitly. The arm
// can be changed until the participant first opens round 2 (its mode is
// pinned then); after that, fix it directly in the DB if ever needed.

const usage = (): never => {
  console.error(
    "Usage: npm run create-user -- <username> <password> [--reset] [--arm main|control]",
  );
  process.exit(1);
};

const parseArmFlag = (value: string): StudyArm => {
  if (value !== "main" && value !== "control") {
    console.error("--arm must be 'main' or 'control'");
    process.exit(1);
  }
  return value;
};

const main = async (): Promise<void> => {
  const positional: string[] = [];
  let reset = false;
  let arm: StudyArm | undefined;

  const args = process.argv.slice(2);
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--reset") {
      reset = true;
    } else if (arg === "--arm") {
      const value = args[++i];
      if (value === undefined) usage();
      arm = parseArmFlag(value);
    } else if (arg.startsWith("--arm=")) {
      arm = parseArmFlag(arg.slice("--arm=".length));
    } else {
      positional.push(arg);
    }
  }

  const [username, password] = positional;
  if (!username || !password) usage();
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

  // The participants row (arm, occupation, schedule, push token) lives in
  // recordings.db next to the frames, not in the auth DB.
  const recordingsDir =
    process.env.RECORDINGS_DIR ?? path.join(__dirname, "..", "recordings");
  fs.mkdirSync(recordingsDir, { recursive: true });
  initDb(path.join(recordingsDir, "recordings.db"));

  const existing = getUser(username);
  const passwordHash = await hashPassword(password);

  if (existing && reset) {
    updatePasswordHash(username, passwordHash);
    // Never wipe occupation/schedule or the arm on a password reset; --arm
    // updates the arm explicitly.
    ensureParticipant(username);
    if (arm) setArm(username, arm);
    console.log(
      `Password reset for '${username}'.${arm ? ` Arm set to '${arm}'.` : ""}`,
    );
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
  if (arm) setArm(username, arm);
  console.log(`Created user '${username}' in the '${arm ?? "main"}' arm.`);
};

void main();
