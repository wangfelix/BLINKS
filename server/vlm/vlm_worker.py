#!/usr/bin/env python3
"""
BLINKS VLM scene-understanding worker (5-minute-chunk mode).

Polls recordings.db for CHUNKS that are ready for inference and labels each
whole chunk with one VLM call. A chunk is a clock-aligned 5-minute window of
frames, assembled by the Node server at ingestion:

    camera -> BLE -> phone -> WS -> server
      frames row (face=pending) + chunks row (status='filling')
                                      |
              a later-window frame arrives, or the idle sweep fires
                                      v
                            chunk status='ready'
                                      |
                                      v
                     face-blur worker finishes the chunk's frames
                                      |
                                      v
        [this worker]  chunk ready->processing->done|failed
                       writes labels and probability distributions
                       only onto the CHUNK row

Readiness gate (columns, not locks): a chunk is only claimed when
  - chunks.status = 'ready' (the server closed the window), AND
  - none of its frames is still face_status 'pending'/'processing'
so the VLM provably never sees an un-anonymized face. A chunk whose frames all
failed the blur is marked 'failed' without an API call.

Per chunk the model receives up to VLM_CHUNK_MAX_FRAMES face-anonymized frames
(evenly sampled across the window, chronological order) and returns full
verbalized probability distributions:
  - activity probabilities over all 17 keys
                              -> chunks.vlm_activity_confidences_json
  - their deterministic argmax -> chunks.vlm_label
  - that maximum probability   -> chunks.vlm_activity_confidence
  - category probabilities over work|break|other
                              -> chunks.vlm_category_confidences_json
  - their deterministic argmax -> chunks.vlm_category
  - that maximum probability   -> chunks.vlm_category_confidence
Classification is conditioned on the participant's occupation + work
description (participants table, owned by the Node server).

Same design rule as the face-blur worker: a separate long-lived process, never
inline with WS ingestion, so VLM latency / API errors can never cost a frame
and old days can be re-processed later with a better model or prompt.

Model: the KIT SCC AI toolbox, an OpenAI-compatible endpoint (same client as
the sibling KARMA project). Default model `kit.qwen3.5-397b-A17b` (Qwen3.5,
vision-capable over the API and verified with 20 VGA images per request). The
endpoint is KIT-hosted, so even the anonymized frames stay inside KIT
infrastructure rather than a public cloud.

Config (environment variables; a local .env next to this file is auto-loaded):
    KIT_API_KEY           required: KIT SCC AI toolbox API key
    KIT_BASE_URL          OpenAI-compatible base URL
                            (default: https://ki-toolbox.scc.kit.edu/api/v1)
    VLM_MODEL             model name           (default: kit.qwen3.5-397b-A17b)
    RECORDINGS_DIR        recordings tree      (default: ../recordings)
    RECORDINGS_DB         path to recordings.db (default: <RECORDINGS_DIR>/recordings.db)
    VLM_TIMEOUT           per-request timeout seconds (default: 120)
    VLM_TEMPERATURE       sampling temperature        (default: 0.0)
    VLM_MAX_ATTEMPTS      total automatic attempts per retry cycle (default: 5)
    VLM_RETRY_DELAYS_S    comma-separated delays after attempts 1..N-1
                            (default: 30,120,300,600)
    VLM_CHUNK_MAX_FRAMES  frames sent per chunk, evenly sampled (default: 20;
                            covers a full window at the 15 s study interval)
    POLL_INTERVAL_S       sleep between polls when the queue is empty (default: 3.0)
    BATCH_SIZE            maximum chunks claimed in one refill (default: 8)
    VLM_CONCURRENCY       endpoint calls in flight at once (default: 8)
    DRM_TZ                study timezone for current-day-first ordering
                            (default: Europe/Berlin; match the server's DRM_TZ)

CLI:
    python vlm_worker.py            # daemon: poll forever
    python vlm_worker.py --once     # process the current backlog, then exit
    python vlm_worker.py --max 50   # stop after N endpoint attempts (testing)

Requeue failed chunks once the cause is fixed:
    UPDATE chunks
    SET status='ready', vlm_retry_count=0, vlm_next_attempt_at=NULL,
        vlm_last_error_type=NULL
    WHERE status='failed';

Concurrency: endpoint calls are I/O-bound, so up to VLM_CONCURRENCY run in
parallel (thread pool); only the network calls run in threads — every DB
read/write stays on the main thread (a sqlite3 connection is not shareable
across threads). A completed call immediately frees a slot for another eligible
chunk; slow calls do not hold an entire fixed batch behind them.

Single-worker assumption (one PROCESS): on startup any chunk left in
'processing' (from a crash) is reclaimed to 'ready'. Scale via
VLM_CONCURRENCY, NOT by launching multiple processes.
"""

from __future__ import annotations

import argparse
import base64
import json
import math
import os
import signal
import sqlite3
import sys
import time
from concurrent.futures import FIRST_COMPLETED, Future, ThreadPoolExecutor, wait
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from zoneinfo import ZoneInfo

