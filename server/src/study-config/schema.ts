// ===========================================================================
// Study configuration schema (documentation: docs/study-config-documentation.md).
//
// Defines the shape of config/study.yaml. The JSON Schema consumed by the
// Python workers (config/study-config.schema.json) is generated from this
// file:  npm run generate-study-config-schema
// and checked for freshness by scripts/test-study-config-schema.ts.
//
// Two validation layers:
//   1. Shape (this zod object -> also expressible as JSON Schema, so the
//      Python workers validate the same shape with `jsonschema`).
//   2. Cross-field checks (`studyConfigCrossCheckIssues` below). These are
//      not representable in JSON Schema; the Python workers re-implement the
//      subset they depend on (see docs/study-config-documentation.md, section 1.2).
//
// Infrastructure stays in env vars (ports, paths, API key, base URL,
// WEB_URL, DISABLE_PUSH, DRM_DEV_MODE, worker concurrency/retry/poll).
// ===========================================================================

import { z } from "zod";

// --- Primitives --------------------------------------------------------------

/** Stable machine key: lowercase snake_case, used in DB rows and the API. */
const Key = z
  .string()
  .regex(/^[a-z][a-z0-9_]*$/, "must be lowercase snake_case ([a-z][a-z0-9_]*)")
  .max(64);

/** Local wall-clock time "HH:MM" (24 h) in study.timezone. */
const TimeOfDay = z
  .string()
  .regex(/^([01]\d|2[0-3]):[0-5]\d$/, "must be HH:MM (24-hour)");

// Texts are used verbatim, without trimming (prompt fragments such as
// vlm.prompts.workDescription start with a space).
const NonEmptyText = z.string().regex(/\S/, "must not be empty or blank");

const HttpsUrl = z
  .string()
  .regex(/^https:\/\/\S+$/, "must be an absolute https:// URL");

// --- Prompt placeholders -------------------------------------------------------
// Fixed list. Templates are rendered by one single-pass replacement of
// `{{name}}`; inserted values are never re-scanned, so a participant-entered
// occupation containing "{{" cannot inject a placeholder. Any other `{{...}}`
// is a validation error.

export const PROMPT_PLACEHOLDERS = {
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
} as const satisfies Record<string, readonly string[]>;

export type PromptTemplateName = keyof typeof PROMPT_PLACEHOLDERS;

// --- Sections ----------------------------------------------------------------

const StudySection = z
  .object({
    /** Human-readable name, logs/admin only. */
    name: NonEmptyText,
    /** IANA timezone used by the server, the workers and the clients. */
    timezone: NonEmptyText,
  })
  .strict();

const UiSection = z
  .object({
    /** BCP-47 locale for date/time formatting in drm-web. */
    locale: NonEmptyText,
    /** Preview thumbnails per activity card (assisted + read-only lists). */
    thumbnailsPerActivity: z.number().int().min(1).max(20),
  })
  .strict();

const WindowingSection = z
  .object({
    /**
     * VLM chunk / segmentation window in minutes. Cross-check: must divide 60
     * and every UTC offset of study.timezone (Europe/Berlin: 1, 2, 3, 4, 5, 6,
     * 10, 12, 15, 20, 30, 60).
     */
    windowMinutes: z.number().int().min(1).max(120),
    /** Minutes without a new frame after which a session's last chunk is closed. */
    idleCloseMinutes: z.number().int().min(1).max(240),
  })
  .strict();

const FormFactor = z
  .object({
    key: Key,
    displayLabel: NonEmptyText,
  })
  .strict();

const DevicesSection = z
  .object({
    formFactors: z.array(FormFactor).min(1),
  })
  .strict();

/**
 * Firmware accepts 5 s .. 10 min (see docs/ble-protocol.md). Same constants
 * in both firmwares.
 */
export const CAPTURE_INTERVAL_MIN_MS = 5_000;
export const CAPTURE_INTERVAL_MAX_MS = 600_000;

const CaptureSection = z
  .object({
    /** Capture interval per form-factor key, sent to the camera via BLE 0x03. */
    intervalMsByFormFactor: z.record(
      Key,
      z
        .number()
        .int()
        .min(CAPTURE_INTERVAL_MIN_MS)
        .max(CAPTURE_INTERVAL_MAX_MS),
    ),
  })
  .strict();

