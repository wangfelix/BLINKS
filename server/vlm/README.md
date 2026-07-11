# VLM scene-understanding worker

Reads face-anonymized frames from `recordings.db`, sends each to a Vision
Language Model, and writes a per-image **scene-state descriptor** + label +
description back to the row. This is the context layer the biosignal study aligns
against and the source of change-point-detection features.

For the **DRM subproject** it additionally classifies every frame into
`work | break | other` (`vlm_category`) and picks the activity label from a
curated vocabulary (`ACTIVITY_VOCABULARY`), conditioned on the participant's
occupation + work description. See "What it writes" and "Occupation context"
below.

It is a **separate long-lived Python process**, never inline with WS ingestion —
same rule as the face-blur worker. VLM latency or API errors can never cost a
frame, and old sessions can be re-processed later with a better model or prompt.

## How it fits the pipeline

```
camera → BLE → phone → WS → server   (row: face_status=pending, vlm_status=pending)
                              │
                              ▼
                        face-blur worker   → face_status='done'
                              │
                              ▼
                        [this worker]      vlm_status pending → processing → done
```

**The ordering gate is a column, not a lock.** Both workers run as independent
daemons in parallel. This one only ever selects frames with
`vlm_status='pending' AND face_status='done'`, so the VLM **provably never sees
an un-anonymized face** — important because the model is a remote API. A frame
can be in VLM inference while the next frame is still being face-blurred
(pipeline parallelism).

## Model: KIT SCC AI toolbox

OpenAI-compatible endpoint (`https://ki-toolbox.scc.kit.edu/api/v1`), the same
service and key the sibling KARMA project uses. Default model
**`kit.gemma4-31b-it`** (Gemma is the vision-capable model exposed over the API).
The endpoint is **KIT-hosted**, so even the anonymized frames stay inside KIT
infrastructure rather than going to a public cloud.

## Setup

```bash
cd server/vlm
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt
cp .env.example .env          # then put the real KIT_API_KEY in .env
```

`.env` is gitignored. The worker auto-loads it; systemd can inject the same vars
via `EnvironmentFile=` instead (see below).

## Run

```bash
.venv/bin/python vlm_worker.py            # daemon: poll forever (production)
.venv/bin/python vlm_worker.py --once     # process the current backlog, then exit
.venv/bin/python vlm_worker.py --max 50   # stop after 50 frames (testing)
```

The worker reads `recordings.db` and the JPEGs written by the Node server, so it
must run on the same host. It only processes frames the face-blur worker has
already marked `done`.

## Config (environment variables)

