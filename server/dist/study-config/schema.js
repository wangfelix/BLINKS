"use strict";
// ===========================================================================
// Study configuration schema (WP0 draft, BLINKS-tasks#3/#4).
//
// SINGLE SOURCE OF TRUTH for the shape of config/study.yaml. The JSON Schema
// consumed by the Python workers (config/study-config.schema.json) is
// GENERATED from this file:  npm run generate-study-config-schema
// and checked for freshness by scripts/test-study-config-schema.ts.
//
// Two validation layers:
//   1. Shape (this zod object -> also expressible as JSON Schema, so the
//      Python workers validate the same shape with `jsonschema`).
//   2. Cross-field checks (`studyConfigCrossCheckIssues` below). These are
//      NOT representable in JSON Schema; the Python workers re-implement the
//      subset they depend on (see docs/study-config-contract.md, section 2).
//
// Deliberately NOT part of the design (decision Felix): no config version,
// no hash, no DB snapshot. Values come from the file and are validated at
// start-up; an invalid file stops the process with `path.to.field: reason`.
//
// Infrastructure stays in env vars (ports, paths, API key, base URL,
// WEB_URL, DISABLE_PUSH, DRM_DEV_MODE, worker concurrency/retry/poll).
// ===========================================================================
Object.defineProperty(exports, "__esModule", { value: true });
exports.studyConfigCrossCheckIssues = exports.allowedWindowMinutes = exports.timeZoneOffsetsMinutes = exports.utcOffsetMinutesAt = exports.StudyConfigSchema = exports.SCALE_MAX_SPAN = exports.CATEGORY_ICONS = exports.CAPTURE_INTERVAL_MAX_MS = exports.CAPTURE_INTERVAL_MIN_MS = exports.PROMPT_PLACEHOLDERS = void 0;
const zod_1 = require("zod");
// --- Primitives --------------------------------------------------------------
/** Stable machine key: lowercase snake_case, used in DB rows and the API. */
const Key = zod_1.z
    .string()
    .regex(/^[a-z][a-z0-9_]*$/, "must be lowercase snake_case ([a-z][a-z0-9_]*)")
    .max(64);
/** Local wall-clock time "HH:MM" (24 h) in study.timezone. */
const TimeOfDay = zod_1.z
    .string()
    .regex(/^([01]\d|2[0-3]):[0-5]\d$/, "must be HH:MM (24-hour)");
// No .trim(): texts are used verbatim (prompt fragments such as
// vlm.prompts.workDescription start with a deliberate space).
const NonEmptyText = zod_1.z.string().regex(/\S/, "must not be empty or blank");
const HttpsUrl = zod_1.z
    .string()
    .regex(/^https:\/\/\S+$/, "must be an absolute https:// URL");
// --- Prompt placeholders -------------------------------------------------------
// Fixed list (WP0). Templates are rendered by ONE single-pass replacement of
// `{{name}}`; inserted values are never re-scanned, so a participant-entered
// occupation containing "{{" cannot inject a placeholder. Any other `{{...}}`
// is a validation error.
exports.PROMPT_PLACEHOLDERS = {
    system: ["window_minutes", "activity_count"],
    user: [
        "occupation_context",
        "frame_count",
        "window_minutes",
        "activity_count",
        "activity_definitions",
        "category_keys",
        "category_definitions",
    ],
    occupationKnown: ["occupation"],
    workDescription: ["work_description"],
    occupationUnknown: [],
};
// --- Sections ----------------------------------------------------------------
const StudySection = zod_1.z
    .object({
    /** Human-readable name, logs/admin only. Not a version. */
    name: NonEmptyText,
    /** IANA timezone; replaces DRM_TZ (server, VLM worker) and NEXT_PUBLIC_DRM_TZ. */
    timezone: NonEmptyText,
})
    .strict();
const UiSection = zod_1.z
    .object({
    /** BCP-47 locale for date/time formatting in drm-web (today: en-GB). */
    locale: NonEmptyText,
    /** Preview thumbnails per activity card (assisted + read-only lists). */
    thumbnailsPerActivity: zod_1.z.number().int().min(1).max(20),
})
    .strict();
const WindowingSection = zod_1.z
    .object({
    /**
     * VLM chunk / segmentation grid. Cross-check: must divide 60 and every UTC
     * offset of study.timezone (Europe/Berlin: 1, 2, 3, 4, 5, 6, 10, 12, 15,
     * 20, 30, 60), so the epoch-aligned windows never cross local midnight.
     */
    windowMinutes: zod_1.z.number().int().min(1).max(120),
    /** Idle sweep that closes a session's last chunk (was CHUNK_IDLE_CLOSE_MS). */
    idleCloseMinutes: zod_1.z.number().int().min(1).max(240),
})
    .strict();