const ScheduleSection = z
  .object({
    /** Reconstruction of the current study day opens at this local time. */
    reconstructionOpensAt: TimeOfDay,
    /** App enables "End session" at this time (study.timezone) on the session's start day. */
    endSessionAvailableAt: TimeOfDay,
    /** Hours the study day extends past local midnight. */
    dayOverrunHours: z.number().int().min(0).max(12),
  })
  .strict();

const Activity = z
  .object({
    key: Key,
    /** Participant-facing label (drm-web dropdown). */
    displayLabel: NonEmptyText,
    /** VLM-only definition, not included in client responses. */
    vlmDefinition: NonEmptyText,
  })
  .strict();

/** Icons drm-web can render (mapping to lucide-react lives in drm-web). */
export const CATEGORY_ICONS = [
  "briefcase",
  "pause",
  "ellipsis",
  "coffee",
  "users",
  "house",
  "book-open",
  "heart",
  "circle",
] as const;

const Category = z
  .object({
    key: Key,
    displayLabel: NonEmptyText,
    icon: z.enum(CATEGORY_ICONS),
    /** Participant-facing legend text. */
    description: NonEmptyText,
    /** VLM-only definition, not included in client responses. */
    vlmDefinition: NonEmptyText,
  })
  .strict();

/** Layout limit of the rating row in drm-web: at most 11 points. */
export const SCALE_MAX_SPAN = 10;

const LikertScale = z
  .object({
    min: z.number().int().min(0),
    max: z.number().int().min(1),
    lowAnchor: NonEmptyText,
    highAnchor: NonEmptyText,
  })
  .strict();

const ExperienceItem = z
  .object({
    /** Stored as activity_ratings.item_key; API key in `ratings`. */
    key: Key,
    /** Category keys this item is asked for (e.g. ["work"]). */
    appliesTo: z.array(Key).min(1),
    question: NonEmptyText,
    /** Summary label in the submitted view, e.g. "Mental demand" -> "Mental demand 4/7". */
    shortLabel: NonEmptyText,
    scale: LikertScale,
    /** Submit requires an answer when the final category is in appliesTo. */
    requiredOnSubmit: z.boolean(),
  })
  .strict();

const SegmentationSection = z
  .object({
    /**
     * true: equal labelled chunks on both sides of a capture gap merge into
     * one activity. false: a gap always splits.
     */
    mergeAcrossCaptureGaps: z.boolean(),
  })
  .strict();

const VlmPrompts = z
  .object({
    system: NonEmptyText,
    user: NonEmptyText,
    occupationKnown: NonEmptyText,
    /** Appended to occupationKnown when a work description exists. */
    workDescription: NonEmptyText,
    occupationUnknown: NonEmptyText,
  })
  .strict();

const VlmSection = z
  .object({
    model: NonEmptyText,
    request: z
      .object({
        temperature: z.number().min(0).max(2),
        reasoningEffort: z.enum(["minimal", "low", "medium", "high"]),
        maxCompletionTokens: z.number().int().min(1),
      })
      .strict(),
    /** Frames sent per chunk, evenly sampled. */
    maxFramesPerWindow: z.number().int().min(1).max(100),
    prompts: VlmPrompts,
  })
  .strict();

const OverrelianceSection = z
  .object({
    /** false = never inject (is_incorrect_annotation_injected stays 0). */
    enabled: z.boolean(),
    /** Share of valid VLM-labelled activities to falsify, rounded up. 0 = never (no fallback). */
    rate: z.number().min(0).max(1),
    /** Only activities with mean confidence >= this are candidates. */
    minConfidence: z.number().min(0).max(1),
    /**
     * true: if no activity reaches minConfidence, the single
     * highest-confidence activity is falsified. false: nothing is injected.
     */
    fallbackToTopWhenNoneAboveThreshold: z.boolean(),
  })
  .strict();

const FaceBlurSection = z
  .object({
    /** Default true. false = frames bypass the blur worker and are stored unblurred. */
    enabled: z.boolean().default(true),
    threshold: z.number().min(0).max(1),
    method: z.enum(["mosaic", "blur"]),
    blocks: z.number().int().min(1),
    /** Gaussian kernel size, 0 = derived from the box size. */
    blurKernel: z.number().int().min(0),
    margin: z.number().min(0).max(1),
  })
  .strict();

const PrivacySection = z
  .object({
    faceBlur: FaceBlurSection,
  })
  .strict();

