// ===========================================================================
// Study config loader (BLINKS-tasks#4, contract: docs/study-config-contract.md).
//
// Resolution:
//   1. env BLINKS_STUDY_CONFIG (absolute, or relative to the working dir).
//      A missing file is always fatal; the example file is refused in
//      production even when named explicitly.
//   2. <repo>/config/study.yaml (gitignored, the real study).
//   3. <repo>/config/study.example.yaml, ONLY outside production and with a
//      loud warning (F1, decided 17.10.: production never falls back).
//
// Validation: YAML -> zod shape -> cross-field checks. Any problem is fatal:
// every issue is printed as `path.to.field: reason` and the process exits 2.
// There is deliberately no version, hash, or DB snapshot of the config.
// ===========================================================================

import crypto from "crypto";
import fs from "fs";
import path from "path";

import { parse as parseYaml } from "yaml";

import {
  StudyConfigSchema,
  studyConfigCrossCheckIssues,
  type StudyConfig,
  type StudyConfigIssue,
} from "./schema";

// server/src/study-config and server/dist/study-config are both 3 levels deep.
export const REPO_ROOT = path.resolve(__dirname, "..", "..", "..");
export const DEFAULT_STUDY_CONFIG_PATH = path.join(REPO_ROOT, "config", "study.yaml");
export const EXAMPLE_STUDY_CONFIG_PATH = path.join(
  REPO_ROOT,
  "config",
  "study.example.yaml",
);

export class StudyConfigError extends Error {
  constructor(
    readonly configPath: string,
    readonly issues: StudyConfigIssue[],
  ) {
    super(
      `invalid study config ${configPath}:\n` +
        issues.map((issue) => `  ${issue.path || "(root)"}: ${issue.message}`).join("\n"),
    );
  }
}

export const isProduction = (env: NodeJS.ProcessEnv = process.env): boolean =>
  env.NODE_ENV === "production";

export interface ResolvedConfigPath {
  path: string;
  usingExample: boolean;
}

export const resolveStudyConfigPath = (
  env: NodeJS.ProcessEnv = process.env,
  cwd: string = process.cwd(),
): ResolvedConfigPath => {
  const explicit = env.BLINKS_STUDY_CONFIG?.trim();
  if (explicit) {
    const resolved = path.resolve(cwd, explicit);
    if (!fs.existsSync(resolved)) {
      throw new StudyConfigError(resolved, [
        { path: "", message: "file not found (BLINKS_STUDY_CONFIG)" },
      ]);
    }
    const usingExample = resolved === EXAMPLE_STUDY_CONFIG_PATH;
    if (usingExample && isProduction(env)) {
      throw new StudyConfigError(resolved, [
        {
          path: "",
          message:
            "the example config (placeholder surveys and PIN) is not allowed in production",
        },
      ]);
    }
    return { path: resolved, usingExample };
  }
  if (fs.existsSync(DEFAULT_STUDY_CONFIG_PATH)) {
    return { path: DEFAULT_STUDY_CONFIG_PATH, usingExample: false };
  }
  if (isProduction(env)) {
    throw new StudyConfigError(DEFAULT_STUDY_CONFIG_PATH, [
      {
        path: "",
        message:
          "file not found. Production never falls back to study.example.yaml; " +
          "create config/study.yaml (see config/README.md)",
      },
    ]);
  }
  return { path: EXAMPLE_STUDY_CONFIG_PATH, usingExample: true };
};

/** Parse + validate one config document. Throws StudyConfigError. */
export const parseStudyConfig = (source: string, configPath: string): StudyConfig => {
  let raw: unknown;
  try {
    raw = parseYaml(source);
  } catch (err) {
    throw new StudyConfigError(configPath, [
      { path: "", message: `YAML syntax error: ${(err as Error).message}` },
    ]);
  }
  const parsed = StudyConfigSchema.safeParse(raw);
  if (!parsed.success) {
    throw new StudyConfigError(
      configPath,
      parsed.error.issues.map((issue) => ({
        path: issue.path.join("."),
        message: issue.message,
      })),
    );
  }
  const crossIssues = studyConfigCrossCheckIssues(parsed.data);
  if (crossIssues.length > 0) throw new StudyConfigError(configPath, crossIssues);
  return parsed.data;
};