| Variable | Default | Meaning |
|---|---|---|
| `KIT_API_KEY` | *(required)* | KIT SCC AI toolbox API key |
| `KIT_BASE_URL` | `https://ki-toolbox.scc.kit.edu/api/v1` | OpenAI-compatible base URL |
| `VLM_MODEL` | `kit.gemma4-31b-it` | model name |
| `RECORDINGS_DIR` | `../recordings` | recordings tree (matches the server's env) |
| `RECORDINGS_DB` | `<RECORDINGS_DIR>/recordings.db` | the SQLite index |
| `VLM_TIMEOUT` | `60` | per-request timeout (s) |
| `VLM_TEMPERATURE` | `0.1` | sampling temperature |
| `VLM_MAX_RETRIES` | `3` | retries per frame on API/parse error before marking `failed` |
| `POLL_INTERVAL_S` | `3.0` | sleep between polls when the queue is empty |
| `BATCH_SIZE` | `20` | rows claimed per poll |
| `VLM_CONCURRENCY` | `8` | endpoint calls in flight at once (in-process thread pool) |
| `DRM_TZ` | `Europe/Berlin` | study timezone for current-day-first ordering (match the server) |

### Claim ordering (current-day-first)

Frames are claimed **today-first** (today in `DRM_TZ`) so an evening
reconstruction is never stuck behind days of catch-up; within the backlog it's
oldest-first, so the oldest still-incomplete day is what finishes next. If TZ
data is unavailable it degrades to newest-first (still today-before-older).

### Throughput / concurrency

The endpoint calls are I/O-bound, so the worker runs up to `VLM_CONCURRENCY`
of them in parallel within the single process (a thread pool). Only the network
calls run in threads; every DB read/write stays on the main thread (a `sqlite3`
connection is not shareable across threads), so the batch claim stays atomic and
there are no concurrent-write hazards. The KIT Gemma endpoint was measured to
parallelize cleanly with no rate-limit wall or latency penalty at 8 concurrent.

**Scale with `VLM_CONCURRENCY`, not by launching multiple processes.** A second
process would double-process rows (the claim is a non-atomic select-then-update)
and its startup reclaim would reset the first process's in-flight rows. If you
ever truly need multiple processes, first switch to an atomic claim
(`UPDATE ... WHERE vlm_status='pending' ... RETURNING`) and a time-based reclaim.

## What it writes (`vlm_*` columns)

- `vlm_status`: `pending → processing → done` (or `failed` after retries)
- `vlm_model`: the model name, so every pass is traceable
- `vlm_label`: the model's `"activity"` — the closest entry from
  `ACTIVITY_VOCABULARY` (in `vlm_worker.py`), or a concise 2-4 word label the
  model coins when nothing in the list fits
- `vlm_category`: `work | break | other` (DRM subproject). Anything the model
  returns outside those three values is coerced to `other`. Semantics: `work` =
  the participant's own occupation work (their occupation + work description
  provide the context); `break` = intentional restorative pause ("erholsame
  Pause": coffee, resting, deliberate walk, socializing to recover); `other` =
  neither work nor restorative (chores, answering the door, errands, possibly
  cooking).
- `vlm_description`: one short sentence
- `vlm_descriptor`: JSON of the scene-state dimensions —
  `posture, movement, screen_engagement, object_manipulation, proximity, social_interaction`

The **Node server owns the `vlm_category` migration** (`server/src/db.ts`
`initDb`). If the column is missing (server not yet deployed/restarted with the
DRM migration), the worker refuses to start with a clear message instead of
failing every frame.

The descriptor enums (`DESCRIPTOR_ENUMS`) and the activity vocabulary
(`ACTIVITY_VOCABULARY`) in `vlm_worker.py` are a **v1 starting point** —
**review and extend the activity vocabulary before the study** (it drives label
consistency across participants and days) and refine the descriptor taxonomy as
needed. They are deliberately small closed vocabularies so the output is stable
enough for downstream analysis, with graceful escapes (`unknown` for descriptor
dimensions, a coined label for activities).

## Occupation context

The `work` category is relative to the participant's own job, so the prompt
includes their **occupation + work description** from the `participants` table
in `recordings.db` (written by the Node server via `PUT /api/profile`; queried
once per participant per batch). If the table, the row, or the values are
missing, the prompt states the occupation is unknown — the worker never crashes
over it. Frames processed before a participant filled in their profile keep the
occupation-less classification; requeue them (`UPDATE frames SET
vlm_status='pending' WHERE participant='...'`) if you want them re-classified
with context.

## Operational notes

- **Single-worker assumption:** on startup, any row left in `processing` (from a
  crash) is reclaimed to `pending`. If you run more than one VLM worker at once,
  switch to a time-based reclaim instead, or they will fight over the same rows.
- **`failed` frames** never get a label (and stay served, since they are already
  anonymized). Periodically requeue them — `UPDATE frames SET vlm_status='pending'
  WHERE vlm_status='failed'` — once the cause (transient API outage, etc.) is gone.
- Reachability: the toolbox must be reachable from the host. On the KIT VM both
  are inside KIT, so it should resolve directly; verify with a quick `--once` run.

## systemd (KIT VM)

`/etc/systemd/system/blinks-vlm.service`:

```ini
[Unit]
Description=BLINKS VLM scene-understanding worker
After=blinks.service

[Service]
WorkingDirectory=/root/BLINKS/server/vlm
ExecStart=/root/BLINKS/server/vlm/.venv/bin/python vlm_worker.py
EnvironmentFile=/root/BLINKS/server/vlm/.env
Environment=RECORDINGS_DIR=/root/BLINKS/server/recordings
Restart=always
RestartSec=10

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now blinks-vlm
sudo journalctl -u blinks-vlm -f
```