const RemindersSection = z
  .object({
    bedtime: z
      .object({
        enabled: z.boolean(),
        leadMinutes: z.number().int().min(0).max(720),
        /** Used when the participant gave no bedtime. */
        defaultBedtime: TimeOfDay,
        /** Latest reminder time on the study day. */
        latestAt: TimeOfDay,
        /** Bedtimes earlier than this count as after-midnight -> latestAt. */
        afterMidnightCutoff: TimeOfDay,
      })
      .strict(),
  })
  .strict();

const TextsSection = z
  .object({
    push: z
      .object({ bedtimeTitle: NonEmptyText, bedtimeBody: NonEmptyText })
      .strict(),
    rounds: z
      .object({
        selfIntroTitle: NonEmptyText,
        selfIntroDescription: NonEmptyText,
        assistedIntroTitle: NonEmptyText,
        assistedIntroDescription: NonEmptyText,
        assistedReminderTitle: NonEmptyText,
        assistedReminderBody: NonEmptyText,
        /** Shown in the assisted-round reminder; null hides it. */
        assistedReminderIncorrectLabelsNotice: NonEmptyText.nullable(),
        selfEditorHint: NonEmptyText,
        assistedEditorHint: NonEmptyText,
        selfEmptyStateHint: NonEmptyText,
      })
      .strict(),
    progress: z
      .object({
        selfRound: NonEmptyText,
        assistedRound: NonEmptyText,
      })
      .strict(),
    app: z
      .object({
        recordingNotificationTitle: NonEmptyText,
        recordingNotificationBody: NonEmptyText,
        testRecordingNotificationTitle: NonEmptyText,
        testRecordingNotificationBody: NonEmptyText,
        /** `{{time}}` = schedule.endSessionAvailableAt. */
        endSessionAvailableFrom: NonEmptyText,
        onboarding: z
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

const Survey = z
  .object({
    url: HttpsUrl,
    /** Query parameter that carries the participant id. */
    participantParameter: z
      .string()
      .regex(/^[A-Za-z][A-Za-z0-9_]*$/, "must be a plain query parameter name"),
  })
  .strict();

/** Sensitive: real values only in the gitignored config/study.yaml. */
const SurveysSection = z
  .object({
    onboarding: Survey,
    final: Survey,
    payoutUrl: HttpsUrl,
  })
  .strict();

/** Sensitive: real value only in config/study.yaml. */
const AppSection = z
  .object({
    studySettingsPin: z.string().regex(/^\d{4,8}$/, "must be 4-8 digits"),
  })
  .strict();

// --- Root ----------------------------------------------------------------------

export const StudyConfigSchema = z
  .object({
    study: StudySection,
    ui: UiSection,
    windowing: WindowingSection,
    devices: DevicesSection,
    capture: CaptureSection,
    schedule: ScheduleSection,
    activities: z.array(Activity).min(2),
    categories: z.array(Category).min(1),
    experienceItems: z.array(ExperienceItem),
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

/** Parsed (defaults applied) config. */
export type StudyConfig = z.output<typeof StudyConfigSchema>;
/** Raw YAML shape (defaults optional). */
export type StudyConfigInput = z.input<typeof StudyConfigSchema>;

// --- Cross-field checks --------------------------------------------------------

export interface StudyConfigIssue {
  /** Dotted path, e.g. "experienceItems.1.appliesTo.0". */
  path: string;
  message: string;
}

const PLACEHOLDER_PATTERN = /\{\{([^{}]*)\}\}/g;

const duplicateKeyIssues = (
  items: readonly { key: string }[],
  basePath: string,
): StudyConfigIssue[] => {
  const seen = new Map<string, number>();
  const issues: StudyConfigIssue[] = [];
  items.forEach((item, index) => {
    const first = seen.get(item.key);
    if (first !== undefined) {
      issues.push({
        path: `${basePath}.${index}.key`,
        message: `duplicate key "${item.key}" (first used at ${basePath}.${first})`,
      });
    } else {
      seen.set(item.key, index);
    }
  });
  return issues;
};

// --- window alignment ---------------------------------------------------------
// Windows are epoch-aligned (chunkStartOf in db.ts: t - t % W). They fall on
// local W-minute marks, and therefore never cross local midnight, exactly
// when W divides 60 and every UTC offset of the study time zone. This is
// checked for the offsets on the 1st and 15th of every month of the current
// and the next year (covers DST and announced offset changes).

/** UTC offset (minutes) of `timeZone` at `epochMs`, e.g. +330 for Asia/Kolkata. */
export const utcOffsetMinutesAt = (timeZone: string, epochMs: number): number => {
  const name = new Intl.DateTimeFormat("en-US", { timeZone, timeZoneName: "longOffset" })
    .formatToParts(new Date(epochMs))
    .find((part) => part.type === "timeZoneName")!.value; // "GMT", "GMT+05:30"
  const match = /^GMT(?:([+-])(\d{2}):(\d{2}))?$/.exec(name);
  if (!match) throw new Error(`unexpected offset format "${name}" for ${timeZone}`);
  if (!match[1]) return 0;
  const minutes = Number(match[2]) * 60 + Number(match[3]);
  return match[1] === "-" ? -minutes : minutes;
};

export const timeZoneOffsetsMinutes = (timeZone: string, now: Date = new Date()): number[] => {
  const offsets = new Set<number>();
  const year = now.getUTCFullYear();
  for (const y of [year, year + 1])
    for (let month = 0; month < 12; month++)
      for (const day of [1, 15]) offsets.add(utcOffsetMinutesAt(timeZone, Date.UTC(y, month, day, 12)));
  return [...offsets].sort((a, b) => a - b);
};

/** windowMinutes values whose windows stay on local marks in `timeZone`. */
export const allowedWindowMinutes = (timeZone: string, now: Date = new Date()): number[] => {
  const offsets = timeZoneOffsetsMinutes(timeZone, now);
  return Array.from({ length: 60 }, (_, index) => index + 1).filter(
    (w) => 60 % w === 0 && offsets.every((offset) => offset % w === 0),
  );
};

const minutesOf = (time: string): number => {
  const [hour, minute] = time.split(":").map(Number);
  return hour * 60 + minute;
};

/**
 * Checks that JSON Schema cannot express. The Node loader runs all of them;
 * the Python workers run the ones marked [py] (documentation, section 1.2).
 */
export const studyConfigCrossCheckIssues = (
  config: StudyConfig,
): StudyConfigIssue[] => {
  const issues: StudyConfigIssue[] = [];

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
    } else if (item.scale.max - item.scale.min > SCALE_MAX_SPAN) {
      issues.push({
        path: `experienceItems.${itemIndex}.scale`,
        message: `max - min must be <= ${SCALE_MAX_SPAN}`,
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
  for (const [key, intervalMs] of Object.entries(
    config.capture.intervalMsByFormFactor,
  )) {
    if (!formFactorKeys.has(key)) {
      issues.push({
        path: `capture.intervalMsByFormFactor.${key}`,
        message: "unknown form factor (not in devices.formFactors)",
      });
    }
    // [py] interval < window
    if (intervalMs >= config.windowing.windowMinutes * 60_000) {
      issues.push({
        path: `capture.intervalMsByFormFactor.${key}`,
        message: "must be shorter than windowing.windowMinutes",
      });
    }
  }

  // [py] windows on local W-minute marks (never across local midnight/DST)
  let allowedWindows: number[] | null = null;
  try {
    allowedWindows = allowedWindowMinutes(config.study.timezone);
  } catch {
    // unknown time zone: reported by the timezone check below
  }
  if (allowedWindows && !allowedWindows.includes(config.windowing.windowMinutes)) {
    issues.push({
      path: "windowing.windowMinutes",
      message:
        `must divide 60 and every UTC offset of ${config.study.timezone} ` +
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
  for (const [name, allowed] of Object.entries(PROMPT_PLACEHOLDERS)) {
    const template = config.vlm.prompts[name as PromptTemplateName];
    for (const match of template.matchAll(PLACEHOLDER_PATTERN)) {
      const placeholder = match[1];
      if (!(allowed as readonly string[]).includes(placeholder)) {
        issues.push({
          path: `vlm.prompts.${name}`,
          message: `unknown placeholder "{{${placeholder}}}" (allowed: ${
            allowed.length > 0 ? allowed.join(", ") : "none"
          })`,
        });
      }
    }
  }

  // [py] timezone must be known to the runtime
  try {
    new Intl.DateTimeFormat("en-GB", { timeZone: config.study.timezone });
  } catch {
    issues.push({ path: "study.timezone", message: "unknown IANA timezone" });
  }

  // [py] injecting an incorrect category requires at least two categories
  const injects = config.overreliance.enabled && config.overreliance.rate > 0;
  if (injects && config.categories.length < 2) {
    issues.push({
      path: "overreliance.enabled",
      message: "needs at least 2 categories (a wrong label needs an alternative)",
    });
  }

  // the incorrect-labels notice must be null when nothing is injected
  // (enabled: false or rate 0)
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
