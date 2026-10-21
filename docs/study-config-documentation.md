# Study config documentation

One YAML file describes a study: time zone, schedule, window length, activity
and category vocabulary, experience items, VLM model and prompts, overreliance
injection, face blur, reminders, participant-facing texts, survey links and the
Study Settings PIN. The server and both Python workers (VLM, face blur) read
the same file at start-up; drm-web and the app receive the parts they need over
the API. Prompts, VLM settings and overreliance values never reach a client.

| File | Role |
|---|---|
| `server/src/study-config/schema.ts` | zod schema, **single source** for the shape and the cross-field checks |
| `config/study-config.schema.json` | JSON Schema (draft 2020-12) generated from it, used by the Python workers |
| `server/scripts/generate-study-config-schema.ts` | generator (`npm run generate-study-config-schema`, `-- --check`) |
| `config/study.example.yaml` | the paper study; sensitive fields are placeholders |
| `config/study.test.yaml` | a deliberately different study for tests |
| `server/src/study-config/load.ts`, `server/blinks_study_config.py` | loaders (Node, Python) |
| `server/scripts/test-study-config-schema.ts` | schema fresh, example valid, example values, invalid cases |
| `server/vlm/test_study_example_prompts.py` | golden test: prompts rendered from the example are byte-identical to the reference prompts |

## 1. File, path and loading

| Step | Rule |
|---|---|
| Path | env `BLINKS_STUDY_CONFIG` (absolute or relative to the working directory); default `config/study.yaml` relative to the repo root (gitignored) |
| Missing file | `BLINKS_STUDY_CONFIG` set but missing → fatal. Default file missing → fallback to `config/study.example.yaml` with a loud warning, **only outside production** |
| Production | `NODE_ENV=production` (Python also `BLINKS_ENV=production`): no fallback, and the example file is refused even when named explicitly |
| Parsers | Node `yaml` (YAML 1.2), Python `PyYAML` `safe_load` (YAML 1.1). **Always quote** times, the PIN and ambiguous strings (`on`, `no`, `0000`) so both parse the same |
| Defaults | only `privacy.faceBlur.enabled` (default `true`); every other field is required |
| Unknown fields | error (`additionalProperties: false` / `.strict()`) |

### 1.1 Start-up validation

Server, VLM worker and face-blur worker, in this order:

1. parse YAML,
2. validate the shape (zod, or `jsonschema` against `config/study-config.schema.json`),
3. run the cross-field checks (1.2),
4. in production: the production rules (1.3).

Any problem stops the process: every issue is printed to stderr as
`path.to.field: reason` and the process **exits with code 2**. The config has
no version field and no hash; values apply from process start.

### 1.2 Cross-field checks

`[py]` = also checked by the Python workers.

| Check | Error path |
|---|---|
| `[py]` keys unique in `activities`, `categories`, `experienceItems`, `devices.formFactors` | `<list>.<i>.key` |
| `experienceItems[].appliesTo` refers to existing category keys | `experienceItems.<i>.appliesTo.<j>` |
| `scale.min < scale.max` and `max − min <= 10` | `experienceItems.<i>.scale` |
| `[py]` **window rule:** `windowMinutes` divides 60 **and** every UTC offset of `study.timezone` (offsets sampled on the 1st and 15th of every month of the current and the next year). The message lists the allowed values | `windowing.windowMinutes` |
| `idleCloseMinutes >= windowMinutes` | `windowing.idleCloseMinutes` |
| `[py]` prompts use only the allowed placeholders (section 3) | `vlm.prompts.<name>` |
| `[py]` `study.timezone` is a known IANA zone | `study.timezone` |
| `[py]` injection active (`overreliance.enabled: true` and `rate > 0`) ⇒ at least 2 categories | `overreliance.enabled` |
| injection inactive (`enabled: false` or `rate: 0`) ⇒ `texts.rounds.assistedReminderIncorrectLabelsNotice` is `null` | `texts.rounds.assistedReminderIncorrectLabelsNotice` |
| `reminders.bedtime.afterMidnightCutoff <= latestAt` | `reminders.bedtime.afterMidnightCutoff` |

