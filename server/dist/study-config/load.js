"use strict";
// ===========================================================================
// Study config loader (documentation: docs/study-config-documentation.md).
//
// The config file path is chosen in this order (first match wins):
//   1. env BLINKS_STUDY_CONFIG (absolute, or relative to the working dir).
//      A missing file is fatal; the example file is refused in production
//      even when named explicitly.
//   2. <repo>/config/study.yaml (gitignored, the real study).
//   3. <repo>/config/study.example.yaml, only outside production. The loader
//      then prints a warning to stderr that placeholder survey links and PIN
//      are in use. In production a missing study.yaml is fatal.
//
// Validation: YAML -> zod shape -> cross-field checks. Any problem is fatal:
// every issue is printed as `path.to.field: reason` and the process exits 2.
// ===========================================================================
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.getStudyConfigSource = exports.getStudyConfig = exports.loadStudyConfigFile = exports.productionConfigIssues = exports.parseStudyConfig = exports.resolveStudyConfigPath = exports.isProduction = exports.StudyConfigError = exports.EXAMPLE_STUDY_CONFIG_PATH = exports.DEFAULT_STUDY_CONFIG_PATH = exports.REPO_ROOT = void 0;
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
        const usingExample = resolved === exports.EXAMPLE_STUDY_CONFIG_PATH;
        if (usingExample && (0, exports.isProduction)(env)) {
            throw new StudyConfigError(resolved, [
                {
                    path: "",
                    message: "the example config (placeholder surveys and PIN) is not allowed in production",
                },
            ]);
        }
        return { path: resolved, usingExample };
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
// --- production-only content rules ---------------------------------------------
// In production the placeholder PIN and the placeholder survey/payout links
// from study.example.yaml are refused, also under another file name. Same
// rule set in server/blinks_study_config.py and deploy/deploy.sh.
const PLACEHOLDER_HOST = /^(?:[a-z0-9-]+\.)*example\.(?:org|com)$/i;
const examplePin = () => {
    try {
        const raw = (0, yaml_1.parse)(fs_1.default.readFileSync(exports.EXAMPLE_STUDY_CONFIG_PATH, "utf8"));
        return typeof raw?.app?.studySettingsPin === "string" ? raw.app.studySettingsPin : null;
    }
    catch {
        return null;
    }
};
const isPlaceholderUrl = (value) => {
    try {
        return PLACEHOLDER_HOST.test(new URL(value).hostname);
    }
    catch {
        return false;
    }
};
/** Content rules that only apply in production (exit 2 like schema errors). */
const productionConfigIssues = (config) => {
    const issues = [];
    const pin = config.app.studySettingsPin;
    const placeholderPin = examplePin() ?? "0000";
    if (pin === placeholderPin) {
        issues.push({
            path: "app.studySettingsPin",
            message: "is the placeholder PIN from study.example.yaml; set a new PIN for this study",
        });
    }
    const links = [
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
exports.productionConfigIssues = productionConfigIssues;
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
        if ((0, exports.isProduction)()) {
            const issues = (0, exports.productionConfigIssues)(config);
            if (issues.length > 0)
                throw new StudyConfigError(resolved.path, issues);
        }
        cached = { config, ...resolved };
        if (resolved.usingExample) {
            console.warn("WARNING: using config/study.example.yaml (placeholder survey links " +
                "and PIN). Never run a study like this.");
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
