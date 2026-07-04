# VLM scene-understanding worker

Reads face-anonymized frames from `recordings.db`, sends each to a Vision
Language Model, and writes a per-image **scene-state descriptor** + label +
description back to the row. This is the context layer the biosignal study aligns
against and the source of change-point-detection features.

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

## What it writes (existing `vlm_*` columns)

- `vlm_status`: `pending → processing → done` (or `failed` after retries)
- `vlm_model`: the model name, so every pass is traceable
- `vlm_label`: 2-5 word activity summary (shown in the app's History)
- `vlm_description`: one short sentence
- `vlm_descriptor`: JSON of the scene-state dimensions —
  `posture, movement, screen_engagement, object_manipulation, proximity, social_interaction`

The descriptor enums (in `vlm_worker.py`, `DESCRIPTOR_ENUMS`) are a **v1 starting
point** — refine the taxonomy for the study as needed. They are deliberately
small closed vocabularies (plus `unknown`) so the output is stable enough for
downstream change-point detection.

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
