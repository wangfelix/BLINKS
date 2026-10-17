"use strict";
// ===========================================================================
// Study config loader (BLINKS-tasks#4, contract: docs/study-config-contract.md).
//
// Resolution:
//   1. env BLINKS_STUDY_CONFIG (absolute, or relative to the working dir).
//      A missing file is always fatal.
//   2. <repo>/config/study.yaml (gitignored, the real study).
//   3. <repo>/config/study.example.yaml, ONLY outside production and with a
//      loud warning (F1, decided 17.10.: production never falls back).
//
// Validation: YAML -> zod shape -> cross-field checks. Any problem is fatal:
// every issue is printed as `path.to.field: reason` and the process exits 2.
// There is deliberately no version, hash, or DB snapshot of the config.
// ===========================================================================
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.getStudyConfigSource = exports.getStudyConfig = exports.loadStudyConfigFile = exports.parseStudyConfig = exports.resolveStudyConfigPath = exports.isProduction = exports.StudyConfigError = exports.EXAMPLE_STUDY_CONFIG_PATH = exports.DEFAULT_STUDY_CONFIG_PATH = exports.REPO_ROOT = void 0;
const fs_1 = __importDefault(require("fs"));
const path_1 = __importDefault(require("path"));
const yaml_1 = require("yaml");
const schema_1 = require("./schema");
// server/src/study-config and server/dist/study-config are both 3 levels deep.
exports.REPO_ROOT = path_1.default.resolve(__dirname, "..", "..", "..");
exports.DEFAULT_STUDY_CONFIG_PATH = path_1.default.join(exports.REPO_ROOT, "config", "study.yaml");
exports.EXAMPLE_STUDY_CONFIG_PATH = path_1.default.join(exports.REPO_ROOT, "config", "study.example.yaml");
class StudyConfigError extends Error {
    constructor(configPath, issues) {
        super(`invalid study config ${configPath}:\n` +
            issues.map((issue) => `  ${issue.path || "(root)"}: ${issue.message}`).join("\n"));
        this.configPath = configPath;
        this.issues = issues;
    }
}
exports.StudyConfigError = StudyConfigError;
const isProduction = (env = process.env) => env.NODE_ENV === "production";
exports.isProduction = isProduction;
const resolveStudyConfigPath = (env = process.env, cwd = process.cwd()) => {
    const explicit = env.BLINKS_STUDY_CONFIG?.trim();
    if (explicit) {
        const resolved = path_1.default.resolve(cwd, explicit);
        if (!fs_1.default.existsSync(resolved)) {
            throw new StudyConfigError(resolved, [
                { path: "", message: "file not found (BLINKS_STUDY_CONFIG)" },
            ]);
        }
        return { path: resolved, usingExample: false };
    }
    if (fs_1.default.existsSync(exports.DEFAULT_STUDY_CONFIG_PATH)) {
        return { path: exports.DEFAULT_STUDY_CONFIG_PATH, usingExample: false };
    }
    if ((0, exports.isProduction)(env)) {
        throw new StudyConfigError(exports.DEFAULT_STUDY_CONFIG_PATH, [
            {
                path: "",
                message: "file not found. Production never falls back to study.example.yaml; " +
                    "create config/study.yaml (see config/README.md)",
            },
        ]);
    }
    return { path: exports.EXAMPLE_STUDY_CONFIG_PATH, usingExample: true };
};
exports.resolveStudyConfigPath = resolveStudyConfigPath;
/** Parse + validate one config document. Throws StudyConfigError. */
const parseStudyConfig = (source, configPath) => {
    let raw;
    try {
        raw = (0, yaml_1.parse)(source);
    }
    catch (err) {
        throw new StudyConfigError(configPath, [
            { path: "", message: `YAML syntax error: ${err.message}` },
        ]);
    }
    const parsed = schema_1.StudyConfigSchema.safeParse(raw);
    if (!parsed.success) {
        throw new StudyConfigError(configPath, parsed.error.issues.map((issue) => ({
            path: issue.path.join("."),
            message: issue.message,
        })));
    }
    const crossIssues = (0, schema_1.studyConfigCrossCheckIssues)(parsed.data);
    if (crossIssues.length > 0)
        throw new StudyConfigError(configPath, crossIssues);
    return parsed.data;
};
exports.parseStudyConfig = parseStudyConfig;
const loadStudyConfigFile = (configPath) => (0, exports.parseStudyConfig)(fs_1.default.readFileSync(configPath, "utf8"), configPath);
exports.loadStudyConfigFile = loadStudyConfigFile;
let cached = null;
/** Load (once per process) or exit 2 with a clear message. */
const getStudyConfig = () => {
    if (cached)
        return cached.config;
    try {
        const resolved = (0, exports.resolveStudyConfigPath)();
        const config = (0, exports.loadStudyConfigFile)(resolved.path);
        cached = { config, ...resolved };
        if (resolved.usingExample) {
            console.warn("WARNING: config/study.yaml not found, using config/study.example.yaml " +
                "(placeholder survey links and PIN). Never run a study like this.");
        }
        return config;
    }
    catch (err) {
        if (err instanceof StudyConfigError) {
            console.error(`FATAL: ${err.message}`);
            process.exit(2);
        }
        throw err;
    }
};
exports.getStudyConfig = getStudyConfig;
const getStudyConfigSource = () => {
    (0, exports.getStudyConfig)();
    return { path: cached.path, usingExample: cached.usingExample };
};
exports.getStudyConfigSource = getStudyConfigSource;
