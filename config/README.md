# Study config

One YAML file holds every study setting: activity labels and categories,
rating items, windowing, capture intervals, schedule, VLM model and prompts,
overreliance injection, face blur, reminders, texts, links and the app PIN.
The server, the VLM worker, the face-blur worker, the app and the DRM website
all read the same file. The full contract (fields, invariants, endpoints) is
in [`docs/study-config-contract.md`](../docs/study-config-contract.md).

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
- `experienceItems`: keys, scales, `required`, `appliesToCategories`. Ratings
  are stored per item key (`activity_ratings`).
- `capture.intervalMsByFormFactor`: at least 5000 ms (firmware lower bound);
  the app sends the interval to the camera on every connect.
- `schedule.reconstructionOpensAt` / `endSessionAvailableAt` (study time zone)
- `vlm.model`, `vlm.prompts` (placeholders: see the contract)
- `overreliance.enabled` / `rate`: needs at least 2 categories when enabled.
  `rate: 0` disables only the rate-based selection; with
  `fallbackToTopWhenNoneAboveThreshold: true` one label per day is still
  injected when no activity reaches `minConfidence`. To inject nothing, set
  `enabled: false`.
- `privacy.faceBlur.enabled`: see "Face blur off" below before switching it off.
- `surveys.*` and `texts.*` links: real URLs. `deploy.sh` refuses
  `example.org` / `example.com` links.
- `app.studySettingsPin`: a new PIN per study. In production the loaders
  (server and both workers) and `deploy.sh` refuse the placeholder PIN from
  `study.example.yaml` and the retired pre-config PIN, as well as
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
`npm run test-study-config-schema` in `server/`, and update the contract doc.