// --- production-only content rules (review of PR #1, m2) -----------------------
// A 1:1 copy of study.example.yaml under another name must not run a study
// either (F1/F6): placeholder PIN or links, or the PIN used before the study
// config existed, are refused in production. The retired PIN is compared by
// SHA-256 so it is not written to the code again in clear text (it stays in
// the public git history, which is why it is retired). Same rule set in
// server/blinks_study_config.py and deploy/deploy.sh.
export const RETIRED_PIN_SHA256: readonly string[] = [
  "305800b71062b49b350208327a02ec378199b4cf35e60eeb971611bef4928394",
];
const PLACEHOLDER_HOST = /^(?:[a-z0-9-]+\.)*example\.(?:org|com)$/i;

const examplePin = (): string | null => {
  try {
    const raw = parseYaml(fs.readFileSync(EXAMPLE_STUDY_CONFIG_PATH, "utf8")) as {
      app?: { studySettingsPin?: unknown };
    };
    return typeof raw?.app?.studySettingsPin === "string" ? raw.app.studySettingsPin : null;
  } catch {
    return null;
  }
};

const isPlaceholderUrl = (value: string): boolean => {
  try {
    return PLACEHOLDER_HOST.test(new URL(value).hostname);
  } catch {
    return false;
  }
};

/** Content rules that only apply in production (exit 2 like schema errors). */
export const productionConfigIssues = (config: StudyConfig): StudyConfigIssue[] => {
  const issues: StudyConfigIssue[] = [];
  const pin = config.app.studySettingsPin;
  const placeholderPin = examplePin() ?? "0000";
  if (pin === placeholderPin) {
    issues.push({
      path: "app.studySettingsPin",
      message: "is the placeholder PIN from study.example.yaml; set a new PIN for this study",
    });
  }
  const pinHash = crypto.createHash("sha256").update(pin, "utf8").digest("hex");
  if (RETIRED_PIN_SHA256.includes(pinHash)) {
    issues.push({
      path: "app.studySettingsPin",
      message: "is a retired PIN (public in the git history); set a new PIN for this study",
    });
  }
  const links: [string, string | null | undefined][] = [
    ["surveys.onboarding.url", config.surveys.onboarding.url],
    ["surveys.final.url", config.surveys.final.url],
    ["surveys.payoutUrl", config.surveys.payoutUrl],
  ];
  for (const [field, url] of links) {
    if (typeof url === "string" && isPlaceholderUrl(url)) {
      issues.push({ path: field, message: "is a placeholder example.org/example.com link" });
    }
  }
  return issues;
};

export const loadStudyConfigFile = (configPath: string): StudyConfig =>
  parseStudyConfig(fs.readFileSync(configPath, "utf8"), configPath);

let cached: { config: StudyConfig; path: string; usingExample: boolean } | null =
  null;

/** Load (once per process) or exit 2 with a clear message. */
export const getStudyConfig = (): StudyConfig => {
  if (cached) return cached.config;
  try {
    const resolved = resolveStudyConfigPath();
    const config = loadStudyConfigFile(resolved.path);
    if (isProduction()) {
      const issues = productionConfigIssues(config);
      if (issues.length > 0) throw new StudyConfigError(resolved.path, issues);
    }
    cached = { config, ...resolved };
    if (resolved.usingExample) {
      console.warn(
        "WARNING: using config/study.example.yaml (placeholder survey links " +
          "and PIN). Never run a study like this.",
      );
    }
    return config;
  } catch (err) {
    if (err instanceof StudyConfigError) {
      console.error(`FATAL: ${err.message}`);
      process.exit(2);
    }
    throw err;
  }
};

export const getStudyConfigSource = (): { path: string; usingExample: boolean } => {
  getStudyConfig();
  return { path: cached!.path, usingExample: cached!.usingExample };
};