const FormFactor = zod_1.z
    .object({
    key: Key,
    displayLabel: NonEmptyText,
})
    .strict();
const DevicesSection = zod_1.z
    .object({
    formFactors: zod_1.z.array(FormFactor).min(1),
})
    .strict();
/**
 * Firmware accepts 5 s .. 10 min (see docs/ble-capture-config.md). 5 s is the
 * hardware-tested minimum; sending one 58 KB frame alone takes ~2.6 s.
 * Same constants in both firmwares.
 */
exports.CAPTURE_INTERVAL_MIN_MS = 5000;
exports.CAPTURE_INTERVAL_MAX_MS = 600000;
const CaptureSection = zod_1.z
    .object({
    /** Capture interval per form-factor key, sent to the camera via BLE 0x03. */
    intervalMsByFormFactor: zod_1.z.record(Key, zod_1.z
        .number()
        .int()
        .min(exports.CAPTURE_INTERVAL_MIN_MS)
        .max(exports.CAPTURE_INTERVAL_MAX_MS)),
})
    .strict();
const ScheduleSection = zod_1.z
    .object({
    /** Reconstruction of TODAY opens at this local time (was DRM_AVAILABLE_FROM_HOUR=19). */
    reconstructionOpensAt: TimeOfDay,
    /** App enables "End session" at this time (study.timezone) on the session's start day. */
    endSessionAvailableAt: TimeOfDay,
    /** Study day extends past local midnight by this much (was DRM_DAY_OVERRUN_HOURS). */
    dayOverrunHours: zod_1.z.number().int().min(0).max(12),
})
    .strict();
const Activity = zod_1.z
    .object({
    key: Key,
    /** Participant-facing label (drm-web dropdown). */
    displayLabel: NonEmptyText,
    /** VLM-only definition. NEVER sent to clients. */
    vlmDefinition: NonEmptyText,
})
    .strict();
/** Icons drm-web can render (mapping to lucide-react lives in drm-web). */
exports.CATEGORY_ICONS = [
    "briefcase",
    "pause",
    "ellipsis",
    "coffee",
    "users",
    "house",
    "book-open",
    "heart",
    "circle",
];
const Category = zod_1.z
    .object({
    key: Key,
    displayLabel: NonEmptyText,
    icon: zod_1.z.enum(exports.CATEGORY_ICONS),
    /** Participant-facing legend text. */
    description: NonEmptyText,
    /** VLM-only definition. NEVER sent to clients. */
    vlmDefinition: NonEmptyText,
})
    .strict();
/** Layout limit of the rating row in drm-web: at most 11 points. */
exports.SCALE_MAX_SPAN = 10;
const LikertScale = zod_1.z
    .object({
    min: zod_1.z.number().int().min(0),
    max: zod_1.z.number().int().min(1),
    lowAnchor: NonEmptyText,
    highAnchor: NonEmptyText,
})
    .strict();
const ExperienceItem = zod_1.z
    .object({
    /** Stored as activity_ratings.item_key; API key in `ratings`. */
    key: Key,
    /** Category keys this item is asked for (e.g. ["work"]). */
    appliesTo: zod_1.z.array(Key).min(1),
    question: NonEmptyText,
    /** Summary label in the submitted view, e.g. "Mental demand" -> "Mental demand 4/7". */
    shortLabel: NonEmptyText,
    scale: LikertScale,
    /** Submit requires an answer when the final category is in appliesTo. */
    requiredOnSubmit: zod_1.z.boolean(),
})
    .strict();
const SegmentationSection = zod_1.z
    .object({
    /**
     * Today's rule 3: equal labelled chunks on both sides of a capture gap
     * merge into one activity. false = a gap always splits.
     */
    mergeAcrossCaptureGaps: zod_1.z.boolean(),
})
    .strict();
const VlmPrompts = zod_1.z
    .object({
    system: NonEmptyText,
    user: NonEmptyText,
    occupationKnown: NonEmptyText,
    /** Appended to occupationKnown when a work description exists. */
    workDescription: NonEmptyText,
    occupationUnknown: NonEmptyText,
})
    .strict();
const VlmSection = zod_1.z
    .object({
    model: NonEmptyText,
    request: zod_1.z
        .object({
        temperature: zod_1.z.number().min(0).max(2),
        reasoningEffort: zod_1.z.enum(["minimal", "low", "medium", "high"]),
        maxCompletionTokens: zod_1.z.number().int().min(1),
    })
        .strict(),
    /** Frames sent per chunk, evenly sampled (was VLM_CHUNK_MAX_FRAMES). */
    maxFramesPerWindow: zod_1.z.number().int().min(1).max(100),
    prompts: VlmPrompts,
})
    .strict();