from dotenv import load_dotenv
from openai import OpenAI

SCRIPT_DIR = Path(__file__).resolve().parent
load_dotenv(SCRIPT_DIR / ".env")  # local dev convenience; systemd can inject env instead

# --- Config -----------------------------------------------------------------

RECORDINGS_DIR = Path(
    os.environ.get("RECORDINGS_DIR", SCRIPT_DIR.parent / "recordings")
).resolve()
RECORDINGS_DB = Path(
    os.environ.get("RECORDINGS_DB", RECORDINGS_DIR / "recordings.db")
).resolve()

KIT_API_KEY = os.environ.get("KIT_API_KEY")
KIT_BASE_URL = os.environ.get("KIT_BASE_URL", "https://ki-toolbox.scc.kit.edu/api/v1")
VLM_MODEL = os.environ.get("VLM_MODEL", "kit.qwen3.5-397b-A17b")

VLM_TIMEOUT = float(os.environ.get("VLM_TIMEOUT", "120"))
VLM_TEMPERATURE = float(os.environ.get("VLM_TEMPERATURE", "0.0"))
VLM_MAX_ATTEMPTS = max(
    1,
    int(os.environ.get("VLM_MAX_ATTEMPTS", os.environ.get("VLM_MAX_RETRIES", "5"))),
)
VLM_RETRY_DELAYS_S = tuple(
    max(0.0, float(value.strip()))
    for value in os.environ.get("VLM_RETRY_DELAYS_S", "30,120,300,600").split(",")
    if value.strip()
)
if not VLM_RETRY_DELAYS_S:
    VLM_RETRY_DELAYS_S = (30.0,)
VLM_CHUNK_MAX_FRAMES = max(1, int(os.environ.get("VLM_CHUNK_MAX_FRAMES", "20")))
POLL_INTERVAL_S = float(os.environ.get("POLL_INTERVAL_S", "3.0"))
VLM_CONCURRENCY = max(1, int(os.environ.get("VLM_CONCURRENCY", "8")))
# Study timezone, matching the server's DRM_TZ, so "today" agrees with the
# reconstruction gate. Drives current-day-first claim ordering.
DRM_TZ = os.environ.get("DRM_TZ", "Europe/Berlin")
BATCH_SIZE = int(os.environ.get("BATCH_SIZE", "8"))

CHUNK_WINDOW_MS = 5 * 60 * 1000  # keep in sync with server/src/db.ts


@dataclass(frozen=True)
class AttemptResult:
    outcome: str
    payload: dict | None
    duration_ms: int
    error_class: str | None = None
    http_status: int | None = None
    log_detail: str | None = None


@dataclass(frozen=True)
class InFlightAttempt:
    row: sqlite3.Row
    attempt_id: int

# --- Activity vocabulary -----------------------------------------------------
# Closed, visually grounded activity enum. Keep the keys synchronized with
# server/src/activity-vocabulary.ts and drm-web/src/lib/activity-vocabulary.ts.
# Intent belongs only in the independent work|break|other category.
ACTIVITY_DEFINITIONS = {
    "computer_or_monitor_use": (
        "Attention directed to a computer, laptop, tablet used as a workstation, "
        "or monitor, with visible keyboard, mouse, touch, or screen interaction."
    ),
    "watching_video": (
        "A television or video interface is visibly the sustained focus, with "
        "little active input. Do not infer this from posture alone."
    ),
    "paper_reading_writing": (
        "Reading a book or printed document, or handwriting on paper with a pen "
        "or pencil, with no screen as the focus."
    ),
    "handheld_device_use": (
        "A phone or other handheld device is held and visibly occupies attention."
    ),
    "remote_meeting": (
        "A video-conferencing interface or remote participants are visibly present "
        "on a screen. Do not infer a meeting from a headset alone."
    ),
    "phone_call": (
        "A phone is held to the ear, a visible call interface is active, or a "
        "headset is used without another visually dominant task."
    ),
    "in_person_interaction": (
        "Another person is physically present and repeatedly oriented toward or "
        "interacting with the wearer."
    ),
    "tools_or_materials": (
        "Hands manipulate tools, equipment, components, or materials, unless a "
        "more specific food, cleaning, assistance, or personal-care label applies."
    ),
    "eating_drinking": "Food or drink is visibly being consumed.",
    "food_preparation": (
        "Food or drink is being prepared, assembled, cooked, or served."
    ),
    "cleaning_household": (
        "Visible cleaning, tidying, laundry, dishes, or household maintenance."
    ),
    "assisting_person_animal": (
        "Visible physical assistance or attentive handling of another person or animal."
    ),
    "personal_care": "Visible washing, grooming, dressing, or other personal care.",
    "walking_or_movement": (
        "Walking, cycling, exercise-like motion, or another sustained body movement."
    ),
    "no_task_engagement": (
        "No specific task, object interaction, or social interaction is visibly evident."
    ),
    "other": (
        "The scene is legible, but the visible activity is outside this vocabulary."
    ),
    "unclear": (
        "The frames are too dark, obscured, blurred, sparse, or otherwise "
        "uninformative to determine the activity."
    ),
}
ACTIVITY_VOCABULARY = tuple(ACTIVITY_DEFINITIONS)