Allowed `windowMinutes` by zone (examples):

| Zone | Allowed |
|---|---|
| `Europe/Berlin`, `UTC` | 1, 2, 3, 4, 5, 6, 10, 12, 15, 20, 30, 60 |
| `Asia/Kolkata` (+05:30), `Australia/Lord_Howe`, `America/St_Johns` | 1, 2, 3, 5, 6, 10, 15, 30 |
| `Asia/Kathmandu` (+05:45) | 1, 3, 5, 15 |

Windows are epoch-aligned (`chunkStartOf` in `server/src/db.ts`); with this rule
they start on local W-minute marks and never cross local midnight or a DST switch.

### 1.3 Production-only rules

Checked by the Node loader, the Python loader and `deploy/deploy.sh`:

- `app.studySettingsPin` must differ from the placeholder PIN in
  `study.example.yaml`.
- Survey and payout links on `example.org` / `example.com` (any subdomain) are refused.

## 2. Fields

See `config/study.example.yaml` (commented) and `schema.ts`. Keys are
`[a-z][a-z0-9_]*`, max 64 characters. Texts must not be blank. Times are
`"HH:MM"` (24 h) in `study.timezone`. Example values are those of the paper study.

| Field | Type / constraint | Example | Use |
|---|---|---|---|
| `study.name` | text | `"BLINKS DRM study (paper default)"` | logs/admin only, not a version |
| `study.timezone` | IANA zone | `"Europe/Berlin"` | study day, evening gate, end session, reminders, web display |
| `ui.locale` | BCP-47 | `"en-GB"` | date/time formatting in drm-web |
| `ui.thumbnailsPerActivity` | int 1–20 | `5` | preview images per activity card |
| `windowing.windowMinutes` | int 1–120, window rule (1.2) | `5` | VLM chunk and segmentation grid |
| `windowing.idleCloseMinutes` | int 1–240, ≥ window | `10` | idle sweep closing a session's last chunk |
| `devices.formFactors[]` | `{key, displayLabel}`, ≥ 1 | `necklace`, `glasses` | camera types in Study Settings; stored in `participants.camera_form_factor` |
| `schedule.reconstructionOpensAt` | time | `"19:00"` | reconstruction of today opens (server-enforced) |
| `schedule.endSessionAvailableAt` | time | `"19:00"` | app enables "End session" on the session's start day, in `study.timezone` |
| `schedule.dayOverrunHours` | int 0–12 | `4` | study day extends past local midnight |
| `activities[]` | `{key, displayLabel, vlmDefinition}`, ≥ 2 | 17 activities | shared vocabulary of VLM and participants |
| `categories[]` | `{key, displayLabel, icon, description, vlmDefinition}`, ≥ 1 | `work`, `break`, `other` | activity type; `icon` ∈ `briefcase, pause, ellipsis, coffee, users, house, book-open, heart, circle` |
| `experienceItems[]` | `{key, appliesTo[], question, shortLabel, scale{min ≥ 0, max ≥ 1, lowAnchor, highAnchor}, requiredOnSubmit}` | `mental_demand` (work), `mental_recovery` (break), 1–7 | per-activity ratings (section 4.6, 7) |
| `segmentation.mergeAcrossCaptureGaps` | bool | `true` | equal labelled chunks on both sides of a capture gap merge; `false` = a gap always splits |
| `vlm.model` | text | `"azure.gpt-5.6-terra"` | VLM model |
| `vlm.request.temperature` | 0–2 | `0` | |
| `vlm.request.reasoningEffort` | `minimal \| low \| medium \| high` | `high` | |
| `vlm.request.maxCompletionTokens` | int ≥ 1 | `8192` | |
| `vlm.maxFramesPerWindow` | int 1–100 | `20` | frames per chunk, evenly sampled |
| `vlm.prompts.{system, user, occupationKnown, workDescription, occupationUnknown}` | text with placeholders (section 3) | | |
| `overreliance.enabled` | bool | `true` | section 5 |
| `overreliance.rate` | 0–1 | `0.1` | share of valid VLM-labelled activities, rounded up; `0` = never inject |
| `overreliance.minConfidence` | 0–1 | `0.8` | candidates need mean confidence ≥ this |
| `overreliance.fallbackToTopWhenNoneAboveThreshold` | bool | `true` | none above threshold → falsify the single most confident activity |
| `privacy.faceBlur.enabled` | bool, **default `true`** | `true` | section 6 |
| `privacy.faceBlur.threshold` | 0–1 | `0.2` | face detection threshold |
| `privacy.faceBlur.method` | `mosaic \| blur` | `mosaic` | |
| `privacy.faceBlur.blocks` | int ≥ 1 | `8` | mosaic blocks |
| `privacy.faceBlur.blurKernel` | int ≥ 0 | `0` | Gaussian kernel; `0` = derived from the box size |
| `privacy.faceBlur.margin` | 0–1 | `0.12` | box margin |
| `reminders.bedtime.enabled` | bool | `true` | single bedtime push |
| `reminders.bedtime.leadMinutes` | int 0–720 | `30` | push at bedtime − lead |
| `reminders.bedtime.defaultBedtime` | time | `"22:00"` | participant gave no bedtime |
| `reminders.bedtime.latestAt` | time | `"23:50"` | latest push time |
| `reminders.bedtime.afterMidnightCutoff` | time ≤ `latestAt` | `"12:00"` | earlier bedtimes count as after midnight → `latestAt` |
| `texts.push.{bedtimeTitle, bedtimeBody}` | text | | push notification |
| `texts.rounds.*` | text; `assistedReminderIncorrectLabelsNotice` text or `null` | | intro, reminder, editor hints of both rounds |
| `texts.progress.{selfRound, assistedRound}` | text | | step labels in drm-web |
| `texts.app.*` | text; `endSessionAvailableFrom` contains `{{time}}` | | app notifications, end-session hint, onboarding |
| `surveys.onboarding`, `surveys.final` | `{url: https, participantParameter: [A-Za-z][A-Za-z0-9_]*}` | `participant_id`, `participantId` | **sensitive**; survey links |
| `surveys.payoutUrl` | https URL | | **sensitive**; target of `/api/payout` |
| `app.studySettingsPin` | 4–8 digits | `"0000"` (placeholder) | **sensitive**; Study Settings PIN; set a new one per study |