const OverrelianceSection = zod_1.z
    .object({
    /** false = never inject (is_incorrect_annotation_injected stays 0). */
    enabled: zod_1.z.boolean(),
    /** Share of valid VLM-labelled activities to falsify, rounded up. 0 = never (no fallback). */
    rate: zod_1.z.number().min(0).max(1),
    /** Only activities with mean confidence >= this are candidates. */
    minConfidence: zod_1.z.number().min(0).max(1),
    /**
     * Today: if no activity reaches minConfidence, the single
     * highest-confidence activity is falsified. false = inject nothing then.
     */
    fallbackToTopWhenNoneAboveThreshold: zod_1.z.boolean(),
})
    .strict();
const FaceBlurSection = zod_1.z
    .object({
    /** Default true. false = frames bypass the blur worker (privacy impact!). */
    enabled: zod_1.z.boolean().default(true),
    threshold: zod_1.z.number().min(0).max(1),
    method: zod_1.z.enum(["mosaic", "blur"]),
    blocks: zod_1.z.number().int().min(1),
    /** Gaussian kernel size, 0 = derived from the box size. */
    blurKernel: zod_1.z.number().int().min(0),
    margin: zod_1.z.number().min(0).max(1),
})
    .strict();
const PrivacySection = zod_1.z
    .object({
    faceBlur: FaceBlurSection,
})
    .strict();
const RemindersSection = zod_1.z
    .object({
    bedtime: zod_1.z
        .object({
        enabled: zod_1.z.boolean(),
        leadMinutes: zod_1.z.number().int().min(0).max(720),
        /** Used when the participant gave no bedtime (was DRM_DEFAULT_BEDTIME). */
        defaultBedtime: TimeOfDay,
        /** Latest reminder time on the study day. */
        latestAt: TimeOfDay,
        /** Bedtimes earlier than this count as after-midnight -> latestAt. */
        afterMidnightCutoff: TimeOfDay,
    })
        .strict(),
})
    .strict();
const TextsSection = zod_1.z
    .object({
    push: zod_1.z
        .object({ bedtimeTitle: NonEmptyText, bedtimeBody: NonEmptyText })
        .strict(),
    rounds: zod_1.z
        .object({
        selfIntroTitle: NonEmptyText,
        selfIntroDescription: NonEmptyText,
        assistedIntroTitle: NonEmptyText,
        assistedIntroDescription: NonEmptyText,
        assistedReminderTitle: NonEmptyText,
        assistedReminderBody: NonEmptyText,
        /** Shown only while incorrect labels are part of the study design. */
        assistedReminderIncorrectLabelsNotice: NonEmptyText.nullable(),
        selfEditorHint: NonEmptyText,
        assistedEditorHint: NonEmptyText,
        selfEmptyStateHint: NonEmptyText,
    })
        .strict(),
    progress: zod_1.z
        .object({
        selfRound: NonEmptyText,
        assistedRound: NonEmptyText,
    })
        .strict(),
    app: zod_1.z
        .object({
        recordingNotificationTitle: NonEmptyText,
        recordingNotificationBody: NonEmptyText,
        testRecordingNotificationTitle: NonEmptyText,
        testRecordingNotificationBody: NonEmptyText,
        /** `{{time}}` = schedule.endSessionAvailableAt. */
        endSessionAvailableFrom: NonEmptyText,
        onboarding: zod_1.z
            .object({
            title: NonEmptyText,
            intro: NonEmptyText,
            occupationLabel: NonEmptyText,
            occupationPlaceholder: NonEmptyText,
            workDescriptionLabel: NonEmptyText,
            workDescriptionPlaceholder: NonEmptyText,
            wakeTimeLabel: NonEmptyText,
            bedTimeLabel: NonEmptyText,
        })
            .strict(),
    })
        .strict(),
})
    .strict();
const Survey = zod_1.z
    .object({
    url: HttpsUrl,
    /** Query parameter that carries the participant id. */
    participantParameter: zod_1.z
        .string()
        .regex(/^[A-Za-z][A-Za-z0-9_]*$/, "must be a plain query parameter name"),
})
    .strict();
/** SENSITIVE: real values only in the gitignored config/study.yaml. */
const SurveysSection = zod_1.z
    .object({
    onboarding: Survey,
    final: Survey,
    payoutUrl: HttpsUrl,
})
    .strict();