# The three-way DRM category. Off-enum output fails validation and is retried.
VLM_CATEGORIES = ("work", "break", "other")

SYSTEM_PROMPT = (
    "You analyze short sequences of frames from a body-worn (first-person) "
    "camera for a research study on knowledge work. The frames are given in "
    "chronological order and together span about five minutes. Faces in the "
    "images are intentionally pixelated for privacy; describe the scene and "
    "activity, never attempt to identify people. Judge the sequence as a "
    "whole: classify the DOMINANT activity of the window, not any single frame. "
    "Use incremental probability elicitation: first determine the most likely "
    "label, then assess its confidence, then distribute probability across every "
    "allowed label. Do this independently for activity and category. Do not reveal "
    "your reasoning or output chosen-label fields; the server derives each label "
    "from the corresponding distribution. Activity describes visible behavior "
    "only. Purpose and restorative intent belong exclusively in category."
)


def _build_user_prompt(
    occupation: str | None, work_description: str | None, frame_count: int
) -> str:
    """The per-participant user prompt (occupation context varies per participant)."""
    definitions = "\n".join(
        f'- "{key}": {definition}'
        for key, definition in ACTIVITY_DEFINITIONS.items()
    )
    occupation = (occupation or "").strip()
    work_description = (work_description or "").strip()
    if occupation:
        occupation_context = f"The camera wearer's occupation: {occupation}."
        if work_description:
            occupation_context += f" Description of their work: {work_description}."
    else:
        occupation_context = "The camera wearer's occupation is unknown."
    return (
        f"{occupation_context}\n\n"
        f"You see {frame_count} frames in chronological order spanning a "
        "5-minute window of the wearer's day. Judge the window as a whole and "
        "return the requested structured classification.\n\n"
        "Activity definitions:\n"
        f"{definitions}\n\n"
        "Follow these steps internally for activity:\n"
        "1. Determine the single most likely activity key using the definitions.\n"
        "2. Assess confidence in that choice.\n"
        "3. Return the full probability distribution over all 17 activity keys.\n"
        "Choose the most specific visibly supported activity. A specific label "
        "such as remote_meeting, phone_call, eating_drinking, or food_preparation "
        "takes precedence over a broader device or material-handling label. Base "
        "dominance on what is most consistently visible across the sequence. Do "
        "not infer activity from posture, location, clothing, or occupation alone.\n\n"
        "Follow the same steps independently for category: determine the most "
        "likely category, assess confidence, then return the full probability "
        'distribution over ["work", "break", "other"]. '
        '"work" = the wearer\'s own occupation work (their occupation and work '
        "description above provide the context for what counts as work). "
        '"break" = an intentional restorative pause ("erholsame Pause": coffee, '
        "resting, a deliberate walk, socializing to recover). "
        '"other" = neither work nor restorative (chores, personal administration, '
        "travel, or other non-restorative activity).\n"
        '  "activity_probabilities": one numeric probability from 0 to 1 for '
        "every activity key above.\n"
        '  "category_probabilities": one numeric probability from 0 to 1 for '
        "each category.\n"
        "Each distribution must sum to 1. Use at least two decimal places of "
        "precision where useful rather than limiting scores to tenths.\n"
        "Return only the JSON object required by the response schema, with no "
        "reasoning, selected-label fields, or additional text."
    )


_shutdown = False


def _log(msg: str) -> None:
    print(f"[vlm] {msg}", flush=True)


def _handle_signal(signum, _frame) -> None:
    global _shutdown
    _shutdown = True
    _log(f"received signal {signum}, finishing current chunk then exiting")


# --- Model call -------------------------------------------------------------

def _extract_json_object(text: str) -> dict:
    """Parse the first {...} object out of a model response.

    Tolerates ```json fences and leading/trailing prose by slicing from the
    first '{' to the last '}'.
    """
    start = text.find("{")
    end = text.rfind("}")
    if start == -1 or end == -1 or end <= start:
        raise ValueError(f"no JSON object in response: {text[:200]!r}")
    return json.loads(text[start : end + 1])


def _normalize_distribution(
    raw: object, labels: tuple[str, ...], field_name: str
) -> dict[str, float]:
    """Validate and exactly normalize one verbalized probability distribution."""
    if not isinstance(raw, dict):
        raise ValueError(f"{field_name} must be an object")
    if set(raw) != set(labels):
        raise ValueError(f"{field_name} must contain exactly every allowed label")
    probabilities: dict[str, float] = {}
    for label in labels:
        value = raw[label]
        if isinstance(value, bool) or not isinstance(value, (int, float)):
            raise ValueError(f"probability for {label!r} must be numeric")
        value = float(value)
        if not math.isfinite(value) or value < 0 or value > 1:
            raise ValueError(f"probability for {label!r} must be between 0 and 1")
        probabilities[label] = value
    probability_sum = sum(probabilities.values())
    if not math.isclose(probability_sum, 1.0, abs_tol=0.02):
        raise ValueError(
            f"{field_name} must sum approximately to 1, got {probability_sum}"
        )
    # Accept harmless model rounding, then persist an exactly normalized vector.
    return {
        label: value / probability_sum for label, value in probabilities.items()
    }