`key` values are stored in the database (activities, categories, items, form
factors). Do not rename or remove them during a running study; display texts
may change.

**Not in the config (env vars):** `CAMERA_PORT`, `RECORDINGS_DIR`, `DATA_DIR`,
`AUTH_DB_PATH`, `WEB_URL`, `DISABLE_PUSH`, `DRM_DEV_MODE`, `KIT_API_KEY`,
`KIT_BASE_URL`, `VLM_TIMEOUT`, `VLM_MAX_ATTEMPTS`, `VLM_RETRY_DELAYS_S`,
`VLM_CONCURRENCY`, `BATCH_SIZE`, `POLL_INTERVAL_S`.

## 3. Prompt templates

Rendering is **one** pass that replaces every `{{name}}`. Inserted values are
not scanned again (an occupation like `"{{frame_count}}"` stays literal). Any
other placeholder is a validation error.

| Template | Placeholders |
|---|---|
| `vlm.prompts.system` | `{{window_minutes}}`, `{{activity_count}}` |
| `vlm.prompts.user` | `{{occupation_context}}`, `{{frame_count}}`, `{{window_minutes}}`, `{{activity_count}}`, `{{activity_definitions}}`, `{{category_keys}}`, `{{category_definitions}}` |
| `vlm.prompts.occupationKnown` | `{{occupation}}` |
| `vlm.prompts.workDescription` | `{{work_description}}` |
| `vlm.prompts.occupationUnknown` | none |

