# Study config

One YAML file holds every study setting: activity labels and categories,
rating items, windowing, capture intervals, schedule, VLM model and prompts,
overreliance injection, face blur, reminders, texts, links and the app PIN.
The server, the VLM worker, the face-blur worker, the app and the DRM website
all read the same file. Fields, validation rules and endpoints are documented
in [`docs/study-config-documentation.md`](../docs/study-config-documentation.md).

| File                        | Purpose                                                                             |
| --------------------------- | ----------------------------------------------------------------------------------- |
| `study.example.yaml`        | paper default; tracked; dummy links and PIN `0000`, **never used in production**    |
| `study.test.yaml`           | a deliberately different study for tests (5 labels, 3 items, `[TEST]` texts)        |
| `study-config.schema.json`  | JSON Schema generated from the zod schema (editor support, Python validation)       |
| `study.yaml`                | the real study; **gitignored**, created per deployment, not a symlink               |

## Which file is used

1. `BLINKS_STUDY_CONFIG` (absolute, or relative to the process's working directory)
2. `config/study.yaml`
3. `config/study.example.yaml`, only outside production, with a
   `WARNING: using config/study.example.yaml ...` log line

Production is `NODE_ENV=production` (server) or `BLINKS_ENV=production` /
`NODE_ENV=production` (Python workers). There, a missing file or the example
file is a fatal error. Every process loads the file once at start-up; after an
edit, restart the services (`deploy.sh` does that).

An invalid file stops the process with exit code 2 and one line per problem
(`path.to.field: reason`, e.g. `experienceItems.0.scale: min must be smaller than max`).

## Setting up a new study

```bash
cp config/study.example.yaml config/study.yaml
$EDITOR config/study.yaml
```

Check at least:

- `study.name`, `study.timezone` (IANA, e.g. `Europe/Berlin`)
- `activities` / `categories`: keys are stored in the database. Do not rename
  or remove keys while a study is running; add new ones instead.
- `experienceItems`: keys, scales, `requiredOnSubmit`, `appliesTo`. Ratings
  are stored per item key (`activity_ratings`).
- `windowing.windowMinutes`: must divide 60 and every UTC offset of
  `study.timezone`; otherwise start-up stops with exit 2 and lists the allowed
  values. Europe/Berlin: 1, 2, 3, 4, 5, 6, 10, 12, 15, 20, 30, 60. Time zones
  with a half-hour offset (e.g. Asia/Kolkata) allow at most 30.
- `schedule.reconstructionOpensAt` / `endSessionAvailableAt` (study time zone)
- `vlm.model`, `vlm.prompts` (placeholders: see the study config documentation, section 3)
- `overreliance.enabled` / `rate`: needs at least 2 categories when it
  injects. `rate: 0` means never inject (no fallback label either), exactly
  like `enabled: false`; in both cases
  `texts.rounds.assistedReminderIncorrectLabelsNotice` must be `null`.
- `privacy.faceBlur.enabled`: see "Face blur off" below before switching it off.
- `surveys.*` and `texts.*` links: real URLs. `deploy.sh` refuses
  `example.org` / `example.com` links.
- `app.studySettingsPin`: a new PIN per study. In production the loaders
  (server and both workers) and `deploy.sh` refuse the placeholder PIN from
  `study.example.yaml`, as well as
  `example.org`/`example.com` survey/payout links. The file is not public, but it
  is not a secret store either: keep it readable only by the service user
  (`chmod 600`; `deploy.sh` warns about any group/other bits).

Validate before deploying:

```bash
cd server && npm run build
BLINKS_STUDY_CONFIG=../config/study.yaml NODE_ENV=production \
  node -e 'require("./dist/study-config")' && echo OK
```

`deploy.sh` runs the same check (plus the Python loaders in both worker venvs)
before it restarts anything.

## Face blur off (`privacy.faceBlur.enabled: false`)

Only with an ethics/GDPR basis for it. While it is off:

- new frames are stored as already anonymized (`face_method='disabled'`) and
  are shown to the participant **unblurred**;
- the same unblurred frames are sent to the **external VLM endpoint**
  (`vlm.*`), since the VLM worker only waits for `face_status='done'`;
- the server and `deploy.sh` log a warning, `blinks-face-blur` finishes the
  pending backlog and stops (exit 3, not restarted).

Switching it back on only affects new frames. Frames stored while it was off
**stay unblurred** until they are requeued:

```bash
cd server
npx tsx scripts/requeue-unblurred-frames.ts           # count (dry run)
npx tsx scripts/requeue-unblurred-frames.ts --apply   # after enabled: true + deploy
```

Requeued frames are hidden until `blinks-face-blur` has processed them. VLM
labels already computed from the unblurred frames are not changed.

## Analysis notes

- Ratings are stored per item key in `activity_ratings`. Values for items whose
  `appliesTo` does not include the activity's final category can exist (the
  editor keeps a value when the category is changed afterwards, and the
  `activity_ratings` migration carried such legacy values over). The API
  returns them, so filter by `appliesTo` and the final `category_label` in the
  analysis.