def _normalize(raw: dict) -> dict:
    """Validate distributions, then derive both labels by deterministic argmax."""
    activity_probabilities = _normalize_distribution(
        raw.get("activity_probabilities"),
        ACTIVITY_VOCABULARY,
        "activity_probabilities",
    )
    category_probabilities = _normalize_distribution(
        raw.get("category_probabilities"),
        VLM_CATEGORIES,
        "category_probabilities",
    )
    activity = max(
        ACTIVITY_VOCABULARY, key=lambda label: activity_probabilities[label]
    )
    category = max(VLM_CATEGORIES, key=lambda label: category_probabilities[label])
    return {
        "activity": activity,
        "category": category,
        "activity_confidence": activity_probabilities[activity],
        "activity_confidences": activity_probabilities,
        "category_confidence": category_probabilities[category],
        "category_confidences": category_probabilities,
    }


VLM_RESPONSE_FORMAT = {
    "type": "json_schema",
    "json_schema": {
        "name": "vlm_chunk_classification",
        "strict": True,
        "schema": {
            "type": "object",
            "properties": {
                "activity_probabilities": {
                    "type": "object",
                    "properties": {
                        label: {"type": "number", "minimum": 0, "maximum": 1}
                        for label in ACTIVITY_VOCABULARY
                    },
                    "required": list(ACTIVITY_VOCABULARY),
                    "additionalProperties": False,
                },
                "category_probabilities": {
                    "type": "object",
                    "properties": {
                        label: {"type": "number", "minimum": 0, "maximum": 1}
                        for label in VLM_CATEGORIES
                    },
                    "required": list(VLM_CATEGORIES),
                    "additionalProperties": False,
                },
            },
            "required": [
                "activity_probabilities",
                "category_probabilities",
            ],
            "additionalProperties": False,
        },
    },
}


def sample_evenly(items: list, max_count: int) -> list:
    """Up to max_count items spread evenly across the list (endpoints kept)."""
    if len(items) <= max_count:
        return items
    if max_count == 1:
        return [items[0]]
    return [
        items[round(slot * (len(items) - 1) / (max_count - 1))]
        for slot in range(max_count)
    ]


def infer(client: OpenAI, images: list[bytes], user_prompt: str) -> dict:
    """One multi-image VLM call -> normalized chunk result. Raises on failure."""
    content: list[dict] = [{"type": "text", "text": user_prompt}]
    for image_bytes in images:
        b64 = base64.b64encode(image_bytes).decode("ascii")
        content.append(
            {
                "type": "image_url",
                "image_url": {"url": f"data:image/jpeg;base64,{b64}"},
            }
        )
    response = client.chat.completions.create(
        model=VLM_MODEL,
        temperature=VLM_TEMPERATURE,
        messages=[
            {"role": "system", "content": SYSTEM_PROMPT},
            {"role": "user", "content": content},
        ],
        response_format=VLM_RESPONSE_FORMAT,
    )
    text = response.choices[0].message.content or ""
    return _normalize(_extract_json_object(text))


# --- DB ---------------------------------------------------------------------

def _connect() -> sqlite3.Connection:
    conn = sqlite3.connect(str(RECORDINGS_DB), timeout=30.0)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    conn.execute("PRAGMA journal_mode = WAL")
    conn.execute("PRAGMA synchronous = NORMAL")
    conn.execute("PRAGMA busy_timeout = 5000")
    return conn


def _ensure_chunks_table(conn: sqlite3.Connection) -> bool:
    """Fail fast, with a clear message instead of a stack trace, if the chunks
    table is missing.

    The Node server owns the migration (server/src/db.ts initDb creates the
    table on startup); this worker only reads/updates rows. Returns False when
    the frames table itself does not exist yet (fresh DB, server not started)
    so the caller keeps polling instead of dying.
    """
    frames_columns = {row[1] for row in conn.execute("PRAGMA table_info(frames)")}
    if not frames_columns:
        return False  # no frames table yet; the normal "db not ready" path applies
    chunk_columns = {row[1] for row in conn.execute("PRAGMA table_info(chunks)")}
    if not chunk_columns:
        _log(
            "FATAL: the chunks table is missing in recordings.db. "
            "The Node server owns this migration (server/src/db.ts initDb) - "
            "deploy and start the updated server once so it creates the table, "
            "then restart this worker."
        )
        sys.exit(2)
    required_columns = {
        "vlm_activity_confidence",
        "vlm_activity_confidences_json",
        "vlm_category_confidence",
        "vlm_category_confidences_json",
        "vlm_attempt_count",
        "vlm_retry_count",
        "vlm_next_attempt_at",
        "vlm_last_error_type",
    }
    missing_columns = required_columns - chunk_columns
    if missing_columns:
        _log(
            "FATAL: recordings.db is missing the new chunk confidence columns "
            f"{sorted(missing_columns)}. Start the updated Node server once to "
            "run its migration, then restart this worker."
        )
        sys.exit(2)
    if not conn.execute(
        "SELECT 1 FROM sqlite_master WHERE type='table' AND name='vlm_attempts'"
    ).fetchone():
        _log(
            "FATAL: recordings.db is missing the vlm_attempts audit table. "
            "Start the updated Node server once to run its migration, then "
            "restart this worker."
        )
        sys.exit(2)
    return True