Derived values:

| Placeholder | Value |
|---|---|
| `activity_definitions` | per activity `- "<key>": <vlmDefinition>`, joined with `\n` |
| `category_keys` | `[` + `"<key>"` joined with `", "` + `]`, e.g. `["work", "break", "other"]` |
| `category_definitions` | `"<key>" = <vlmDefinition>`, joined with one space |
| `occupation_context` | occupation and description trimmed; empty occupation → `occupationUnknown`, else `occupationKnown` + (non-empty description) `workDescription` |
| `window_minutes`, `activity_count`, `frame_count` | decimal number |

The example's system prompt says "about five minutes" literally; adapt the text
when changing the window. The VLM response schema (`VLM_RESPONSE_FORMAT`) is
built in the worker from the configured keys and is not configurable.

## 4. API

All endpoints: JSON, `Cache-Control: no-store`. Values apply from server start.
The server does not log the responses and never logs the PIN.

**Never in a client response:** `vlm.*`, `activities[].vlmDefinition`,
`categories[].vlmDefinition`, `overreliance.*`, `privacy.*`, `reminders.*`,
`segmentation.*`, `texts.push`, `surveys.payoutUrl`. The PIN only in
`/api/app-config`.

### 4.1 `GET /api/study-config` (drm-web)

- Auth: `Authorization: Bearer <token>`, participant **or** admin. No cookie
  fallback. Allowed during onboarding and after study completion.
- `surveys` only for participant tokens, `null` for admin tokens.
- Array order = order in the YAML.

```ts
export interface StudyConfigResponse {
  study: { timezone: string };                           // "Europe/Berlin"
  ui: { locale: string; thumbnailsPerActivity: number }; // "en-GB", 5
  windowing: { windowMinutes: number };                  // 5
  schedule: { reconstructionOpensAt: string };           // "19:00"
  activities: { key: string; displayLabel: string }[];
  categories: {
    key: string;
    displayLabel: string;
    icon: CategoryIcon;
    description: string;
  }[];
  experienceItems: {
    key: string;
    appliesTo: string[];            // category keys
    question: string;
    shortLabel: string;             // "Mental demand" -> "Mental demand 4/7"
    scale: { min: number; max: number; lowAnchor: string; highAnchor: string };
    requiredOnSubmit: boolean;
  }[];
  texts: {
    rounds: {
      selfIntroTitle: string;
      selfIntroDescription: string;
      assistedIntroTitle: string;
      assistedIntroDescription: string;
      assistedReminderTitle: string;
      assistedReminderBody: string;
      assistedReminderIncorrectLabelsNotice: string | null; // null = not shown
      selfEditorHint: string;
      assistedEditorHint: string;
      selfEmptyStateHint: string;
    };
    progress: { selfRound: string; assistedRound: string };
  };
  surveys: {
    onboarding: { url: string; participantParameter: string }; // "participant_id"
    final: { url: string; participantParameter: string };      // "participantId"
  } | null;
}

export type CategoryIcon =
  | "briefcase" | "pause" | "ellipsis" | "coffee" | "users"
  | "house" | "book-open" | "heart" | "circle";
```

The web appends `<participantParameter>=<username>` to each survey URL.

### 4.2 `GET /api/payout`

Redirect to `surveys.payoutUrl` for a signed-in participant who completed
onboarding. Opened as a plain browser link, so besides `Authorization: Bearer`
the server accepts the `blinks_token` cookie (as for `/frames/*`). GET only and
side-effect free.

| Status | Body / header | When |
|---|---|---|
| `302` | `Location: <surveys.payoutUrl>` | participant session, onboarding completed |
| `401` | `{ "error": "unauthorized" }` | no or invalid token, admin token |
| `403` | `{ "error": "onboarding required", "code": "onboarding_required" }` | onboarding not completed |
| `503` | text `Payout link is not configured.` | `payoutUrl` missing or not https |

`Cache-Control: no-store` on every response; 401/403 never carry a `Location`.
drm-web links to the same-origin `/api/payout`.

