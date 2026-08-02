# VLM scene-understanding worker (5-minute chunks)

Labels **5-minute chunks**: the Node server groups frames into clock-aligned
5-minute windows at ingestion (`chunks` table in `recordings.db`), and this
worker sends each completed chunk's frames to a Vision Language Model in ONE
multi-image call. The model returns complete verbalized probability
distributions over the closed activity and category vocabularies. The worker
derives both labels by deterministic argmax and writes the distributions,
argmax probabilities, and labels onto the chunk row. Frames inherit their
chunk's label in server-side segmentation; the frame table does not duplicate
VLM output.

For the **DRM subproject** it additionally classifies every chunk into
`work | break | other` (`vlm_category`) and picks the activity label from a
curated vocabulary (`ACTIVITY_VOCABULARY`), conditioned on the participant's
occupation + work description. See "What it writes" and "Occupation context"
below.

It is a **separate long-lived Python process**, never inline with WS ingestion —
same rule as the face-blur worker. VLM latency or API errors can never cost a
frame, and old days can be re-processed later with a better model or prompt.

## How it fits the pipeline

```
camera → BLE → phone → WS → server    frames row (face_status=pending)
                              │       + chunks row (status='filling')
                              │
              a later-window frame arrives, or the idle sweep fires
                              ▼
                        chunk status='ready'
                              │
                              ▼
                        face-blur worker   → face_status='done' (per frame)
                              │
                              ▼
                        [this worker]      chunk ready → processing → done|failed
```

**The ordering gate is a column, not a lock.** All workers run as independent
daemons in parallel. This one only ever claims a chunk when `status='ready'`
AND none of its frames is still `face_status` `pending`/`processing`, so the
VLM **provably never sees an un-anonymized face** — important because the
model is a remote API. One chunk can be in VLM inference while the next is
still being face-blurred (pipeline parallelism).

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
.venv/bin/python vlm_worker.py --max 50   # stop after 50 chunks (testing)
```

Offline output-contract test (does not need the API client or a key):

```bash
python3 -m unittest test_vlm_contract.py
```

The worker reads `recordings.db` and the JPEGs written by the Node server, so it
must run on the same host. It only claims chunks whose frames are all through
the face-blur worker.

## Config (environment variables)

| Variable | Default | Meaning |
|---|---|---|
| `KIT_API_KEY` | *(required)* | KIT SCC AI toolbox API key |
| `KIT_BASE_URL` | `https://ki-toolbox.scc.kit.edu/api/v1` | OpenAI-compatible base URL |
| `VLM_MODEL` | `kit.gemma4-31b-it` | model name |
| `RECORDINGS_DIR` | `../recordings` | recordings tree (matches the server's env) |
| `RECORDINGS_DB` | `<RECORDINGS_DIR>/recordings.db` | the SQLite index |
| `VLM_TIMEOUT` | `120` | per-request timeout (s; multi-image requests are bigger) |
| `VLM_TEMPERATURE` | `0.0` | sampling temperature; deterministic by default for the probability-elicitation contract |
| `VLM_MAX_RETRIES` | `3` | retries per chunk on API/parse error before marking `failed` |
| `VLM_CHUNK_MAX_FRAMES` | `20` | frames sent per chunk, evenly sampled across the window (a full window at the 15 s study interval) |
| `POLL_INTERVAL_S` | `3.0` | sleep between polls when the queue is empty |
| `BATCH_SIZE` | `8` | chunks claimed per poll |
| `VLM_CONCURRENCY` | `8` | endpoint calls in flight at once (in-process thread pool) |
| `DRM_TZ` | `Europe/Berlin` | study timezone for current-day-first ordering (match the server) |

### Claim ordering (current-day-first)

Chunks are claimed **today-first** (today in `DRM_TZ`) so an evening
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
process would double-process chunks (the claim is a non-atomic
select-then-update) and its startup reclaim would reset the first process's
in-flight chunks. If you ever truly need multiple processes, first switch to an
atomic claim (`UPDATE ... WHERE status='ready' ... RETURNING`) and a
time-based reclaim.

## Probability-elicitation prompt

The prompt adapts the incremental elicitation approach from Wang et al.,
*Calibrating Verbalized Probabilities for Large Language Models*
(arXiv:2410.06707v1): first determine the most likely label, then assess its
confidence, then return the complete distribution, and finally constrain the
answer to the requested structured output. These are instructions for the
model to follow internally, not a request to expose chain-of-thought.

Unlike the paper's Python-dictionary examples, this worker uses the API's
strict JSON Schema. Schematically (the activity dictionary below is
abbreviated), the model returns:

```jsonc
{
  "activity_probabilities": {
    "computer_or_monitor_use": 0.82,
    // one numeric entry for each of the other 16 exact activity keys
  },
  "category_probabilities": {
    "work": 0.87,
    "break": 0.04,
    "other": 0.09
  }
}
```

The worker, rather than the model response, selects the activity and category
argmax. Like the paper's classification examples, the constrained model
response contains only the probability distributions.

This paper supports the **verbalized-probability prompting method**, not a
claim that the resulting values are calibrated probabilities and not the
validity of the overreliance intervention or its exploratory `0.8` threshold.
The paper studies text LLM classification, so using the method with this VLM
must be evaluated empirically. A calibrated-probability claim would require a
labelled validation set and post-hoc calibration. In particular, do not apply
softmax or temperature scaling directly to these already normalized values;
the paper first reconstructs logits with an inverse-softmax step.

## What it writes (`chunks` columns)

- `status`: `ready → processing → done` (or `failed` after retries)
- `vlm_model`: the model name, so every pass is traceable
- `vlm_label`: the deterministic argmax of the activity distribution, exactly
  one of the 17 closed enum keys in `ACTIVITY_VOCABULARY`
  (`vlm_worker.py`). `other` covers a visible activity outside the vocabulary;
  `unclear` means the images are insufficient.
- `vlm_category`: the deterministic argmax of the category distribution:
  `work | break | other` (DRM subproject).
  Semantics: `work` = the participant's own occupation work (their occupation
  + work description provide the context); `break` = intentional restorative
  pause ("erholsame Pause": coffee, resting, deliberate walk, socializing to
  recover); `other` = neither work nor restorative (chores, personal
  administration, travel, or other non-restorative activity).