/** SENSITIVE: real value only in config/study.yaml. */
const AppSection = zod_1.z
    .object({
    studySettingsPin: zod_1.z.string().regex(/^\d{4,8}$/, "must be 4-8 digits"),
})
    .strict();
// --- Root ----------------------------------------------------------------------
exports.StudyConfigSchema = zod_1.z
    .object({
    study: StudySection,
    ui: UiSection,
    windowing: WindowingSection,
    devices: DevicesSection,
    capture: CaptureSection,
    schedule: ScheduleSection,
    activities: zod_1.z.array(Activity).min(2),
    categories: zod_1.z.array(Category).min(1),
    experienceItems: zod_1.z.array(ExperienceItem),
    segmentation: SegmentationSection,
    vlm: VlmSection,
    overreliance: OverrelianceSection,
    privacy: PrivacySection,
    reminders: RemindersSection,
    texts: TextsSection,
    surveys: SurveysSection,
    app: AppSection,
})
    .strict();
const PLACEHOLDER_PATTERN = /\{\{([^{}]*)\}\}/g;
const duplicateKeyIssues = (items, basePath) => {
    const seen = new Map();
    const issues = [];
    items.forEach((item, index) => {
        const first = seen.get(item.key);
        if (first !== undefined) {
            issues.push({
                path: `${basePath}.${index}.key`,
                message: `duplicate key "${item.key}" (first used at ${basePath}.${first})`,
            });
        }
        else {
            seen.set(item.key, index);
        }
    });
    return issues;
};
// --- window alignment (review of PR #1, M3, decided by Felix: variant A) ------
// Windows are epoch-aligned (chunkStartOf in db.ts: t - t % W). They fall on
// local W-minute marks, and therefore never cross local midnight, exactly
// when W divides 60 AND every UTC offset of the study time zone. This is
// checked for the offsets on the 1st and 15th of every month of the current
// and the next year (covers DST and announced offset changes).
/** UTC offset (minutes) of `timeZone` at `epochMs`, e.g. +330 for Asia/Kolkata. */
const utcOffsetMinutesAt = (timeZone, epochMs) => {
    const name = new Intl.DateTimeFormat("en-US", { timeZone, timeZoneName: "longOffset" })
        .formatToParts(new Date(epochMs))
        .find((part) => part.type === "timeZoneName").value; // "GMT", "GMT+05:30"
    const match = /^GMT(?:([+-])(\d{2}):(\d{2}))?$/.exec(name);
    if (!match)
        throw new Error(`unexpected offset format "${name}" for ${timeZone}`);
    if (!match[1])
        return 0;
    const minutes = Number(match[2]) * 60 + Number(match[3]);
    return match[1] === "-" ? -minutes : minutes;
};
exports.utcOffsetMinutesAt = utcOffsetMinutesAt;
const timeZoneOffsetsMinutes = (timeZone, now = new Date()) => {
    const offsets = new Set();
    const year = now.getUTCFullYear();
    for (const y of [year, year + 1])
        for (let month = 0; month < 12; month++)
            for (const day of [1, 15])
                offsets.add((0, exports.utcOffsetMinutesAt)(timeZone, Date.UTC(y, month, day, 12)));
    return [...offsets].sort((a, b) => a - b);
};
exports.timeZoneOffsetsMinutes = timeZoneOffsetsMinutes;
/** windowMinutes values whose windows stay on local marks in `timeZone`. */
const allowedWindowMinutes = (timeZone, now = new Date()) => {
    const offsets = (0, exports.timeZoneOffsetsMinutes)(timeZone, now);
    return Array.from({ length: 60 }, (_, index) => index + 1).filter((w) => 60 % w === 0 && offsets.every((offset) => offset % w === 0));
};
exports.allowedWindowMinutes = allowedWindowMinutes;
const minutesOf = (time) => {
    const [hour, minute] = time.split(":").map(Number);
    return hour * 60 + minute;
};
/**
 * Checks that JSON Schema cannot express. The Node loader runs all of them;
 * the Python workers run the ones marked [py] (contract doc, section 2).
 */