### 4.3 `GET /api/app-config` (app, after login)

- Auth: participant bearer; an admin token → `401`.

```ts
export interface AppConfigResponse {
  timezone: string;                                  // "Europe/Berlin"
  schedule: { endSessionAvailableAt: string };       // "19:00", in `timezone`
  devices: { formFactors: { key: string; displayLabel: string }[] };
  texts: {
    app: {
      recordingNotificationTitle: string;
      recordingNotificationBody: string;
      testRecordingNotificationTitle: string;
      testRecordingNotificationBody: string;
      endSessionAvailableFrom: string;               // contains "{{time}}"
      onboarding: {
        title: string;
        intro: string;
        occupationLabel: string;
        occupationPlaceholder: string;
        workDescriptionLabel: string;
        workDescriptionPlaceholder: string;
        wakeTimeLabel: string;
        bedTimeLabel: string;
      };
    };
  };
  studySettingsPin: string;                          // 4-8 digits
}
```

`endSessionAvailableAt` is evaluated in `timezone`, not in the phone's time zone.

### 4.4 Errors

| Endpoint | Status | Body | Client behaviour |
|---|---|---|---|
| study-config, app-config | `401` | `{ "error": "unauthorized" }` | token missing/invalid (app-config: also admin) → login |
| study-config, app-config | `5xx` / network | – | web: error state with retry; app: cache (4.5) |
| `/api/payout` | `401` / `403` / `503` | see 4.2 | login / onboarding / not configured |

An invalid config cannot occur at runtime: the server does not start with one.

### 4.5 Client cache and offline behaviour

Every successful response replaces the client's copy completely.

**drm-web**

- Loads `GET /api/study-config` at runtime (once per sign-in or page load) and
  renders nothing study-specific before it arrives. **No defaults in the web
  code:** a failed request shows an error with retry.
- A tab opened before a config change shows the new values after a reload.
  Web and app need no rebuild for a new config.

**App**

- Caches the last successful `GET /api/app-config` **per user**: the PIN in
  SecureStore, the rest as a file. Refreshed on sign-in, on returning to the
  foreground and when Study Settings opens. Sign-out deletes that user's cache.
- Recording never fails because of the config. **Without a cache** Study
  Settings stays locked until the config was loaded once. There is no fallback
  PIN in the code.

### 4.6 Ratings

Used by the round API (`GET/PUT /api/reconstruction/round/:round`,
`POST …/submit`) and by photo/admin responses that contain activities:

```ts
ratings: Record<string /* experienceItem.key */, number | null>;
```

1. **Response:** always contains **all** configured item keys; `null` = no answer.
2. **Request (PUT/submit):** a subset is allowed, missing keys = `null`;
   `ratings` missing = all `null`.
3. Every sent value is stored, also for items that do not apply to the
   current category (switching back keeps the answer). Only items with
   `categoryLabel ∈ appliesTo` **count**.
4. **Submit:** every item with `requiredOnSubmit: true` whose `appliesTo`
   contains the final category must be answered. A category without items
   (e.g. `other`) needs none.
5. Display order = config order. Several items per category are allowed.
6. **Merge** (web, `mergeWithNextActivity`): an item keeps its value only if both
   rows have the same value **and** the item applies to the remaining category,
   otherwise `null`. Clearing the category sets all items to `null`.
7. Short label in the read-only view: `` `${shortLabel} ${value}/${scale.max}` ``
   for the items of the final category.

Errors (`400`, `{ "error": string }`, one per request):

| Case | `error` |
|---|---|
| `ratings` not an object | `activity <i>: ratings must be an object` |
| unknown key | `activity <i>: unknown rating item "<key>"` |
| not an integer / outside the scale | `activity <i>: ratings.<key> must be an integer <min>-<max> or null` |
| required item missing on submit | `activity <i>: ratings.<key> is required to submit a <category> activity` |
| legacy field `workloadRating`/`recoveryRating` sent | `activity <i>: workloadRating is no longer supported, use ratings` |