def _fetch_participant_context(
    conn: sqlite3.Connection, participant: str
) -> tuple[str | None, str | None]:
    """(occupation, work_description) from the participants table.

    The table is owned by the Node server; treat any schema error, a missing
    row, or NULL columns as "occupation unknown" instead of crashing.
    """
    try:
        row = conn.execute(
            "SELECT occupation, work_description FROM participants WHERE username = ?",
            (participant,),
        ).fetchone()
    except sqlite3.OperationalError:
        return (None, None)  # participants table not migrated in yet
    if row is None:
        return (None, None)
    return (row["occupation"], row["work_description"])


def _reclaim_stale_processing(conn: sqlite3.Connection) -> int:
    """Record interrupted attempts and immediately requeue their chunks."""
    now_ms = int(time.time() * 1000)
    with conn:
        conn.execute(
            """
            UPDATE vlm_attempts
            SET completed_at = ?,
                duration_ms = MAX(0, ? - started_at),
                outcome = 'interrupted',
                error_class = 'WorkerInterrupted'
            WHERE outcome IS NULL
            """,
            (now_ms, now_ms),
        )
        info = conn.execute(
            """
            UPDATE chunks
            SET status = 'ready', vlm_next_attempt_at = ?,
                vlm_last_error_type = 'interrupted', updated_at = ?
            WHERE status = 'processing'
            """,
            (now_ms, now_ms),
        )
    return info.rowcount


def _today_start_ms() -> int | None:
    """Epoch ms of local midnight today in DRM_TZ, or None if TZ data is missing."""
    try:
        now_local = datetime.now(ZoneInfo(DRM_TZ))
    except Exception:  # noqa: BLE001 - unknown zone / missing tzdata
        return None
    midnight = now_local.replace(hour=0, minute=0, second=0, microsecond=0)
    return int(midnight.timestamp() * 1000)


def _claim_batch(
    conn: sqlite3.Connection, limit: int, now_ms: int | None = None
) -> list[sqlite3.Row]:
    """Atomically mark up to `limit` inferable chunks 'processing' and return them.

    Inferable = the server closed the window (status='ready') AND none of its
    frames is still waiting for the face-blur worker — the anonymization gate,
    now at chunk granularity. Claiming up front means a crash mid-call leaves
    them 'processing' (reclaimed on restart) rather than silently re-billed.

    Ordering is current-day-first: today's chunks (in DRM_TZ) are processed
    before any older backlog, so an evening reconstruction is never stuck
    behind days of catch-up; within each group it's oldest-first. If TZ data
    is unavailable it degrades to newest-first.
    """
    eligible_at = int(time.time() * 1000) if now_ms is None else now_ms
    face_gate = """
        NOT EXISTS (
          SELECT 1 FROM frames f
          WHERE f.participant = c.participant
            AND f.chunk_start_ms = c.chunk_start_ms
            AND f.deleted_at IS NULL
            AND f.face_status IN ('pending', 'processing')
        )
    """
    today_start = _today_start_ms()
    if today_start is not None:
        rows = conn.execute(
            f"""
            SELECT c.participant, c.chunk_start_ms, c.chunk_end_ms,
                   c.vlm_attempt_count + 1 AS attempt_number,
                   c.vlm_retry_count + 1 AS retry_number
            FROM chunks c
            WHERE c.status = 'ready'
              AND c.vlm_retry_count < ?
              AND (c.vlm_next_attempt_at IS NULL OR c.vlm_next_attempt_at <= ?)
              AND {face_gate}
            ORDER BY (c.chunk_start_ms >= ?) DESC, c.chunk_start_ms ASC
            LIMIT ?
            """,
            (VLM_MAX_ATTEMPTS, eligible_at, today_start, limit),
        ).fetchall()
    else:
        rows = conn.execute(
            f"""
            SELECT c.participant, c.chunk_start_ms, c.chunk_end_ms,
                   c.vlm_attempt_count + 1 AS attempt_number,
                   c.vlm_retry_count + 1 AS retry_number
            FROM chunks c
            WHERE c.status = 'ready'
              AND c.vlm_retry_count < ?
              AND (c.vlm_next_attempt_at IS NULL OR c.vlm_next_attempt_at <= ?)
              AND {face_gate}
            ORDER BY c.chunk_start_ms DESC
            LIMIT ?
            """,
            (VLM_MAX_ATTEMPTS, eligible_at, limit),
        ).fetchall()
    with conn:
        for row in rows:
            conn.execute(
                """
                UPDATE chunks
                SET status = 'processing',
                    vlm_next_attempt_at = NULL,
                    updated_at = ?
                WHERE participant = ? AND chunk_start_ms = ? AND status = 'ready'
                """,
                (eligible_at, row["participant"], row["chunk_start_ms"]),
            )
    return rows