- `vlm_activity_confidence`: the maximum activity probability.
- `vlm_activity_confidences_json`: a normalized dictionary containing one
  verbalized probability for every activity label.
- `vlm_category_confidence`: the maximum category probability.
- `vlm_category_confidences_json`: a normalized dictionary containing one
  verbalized probability for each of `work`, `break`, and `other`.
- Both distributions require their exact key sets, finite values in `[0, 1]`,
  and an approximate sum of 1. Accepted rounding is normalized exactly before
  persistence. These black-box self-assessments are not logits or calibrated
  probabilities.

The **Node server owns the `chunks` migration** (`server/src/db.ts` `initDb`).
If the table is missing (server not yet deployed/restarted with the chunk
rework), the worker refuses to start with a clear message instead of failing
every chunk.

The activity vocabulary is a closed, study-specific observational taxonomy.
Purpose is deliberately excluded from the activity enum and inferred only in
the independent category. JSON-schema constrained decoding plus local
validation rejects missing, extra, malformed, or non-normalized distributions.

## Occupation context

The `work` category is relative to the participant's own job, so the prompt
includes their **occupation + work description** from the `participants` table
in `recordings.db` (written by the Node server via `PUT /api/profile`; queried
once per participant per batch). If the table, the row, or the values are
missing, the prompt states the occupation is unknown — the worker never crashes
over it. Chunks processed before a participant filled in their profile keep the
occupation-less classification; requeue them (`UPDATE chunks SET
status='ready' WHERE participant='...' AND status IN ('done','failed')`) if you
want them re-classified with context.

## Operational notes

- **Single-worker assumption:** on startup, any chunk left in `processing`
  (from a crash) is reclaimed to `ready`. If you run more than one VLM worker
  at once, switch to a time-based reclaim instead, or they will fight over the
  same chunks.
- **`failed` chunks** never get a label (their frames stay served, since they
  are already anonymized). They remain countable through `chunks.status` and
  bootstrap as blank activity rows in the assisted reconstruction. Periodically
  requeue them — `UPDATE chunks SET status='ready' WHERE status='failed'` —
  once the cause (transient API outage, etc.) is gone.
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