const studyConfigCrossCheckIssues = (config) => {
    const issues = [];
    // [py] unique keys
    issues.push(...duplicateKeyIssues(config.activities, "activities"));
    issues.push(...duplicateKeyIssues(config.categories, "categories"));
    issues.push(...duplicateKeyIssues(config.experienceItems, "experienceItems"));
    issues.push(...duplicateKeyIssues(config.devices.formFactors, "devices.formFactors"));
    // appliesTo -> existing category (several items per category are allowed)
    const categoryKeys = new Set(config.categories.map((c) => c.key));
    config.experienceItems.forEach((item, itemIndex) => {
        item.appliesTo.forEach((categoryKey, index) => {
            if (!categoryKeys.has(categoryKey)) {
                issues.push({
                    path: `experienceItems.${itemIndex}.appliesTo.${index}`,
                    message: `unknown category "${categoryKey}"`,
                });
            }
        });
        if (item.scale.min >= item.scale.max) {
            issues.push({
                path: `experienceItems.${itemIndex}.scale`,
                message: "min must be smaller than max",
            });
        }
        else if (item.scale.max - item.scale.min > exports.SCALE_MAX_SPAN) {
            issues.push({
                path: `experienceItems.${itemIndex}.scale`,
                message: `max - min must be <= ${exports.SCALE_MAX_SPAN}`,
            });
        }
    });
    // capture interval for exactly the configured form factors
    const formFactorKeys = new Set(config.devices.formFactors.map((f) => f.key));
    for (const key of formFactorKeys) {
        if (!(key in config.capture.intervalMsByFormFactor)) {
            issues.push({
                path: `capture.intervalMsByFormFactor.${key}`,
                message: "missing interval for configured form factor",
            });
        }
    }
    for (const [key, intervalMs] of Object.entries(config.capture.intervalMsByFormFactor)) {
        if (!formFactorKeys.has(key)) {
            issues.push({
                path: `capture.intervalMsByFormFactor.${key}`,
                message: "unknown form factor (not in devices.formFactors)",
            });
        }
        // [py] interval < window
        if (intervalMs >= config.windowing.windowMinutes * 60000) {
            issues.push({
                path: `capture.intervalMsByFormFactor.${key}`,
                message: "must be shorter than windowing.windowMinutes",
            });
        }
    }
    // [py] windows on local W-minute marks (never across local midnight/DST)
    let allowedWindows = null;
    try {
        allowedWindows = (0, exports.allowedWindowMinutes)(config.study.timezone);
    }
    catch {
        // unknown time zone: reported by the timezone check below
    }
    if (allowedWindows && !allowedWindows.includes(config.windowing.windowMinutes)) {
        issues.push({
            path: "windowing.windowMinutes",
            message: `must divide 60 and every UTC offset of ${config.study.timezone} ` +
                `(windows are clock-aligned and must not cross local midnight); ` +
                `allowed: ${allowedWindows.join(", ")}`,
        });
    }
    if (config.windowing.idleCloseMinutes < config.windowing.windowMinutes) {
        issues.push({
            path: "windowing.idleCloseMinutes",
            message: "must be >= windowing.windowMinutes",
        });
    }
    // [py] only allowed prompt placeholders
    for (const [name, allowed] of Object.entries(exports.PROMPT_PLACEHOLDERS)) {
        const template = config.vlm.prompts[name];
        for (const match of template.matchAll(PLACEHOLDER_PATTERN)) {
            const placeholder = match[1];
            if (!allowed.includes(placeholder)) {
                issues.push({
                    path: `vlm.prompts.${name}`,
                    message: `unknown placeholder "{{${placeholder}}}" (allowed: ${allowed.length > 0 ? allowed.join(", ") : "none"})`,
                });
            }
        }
    }
    // [py] timezone must be known to the runtime
    try {
        new Intl.DateTimeFormat("en-GB", { timeZone: config.study.timezone });
    }
    catch {
        issues.push({ path: "study.timezone", message: "unknown IANA timezone" });
    }
    // [py] A deliberately wrong category needs an alternative (review m1:
    // crypto.randomInt(0) threw for a single-category study).
    const injects = config.overreliance.enabled && config.overreliance.rate > 0;
    if (injects && config.categories.length < 2) {
        issues.push({
            path: "overreliance.enabled",
            message: "needs at least 2 categories (a wrong label needs an alternative)",
        });
    }
    // Never tell participants that labels are deliberately wrong when they are not.
    // rate 0 injects nothing, exactly like enabled: false.
    if (!injects && config.texts.rounds.assistedReminderIncorrectLabelsNotice !== null) {
        issues.push({
            path: "texts.rounds.assistedReminderIncorrectLabelsNotice",
            message: "must be null when overreliance.enabled is false or overreliance.rate is 0",
        });
    }
    // bedtime clamp must be coherent
    const bedtime = config.reminders.bedtime;
    if (minutesOf(bedtime.afterMidnightCutoff) > minutesOf(bedtime.latestAt)) {
        issues.push({
            path: "reminders.bedtime.afterMidnightCutoff",
            message: "must not be later than reminders.bedtime.latestAt",
        });
    }
    return issues;
};
exports.studyConfigCrossCheckIssues = studyConfigCrossCheckIssues;