def _chunk_frame_paths(conn: sqlite3.Connection, row: sqlite3.Row) -> list[str]:
    """file_paths of the chunk's face-anonymized frames, capture order."""
    frames = conn.execute(
        """
        SELECT file_path FROM frames
        WHERE participant = ? AND chunk_start_ms = ?
          AND face_status = 'done' AND deleted_at IS NULL
        ORDER BY capture_epoch_ms
        """,
        (row["participant"], row["chunk_start_ms"]),
    ).fetchall()
    return [frame["file_path"] for frame in frames]


def _start_attempt(
    conn: sqlite3.Connection, row: sqlite3.Row, frames_sent: int
) -> int:
    started_at = int(time.time() * 1000)
    with conn:
        conn.execute(
            """
            UPDATE chunks
            SET vlm_attempt_count = ?, vlm_retry_count = ?, updated_at = ?
            WHERE participant = ? AND chunk_start_ms = ? AND status = 'processing'
            """,
            (
                row["attempt_number"],
                row["retry_number"],
                started_at,
                row["participant"],
                row["chunk_start_ms"],
            ),
        )
        info = conn.execute(
            """
            INSERT INTO vlm_attempts (
              participant, chunk_start_ms, attempt_number, retry_number, model,
              started_at, frames_sent, timeout_seconds
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                row["participant"],
                row["chunk_start_ms"],
                row["attempt_number"],
                row["retry_number"],
                VLM_MODEL,
                started_at,
                frames_sent,
                VLM_TIMEOUT,
            ),
        )
    return int(info.lastrowid)


def _retry_delay_ms(retry_number: int) -> int:
    delay_index = min(max(retry_number - 1, 0), len(VLM_RETRY_DELAYS_S) - 1)
    return int(VLM_RETRY_DELAYS_S[delay_index] * 1000)


def _settle_attempt(
    conn: sqlite3.Connection,
    row: sqlite3.Row,
    attempt_id: int,
    attempt: AttemptResult,
) -> tuple[str, int | None]:
    """Persist one attempt and return (done|retry|failed, retry_delay_ms)."""
    now_ms = int(time.time() * 1000)
    retryable = attempt.outcome not in {"done", "input_error"}
    should_retry = retryable and row["retry_number"] < VLM_MAX_ATTEMPTS

    with conn:
        conn.execute(
            """
            UPDATE vlm_attempts
            SET completed_at = ?, duration_ms = ?, outcome = ?,
                error_class = ?, http_status = ?
            WHERE id = ? AND outcome IS NULL
            """,
            (
                now_ms,
                attempt.duration_ms,
                attempt.outcome,
                attempt.error_class,
                attempt.http_status,
                attempt_id,
            ),
        )

        if attempt.outcome == "done":
            result = attempt.payload
            assert result is not None
            conn.execute(
                """
                UPDATE chunks
                SET status = 'done', vlm_model = ?, vlm_label = ?, vlm_category = ?,
                    vlm_activity_confidence = ?, vlm_activity_confidences_json = ?,
                    vlm_category_confidence = ?,
                    vlm_category_confidences_json = ?, vlm_completed_at = ?,
                    vlm_next_attempt_at = NULL, vlm_last_error_type = NULL,
                    updated_at = ?
                WHERE participant = ? AND chunk_start_ms = ?
                """,
                (
                    VLM_MODEL,
                    result["activity"],
                    result["category"],
                    result["activity_confidence"],
                    json.dumps(result["activity_confidences"], separators=(",", ":")),
                    result["category_confidence"],
                    json.dumps(result["category_confidences"], separators=(",", ":")),
                    now_ms,
                    now_ms,
                    row["participant"],
                    row["chunk_start_ms"],
                ),
            )
            return ("done", None)

        if should_retry:
            delay_ms = _retry_delay_ms(row["retry_number"])
            conn.execute(
                """
                UPDATE chunks
                SET status = 'ready', vlm_next_attempt_at = ?,
                    vlm_last_error_type = ?, vlm_completed_at = NULL,
                    updated_at = ?
                WHERE participant = ? AND chunk_start_ms = ?
                """,
                (
                    now_ms + delay_ms,
                    attempt.outcome,
                    now_ms,
                    row["participant"],
                    row["chunk_start_ms"],
                ),
            )
            return ("retry", delay_ms)

        conn.execute(
            """
            UPDATE chunks
            SET status = 'failed', vlm_model = NULL, vlm_label = NULL,
                vlm_category = NULL, vlm_activity_confidence = NULL,
                vlm_activity_confidences_json = NULL,
                vlm_category_confidence = NULL,
                vlm_category_confidences_json = NULL,
                vlm_completed_at = ?, vlm_next_attempt_at = NULL,
                vlm_last_error_type = ?, updated_at = ?
            WHERE participant = ? AND chunk_start_ms = ?
            """,
            (
                now_ms,
                attempt.outcome,
                now_ms,
                row["participant"],
                row["chunk_start_ms"],
            ),
        )
    return ("failed", None)


def _chunk_desc(row: sqlite3.Row) -> str:
    start_s = datetime.fromtimestamp(row["chunk_start_ms"] / 1000).strftime(
        "%Y-%m-%d %H:%M"
    )
    return f"{row['participant']}@{start_s}"


# --- Worker -----------------------------------------------------------------

# Runs in a worker thread: reads images and makes exactly one endpoint attempt.
# Delayed retries are persisted/scheduled by the main thread so a timeout frees
# its concurrency slot instead of sleeping/retrying inside it.
def _classify_exception(exc: Exception) -> tuple[str, str, int | None]:
    error_class = type(exc).__name__
    status = getattr(exc, "status_code", None)
    if status is None:
        status = getattr(getattr(exc, "response", None), "status_code", None)
    http_status = status if isinstance(status, int) else None
    lower_name = error_class.lower()

    if isinstance(exc, ValueError):
        return ("validation_error", error_class, http_status)
    if isinstance(exc, TimeoutError) or "timeout" in lower_name:
        return ("timeout", error_class, http_status)
    if http_status == 429 or "ratelimit" in lower_name or "rate_limit" in lower_name:
        return ("rate_limit", error_class, http_status)
    if http_status is not None and http_status >= 500:
        return ("server_error", error_class, http_status)
    return ("api_error", error_class, http_status)


def _infer_chunk_once(
    client: OpenAI, paths: list[str], user_prompt: str
) -> AttemptResult:
    started = time.monotonic()
    images: list[bytes] = []
    for path in paths:
        try:
            images.append((RECORDINGS_DIR / path).read_bytes())
        except OSError as exc:
            return AttemptResult(
                outcome="input_error",
                payload=None,
                duration_ms=int((time.monotonic() - started) * 1000),
                error_class=type(exc).__name__,
                log_detail=f"unreadable {path}: {exc}",
            )

    if _shutdown:
        return AttemptResult(
            outcome="interrupted",
            payload=None,
            duration_ms=int((time.monotonic() - started) * 1000),
            error_class="WorkerInterrupted",
            log_detail="shutdown before endpoint call",
        )

    try:
        result = infer(client, images, user_prompt)
        return AttemptResult(
            outcome="done",
            payload=result,
            duration_ms=int((time.monotonic() - started) * 1000),
        )
    except Exception as exc:  # noqa: BLE001 - classified and persisted by type
        outcome, error_class, http_status = _classify_exception(exc)
        return AttemptResult(
            outcome=outcome,
            payload=None,
            duration_ms=int((time.monotonic() - started) * 1000),
            error_class=error_class,
            http_status=http_status,
            log_detail=repr(exc)[:200],
        )


def run(once: bool, max_chunks: int | None) -> None:
    if not KIT_API_KEY:
        _log("KIT_API_KEY is not set (put it in vlm/.env or the environment)")
        sys.exit(2)

    _log(f"db={RECORDINGS_DB}")
    _log(f"recordings={RECORDINGS_DIR}")
    _log(f"model={VLM_MODEL} via {KIT_BASE_URL}")
    _log(
        f"concurrency={VLM_CONCURRENCY} (in-flight endpoint calls), "
        f"refill<={BATCH_SIZE}, frames/chunk<={VLM_CHUNK_MAX_FRAMES}, "
        f"attempts<={VLM_MAX_ATTEMPTS}, timeout={VLM_TIMEOUT:g}s"
    )
    client = OpenAI(api_key=KIT_API_KEY, base_url=KIT_BASE_URL, timeout=VLM_TIMEOUT, max_retries=0)

    schema_checked = False
    if RECORDINGS_DB.exists():
        conn = _connect()
        schema_checked = _ensure_chunks_table(conn)  # exits with a clear message if missing
        if schema_checked:
            reclaimed = _reclaim_stale_processing(conn)
            if reclaimed:
                _log(f"reclaimed {reclaimed} interrupted 'processing' chunk(s)")
        conn.close()

    settled_attempts = 0
    in_flight: dict[Future[AttemptResult], InFlightAttempt] = {}

    with ThreadPoolExecutor(max_workers=VLM_CONCURRENCY) as pool:
        while not _shutdown or in_flight:
            if not RECORDINGS_DB.exists():
                time.sleep(POLL_INTERVAL_S)
                continue

            conn = _connect()
            if not schema_checked:
                schema_checked = _ensure_chunks_table(conn)
                if not schema_checked:
                    conn.close()
                    time.sleep(POLL_INTERVAL_S)
                    continue

            # Persist completed calls before claiming replacements. Removing a
            # future only after the transaction succeeds makes a DB failure
            # recoverable through the startup reclaim path.
            for future in [candidate for candidate in in_flight if candidate.done()]:
                job = in_flight[future]
                try:
                    attempt = future.result()
                except Exception as exc:  # defensive: worker wrapper should catch
                    attempt = AttemptResult(
                        outcome="api_error",
                        payload=None,
                        duration_ms=0,
                        error_class=type(exc).__name__,
                        log_detail=repr(exc)[:200],
                    )
                disposition, delay_ms = _settle_attempt(
                    conn, job.row, job.attempt_id, attempt
                )
                del in_flight[future]
                settled_attempts += 1

                if disposition == "done":
                    result = attempt.payload
                    assert result is not None
                    _log(
                        f"done {_chunk_desc(job.row)} attempt "
                        f"{job.row['retry_number']}/{VLM_MAX_ATTEMPTS} -> "
                        f"{result['activity']!r} [{result['category']}] "
                        f"({attempt.duration_ms} ms)"
                    )
                elif disposition == "retry":
                    _log(
                        f"retry {_chunk_desc(job.row)} after "
                        f"{attempt.outcome} on attempt "
                        f"{job.row['retry_number']}/{VLM_MAX_ATTEMPTS}; "
                        f"next in {delay_ms / 1000:g}s"
                    )
                else:
                    _log(
                        f"FAILED {_chunk_desc(job.row)} after attempt "
                        f"{job.row['retry_number']}/{VLM_MAX_ATTEMPTS}: "
                        f"{attempt.outcome} {attempt.log_detail or ''}".rstrip()
                    )

            claimed_count = 0
            if not _shutdown:
                available_slots = VLM_CONCURRENCY - len(in_flight)
                if max_chunks is not None:
                    remaining = max_chunks - settled_attempts - len(in_flight)
                    available_slots = min(available_slots, max(0, remaining))
                claim_limit = min(BATCH_SIZE, available_slots)

                try:
                    rows = _claim_batch(conn, claim_limit) if claim_limit > 0 else []
                except sqlite3.OperationalError as exc:
                    _log(f"db not ready ({exc}); retrying")
                    rows = []

                # Build jobs on the DB-owning main thread. Caches only cover
                # this refill so a profile edited between refills is observed.
                prompt_cache: dict[tuple[str, int], str] = {}
                occupation_cache: dict[str, tuple[str | None, str | None]] = {}
                for row in rows:
                    claimed_count += 1
                    paths = sample_evenly(
                        _chunk_frame_paths(conn, row), VLM_CHUNK_MAX_FRAMES
                    )
                    attempt_id = _start_attempt(conn, row, len(paths))
                    if not paths:
                        attempt = AttemptResult(
                            outcome="input_error",
                            payload=None,
                            duration_ms=0,
                            error_class="NoAnonymizedFrames",
                            log_detail="no anonymized frames in chunk",
                        )
                        _settle_attempt(conn, row, attempt_id, attempt)
                        settled_attempts += 1
                        _log(
                            f"FAILED {_chunk_desc(row)} no anonymized frames in chunk"
                        )
                        continue

                    participant = row["participant"]
                    if participant not in occupation_cache:
                        occupation_cache[participant] = _fetch_participant_context(
                            conn, participant
                        )
                    prompt_key = (participant, len(paths))
                    if prompt_key not in prompt_cache:
                        occupation, work_description = occupation_cache[participant]
                        prompt_cache[prompt_key] = _build_user_prompt(
                            occupation, work_description, len(paths)
                        )
                    future = pool.submit(
                        _infer_chunk_once, client, paths, prompt_cache[prompt_key]
                    )
                    in_flight[future] = InFlightAttempt(row, attempt_id)

            conn.close()

            if max_chunks is not None and settled_attempts >= max_chunks and not in_flight:
                _log(f"reached --max {max_chunks} endpoint attempt(s)")
                break
            if once and not in_flight and claimed_count == 0:
                break

            if in_flight:
                wait(
                    tuple(in_flight),
                    timeout=POLL_INTERVAL_S,
                    return_when=FIRST_COMPLETED,
                )
            else:
                time.sleep(POLL_INTERVAL_S)

    _log(f"stopping. completed {settled_attempts} endpoint attempt(s) this run.")


def main() -> None:
    parser = argparse.ArgumentParser(
        description="BLINKS VLM scene-understanding worker (5-minute chunks)"
    )
    parser.add_argument(
        "--once", action="store_true",
        help="process the current backlog and exit (default: poll forever)",
    )
    parser.add_argument(
        "--max", type=int, default=None, metavar="N",
        help="stop after completing N endpoint attempts (for testing)",
    )
    args = parser.parse_args()

    signal.signal(signal.SIGINT, _handle_signal)
    signal.signal(signal.SIGTERM, _handle_signal)
    run(once=args.once, max_chunks=args.max)


if __name__ == "__main__":
    main()