### 4.7 Other shapes

- `GET /api/reconstruction/state`: `availableFrom: "HH:MM"` (from
  `schedule.reconstructionOpensAt`).
- Study Settings (`PUT` form factor): validated against `devices.formFactors[].key`;
  the database has no CHECK on `camera_form_factor`.
- Admin: `activity_ratings` is an admin table (table
  view and CSV download, server-side whitelist `ADMIN_TABLE_NAMES`).

## 5. Overreliance

Deliberately incorrect labels in the assisted round.

| Setting | Behaviour |
|---|---|
| `enabled: false` or `rate: 0` | no injection, no fallback; `presented_* = genuine`, `is_incorrect_annotation_injected = 0`; the notice text must be `null` |
| `enabled: true`, `rate > 0` | target `ceil(rate × valid VLM-labelled activities)` of the most confident activities with mean confidence `>= minConfidence`; never backfilled below the threshold |
| none above `minConfidence` | `fallbackToTopWhenNoneAboveThreshold: true` → the single most confident valid activity; `false` → none |

Each selected activity gets a uniformly random different activity label and a
different category for presentation. With injection active the notice text may
be a text or `null`; at least 2 categories are required.

## 6. Face blur

| `privacy.faceBlur.enabled` | Behaviour |
|---|---|
| `true` (default) | frames are stored `face_status='pending'`; the blur worker anonymizes them before they are visible or sent to the VLM |
| `false` | ingestion stores frames directly as `face_status='done'`, `face_method='disabled'`, `face_count=NULL` |

With `false`:

- **Unblurred frames reach participants, admins and the external VLM endpoint.**
  Server and `deploy.sh` print a warning.
- The blur worker processes the remaining `pending` backlog and exits with
  code 3 (`--once`: 0). The systemd unit uses `Restart=always` with
  `SuccessExitStatus=3` and `RestartPreventExitStatus=3`, so it stays stopped;
  `deploy.sh` accepts the stopped `blinks-face-blur`.
- Frames already `pending` when switching stay in the worker path.

After switching back to `true`, frames with `face_method='disabled'` stay
unblurred until `npm run requeue-unblurred-frames -- --apply` (in `server/`)
resets them to `pending`. `METHOD_TAG` is `"<method>:centerface@<threshold>"`.

## 7. Ratings storage

```sql
CREATE TABLE activity_ratings (
  activity_id INTEGER NOT NULL
    REFERENCES activities(id) ON DELETE CASCADE,
  item_key    TEXT    NOT NULL,
  value       INTEGER NOT NULL,
  PRIMARY KEY (activity_id, item_key)
);
```

- Unanswered = **no row**. The database does not check `item_key` against the
  config; the server validates on write.
- Draft PUT and submit replace the ratings of the list's activities; the
  proposal → assisted copy copies them.

**Start-up migration** (`initDb`, idempotent, no-op once done):

1. `participants` is rebuilt without the CHECK on `camera_form_factor` (own
   transaction, values unchanged).
2. If `activities.workload_rating` / `recovery_rating` exist, in **one**
   transaction: create `activity_ratings`; copy `workload_rating` →
   `mental_demand` and `recovery_rating` → `mental_recovery` (fixed keys, they
   describe the legacy data); verify the copied counts and values; rebuild
   `activities` without the two columns, keeping the ids; `PRAGMA
   foreign_key_check` must be empty, otherwise rollback.

Older code cannot start on the migrated schema; a rollback needs the
pre-migration database snapshot (`deploy/README.md`, "Rollback").
`server/scripts/check-ratings-migration-copy.ts` dry-runs the migration on a
copy of a database.

## 8. Camera capture interval

The capture interval is not part of the study config. It is the firmware
constant `CAPTURE_INTERVAL_MS` in `camera-firmware/camera-firmware.ino`
(necklace, 15000 ms) and `glasses-camera-firmware/glasses-camera-firmware.ino`
(glasses, 30000 ms); change it there and reflash the camera.
