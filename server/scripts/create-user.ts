import path from "path";
import fs from "fs";

import { hashPassword } from "../src/auth";
import { getUser, initAuthDb, insertUser, updatePasswordHash } from "../src/auth-db";
import {
  DEFAULT_CONDITION_PLAN,
  ensureParticipant,
  initDb,
  setConditionPlan,
} from "../src/db";

// Creates a study participant account (or resets a password with --reset) and
// provisions the matching participants row in recordings.db (occupation is
// entered by the participant in the app; the per-day DRM condition plan is
// set here, at provisioning, to counterbalance across participants).
// Participants are provisioned in the lab before phone handout; there is no
// self-signup. Run on the VM:
//
//   npm run create-user -- participant1 <password>
//   npm run create-user -- participant1 <password> --plan control,assisted,assisted,control
//   npm run create-user -- participant1 <new-password> --reset
//
// Default plan: control,control,assisted,assisted. --reset keeps the existing
// occupation and plan unless --plan is given explicitly.

const usage = (): never => {
  console.error(
    "Usage: npm run create-user -- <username> <password> [--reset] [--plan control,control,assisted,assisted]",
  );
  process.exit(1);
};

const parsePlan = (planCsv: string): string[] => {
  const tokens = planCsv
    .split(",")
    .map((token) => token.trim())
    .filter((token) => token.length > 0);
  if (
    tokens.length === 0 ||
    !tokens.every((token) => token === "control" || token === "assisted")
  ) {
    console.error(
      "--plan must be a comma-separated list of 'control'/'assisted', e.g. --plan control,control,assisted,assisted",
    );
    process.exit(1);
  }
  return tokens;
};

const main = async (): Promise<void> => {
  const positional: string[] = [];
  let reset = false;
  let planCsv: string | undefined;

  const args = process.argv.slice(2);
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--reset") {
      reset = true;
    } else if (arg === "--plan") {
      planCsv = args[++i];
      if (planCsv === undefined) usage();
    } else if (arg.startsWith("--plan=")) {
      planCsv = arg.slice("--plan=".length);
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
  const plan = planCsv !== undefined ? parsePlan(planCsv) : undefined;

  const dataDir = process.env.DATA_DIR ?? path.join(__dirname, "..", "data");
  fs.mkdirSync(dataDir, { recursive: true });
  initAuthDb(process.env.AUTH_DB_PATH ?? path.join(dataDir, "auth.db"));

  // The participants row (condition plan, occupation, push token) lives in
  // recordings.db next to the frames, not in the auth DB.
  const recordingsDir =
    process.env.RECORDINGS_DIR ?? path.join(__dirname, "..", "recordings");
  fs.mkdirSync(recordingsDir, { recursive: true });
  initDb(path.join(recordingsDir, "recordings.db"));

  const existing = getUser(username);
  const passwordHash = await hashPassword(password);

  if (existing && reset) {
    updatePasswordHash(username, passwordHash);
    // Never wipe occupation or the plan on a password reset; --plan updates
    // the plan explicitly.
    ensureParticipant(username);
    if (plan) setConditionPlan(username, JSON.stringify(plan));
    console.log(
      `Password reset for '${username}'.${plan ? ` Condition plan set to [${plan.join(", ")}].` : ""}`,
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
  if (plan) setConditionPlan(username, JSON.stringify(plan));
  console.log(
    `Created user '${username}' with condition plan [${(plan ?? DEFAULT_CONDITION_PLAN).join(", ")}].`,
  );
};

void main();