## Changing the schema

The zod schema in `server/src/study-config/schema.ts` is the source of truth.
After changing it, run `npm run generate-study-config-schema` and
`npm run test-study-config-schema` in `server/`, and update
`docs/study-config-documentation.md`.

## Configuring a new study (quick guide)

Short walkthrough. Details are above and in the study config documentation
([`docs/study-config-documentation.md`](../docs/study-config-documentation.md)).

### 1. Create the file

```bash
cp config/study.example.yaml config/study.yaml   # study.yaml is gitignored
chmod 600 config/study.yaml
$EDITOR config/study.yaml
```

Never use `study.example.yaml` or `study.test.yaml` for a real study.

### 2. Where each block shows up

| YAML block | Effect in the web app (DRM website) and the app |
|---|---|
| `study.timezone` | times shown in the web app, evening gate, end-session time in the app |
| `ui.locale`, `ui.thumbnailsPerActivity` | date/time format in the web app, number of preview images per activity in round 2 |
| `windowing.windowMinutes` | grid in "Adjust times" and texts ("five-minute"/"ten-minute"), admin label of the chunks. Must divide 60 and every UTC offset of the time zone (Berlin: 1, 2, 3, 4, 5, 6, 10, 12, 15, 20, 30, 60), otherwise the server does not start |
| `activities[].displayLabel` | "Activity" dropdown in both rounds |
| `categories[]` (`displayLabel`, `icon`, `description`) | "Activity type" selection and the "Categories" legend. Allowed icons: `briefcase, pause, ellipsis, coffee, users, house, book-open, heart, circle` |
| `experienceItems[]` | one rating scale per item and category (`appliesTo`), scale `min..max`, anchors, required on submit (`requiredOnSubmit`), short label in the summary ("Mental demand 4/7") |
| `texts.rounds`, `texts.progress` | intro, reminder and hint texts of the rounds, step labels at the top. `assistedReminderIncorrectLabelsNotice: null` hides the notice about incorrect labels. Without injection (`overreliance.enabled: false` or `rate: 0`) it must be `null`, otherwise the server does not start |
| `overreliance.*` | deliberately incorrect labels in round 2 (admin column `is_incorrect_annotation_injected`). `rate: 0` means never inject, no fallback label either. Injection needs at least 2 categories |
| `surveys.onboarding/final` | survey links including the participant parameter (`participantParameter`) |
| `surveys.payoutUrl` | target of `/api/payout` ("Payout" link on the survey page). Redirects only when signed in with completed onboarding, otherwise 401/403 |
| `devices.formFactors` | "Camera type" selection in the app's Study Settings |
| `schedule.endSessionAvailableAt` | when "End session" becomes available in the app (study time zone) |
| `texts.app` | notification and onboarding texts of the app, "Available from {{time}}" |
| `app.studySettingsPin` | Study Settings PIN (4–8 digits). **Set a new one for every study**. Production refuses the placeholder PIN |

Important: the `key` values (activities, categories, items, form factors) are
stored in the database. Do not rename or remove them during a running study;
only add new ones. Display texts (`displayLabel`, questions, texts) may change.

### 3. Check locally

```bash
cd server && npm run build
BLINKS_STUDY_CONFIG=../config/study.yaml node -e 'require("./dist/study-config")' && echo OK
```

To click through, start a server with its own data directories. To open the
evening gate, use a copy with `reconstructionOpensAt: "00:00"`:

```bash
sed 's/reconstructionOpensAt: "[0-9:]*"/reconstructionOpensAt: "00:00"/' \
  ../config/study.yaml > /tmp/study.local.yaml
BLINKS_STUDY_CONFIG=/tmp/study.local.yaml DATA_DIR=/tmp/new/data \
  RECORDINGS_DIR=/tmp/new/rec DISABLE_PUSH=1 npm run dev
# second terminal
cd drm-web && npm run dev    # http://localhost:3002
```

The web app and the app need **no new build** for a new config; they load the
values at runtime. `config/study.test.yaml` shows what a completely different
study looks like (5 labels, 2 categories, 3 items, 10-minute window, texts
with "[TEST]").

### 4. Roll out

1. Put `config/study.yaml` on the server; `deploy.sh` validates it and
   restarts the services.
2. **Do not deploy during an evening reconstruction.** The web app loads the
   config once per sign-in or page load. An open tab shows the new values only
   after a reload. A tab still running a web version that sends the legacy
   fields `workloadRating`/`recoveryRating` gets `400` on save and must be
   reloaded.
3. App: every phone must **sign in online once** after the change (or open
   Study Settings while connected). Only then is the PIN known. Before that,
   Study Settings is locked. Afterwards everything also works offline from the
   cache. Signing out deletes that user's cache.

The capture interval is not part of the study config: it is the firmware
constant `CAPTURE_INTERVAL_MS` in `camera-firmware/camera-firmware.ino`
(necklace, 15000 ms) and `glasses-camera-firmware/glasses-camera-firmware.ino`
(glasses, 30000 ms).
