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
                       writes vlm_label/category/description/descriptor
                       onto the CHUNK row (frames.vlm_* is frozen legacy)

Readiness gate (columns, not locks): a chunk is only claimed when
  - chunks.status = 'ready' (the server closed the window), AND
  - none of its frames is still face_status 'pending'/'processing'
so the VLM provably never sees an un-anonymized face. A chunk whose frames all
failed the blur is marked 'failed' without an API call.

Per chunk the model receives up to VLM_CHUNK_MAX_FRAMES face-anonymized frames
(evenly sampled across the window, chronological order) and returns ONE
label/category/descriptor for the window:
  - "activity": closest entry from ACTIVITY_VOCABULARY (or a coined concise
    label if nothing fits)                       -> chunks.vlm_label
  - "category": 'work' | 'break' | 'other'      -> chunks.vlm_category
Classification is conditioned on the participant's occupation + work
description (participants table, owned by the Node server).

Same design rule as the face-blur worker: a separate long-lived process, never
inline with WS ingestion, so VLM latency / API errors can never cost a frame
and old days can be re-processed later with a better model or prompt.

Model: the KIT SCC AI toolbox, an OpenAI-compatible endpoint (same client as
the sibling KARMA project). Default model `kit.gemma4-31b-it` (Gemma,
vision-capable over the API). The endpoint is KIT-hosted, so even the
anonymized frames stay inside KIT infrastructure rather than a public cloud.

Config (environment variables; a local .env next to this file is auto-loaded):
    KIT_API_KEY           required: KIT SCC AI toolbox API key
    KIT_BASE_URL          OpenAI-compatible base URL
                            (default: https://ki-toolbox.scc.kit.edu/api/v1)
    VLM_MODEL             model name           (default: kit.gemma4-31b-it)
    RECORDINGS_DIR        recordings tree      (default: ../recordings)
    RECORDINGS_DB         path to recordings.db (default: <RECORDINGS_DIR>/recordings.db)
    VLM_TIMEOUT           per-request timeout seconds (default: 120)
    VLM_TEMPERATURE       sampling temperature        (default: 0.1)
    VLM_MAX_RETRIES       retries per chunk on API/parse error (default: 3)
    VLM_CHUNK_MAX_FRAMES  frames sent per chunk, evenly sampled (default: 20;
                            covers a full window at the 15 s study interval)
    POLL_INTERVAL_S       sleep between polls when the queue is empty (default: 3.0)
    BATCH_SIZE            chunks claimed per poll     (default: 8)
    VLM_CONCURRENCY       endpoint calls in flight at once (default: 8)
    DRM_TZ                study timezone for current-day-first ordering
                            (default: Europe/Berlin; match the server's DRM_TZ)

CLI:
    python vlm_worker.py            # daemon: poll forever
    python vlm_worker.py --once     # process the current backlog, then exit
    python vlm_worker.py --max 50   # stop after N chunks (testing)

Requeue failed chunks once the cause is fixed:
    UPDATE chunks SET status='ready' WHERE status='failed';

Concurrency: endpoint calls are I/O-bound, so up to VLM_CONCURRENCY run in
parallel (thread pool); only the network calls run in threads — every DB
read/write stays on the main thread (a sqlite3 connection is not shareable
across threads), so the batch claim stays atomic.

Single-worker assumption (one PROCESS): on startup any chunk left in
'processing' (from a crash) is reclaimed to 'ready'. Scale via
VLM_CONCURRENCY, NOT by launching multiple processes.
"""

from __future__ import annotations

import argparse
import base64
import json
import os
import signal
import sqlite3
import sys
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
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
VLM_MODEL = os.environ.get("VLM_MODEL", "kit.gemma4-31b-it")

VLM_TIMEOUT = float(os.environ.get("VLM_TIMEOUT", "120"))
VLM_TEMPERATURE = float(os.environ.get("VLM_TEMPERATURE", "0.1"))
VLM_MAX_RETRIES = int(os.environ.get("VLM_MAX_RETRIES", "3"))
VLM_CHUNK_MAX_FRAMES = max(1, int(os.environ.get("VLM_CHUNK_MAX_FRAMES", "20")))
POLL_INTERVAL_S = float(os.environ.get("POLL_INTERVAL_S", "3.0"))
VLM_CONCURRENCY = max(1, int(os.environ.get("VLM_CONCURRENCY", "8")))
# Study timezone, matching the server's DRM_TZ, so "today" agrees with the
# reconstruction gate. Drives current-day-first claim ordering.
DRM_TZ = os.environ.get("DRM_TZ", "Europe/Berlin")
BATCH_SIZE = int(os.environ.get("BATCH_SIZE", "8"))

CHUNK_WINDOW_MS = 5 * 60 * 1000  # keep in sync with server/src/db.ts

# --- Activity vocabulary (v1) ------------------------------------------------
# RESEARCHER NOTE: review and extend this list BEFORE the study. It is the
# closed(ish) vocabulary the VLM picks the per-chunk "activity" from (the model
# may coin a concise 2-4 word label when nothing here fits, so gaps degrade
# gracefully, but a curated list keeps labels consistent across participants
# and days). Short lowercase noun phrases only.
ACTIVITY_VOCABULARY = [
    # computer work
    "computer work",
    "email or messaging",
    "browsing the web",
    "coding or data analysis",
    "preparing slides or documents",
    # meetings
    "in-person meeting",
    "video meeting",
    "presentation or lecture",
    # calls
    "phone call",
    # reading / writing
    "reading printed material",
    "reading on a screen",
    "writing by hand",
    # eating / drinking
    "eating a meal",
    "snacking",
    "drinking coffee or tea",
    # resting
    "resting with eyes open",
    "napping or lying down",
    "sitting and relaxing",
    # walking / exercise
    "walking indoors",
    "walking outdoors",
    "exercising or stretching",
    # socializing
    "casual conversation",
    "coffee break with others",
    "social gathering",
    # phone / entertainment
    "using phone",
    "watching tv or videos",
    "playing games",
    "listening to music or podcast",
    # cooking
    "cooking or preparing food",
    "setting or clearing the table",
    # chores / errands
    "cleaning or tidying",
    "laundry or dishes",
    "shopping or errands",
    "answering the door",
    "organizing belongings",
    # hygiene / dressing
    "personal hygiene",
    "getting dressed",
    # commuting
    "commuting by car",
    "commuting by public transport",
    "cycling",
    # childcare / pets
    "childcare",
    "caring for pets",
    # unclear or transition
    "transitioning between activities",
    "unclear activity",
]

# The three-way DRM category. Anything the model returns outside this set is
# coerced to 'other' (never fails a chunk over a category typo).
VLM_CATEGORIES = ("work", "break", "other")

# --- Scene-state descriptor schema (v1) -------------------------------------
# Each dimension is a small closed vocabulary so the output is consistent
# enough to feed change-point detection downstream. With chunk-level inference
# the descriptor captures the DOMINANT state across the window; "unknown" is
# always allowed so a dark / ambiguous window degrades gracefully.
DESCRIPTOR_ENUMS = {
    "posture": ["sitting", "standing", "walking", "lying", "unknown"],
    "movement": ["still", "fidgeting", "walking", "unknown"],
    "screen_engagement": ["none", "looking_at_screen", "actively_using_screen", "unknown"],
    "object_manipulation": [
        "none", "writing", "typing", "using_phone", "handling_object",
        "eating_drinking", "unknown",
    ],
    "proximity": ["alone", "one_person_nearby", "group_nearby", "unknown"],
    "social_interaction": ["none", "listening", "conversing", "presenting", "unknown"],
}

SYSTEM_PROMPT = (
    "You analyze short sequences of frames from a body-worn (first-person) "
    "camera for a research study on knowledge work. The frames are given in "
    "chronological order and together span about five minutes. Faces in the "
    "images are intentionally pixelated for privacy; describe the scene and "
    "activity, never attempt to identify people. Judge the sequence as a "
    "whole: describe the DOMINANT activity of the window, not any single frame."
)


def _build_user_prompt(
    occupation: str | None, work_description: str | None, frame_count: int
) -> str:
    """The per-participant user prompt (occupation context varies per participant)."""
    enums = "\n".join(
        f'  "{k}": one of {v}' for k, v in DESCRIPTOR_ENUMS.items()
    )
    vocabulary = "; ".join(ACTIVITY_VOCABULARY)
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
        "return STRICT JSON only (no prose, no code fences) with exactly "
        "these keys:\n"
        '  "label": a 2-5 word summary of the dominant activity (string)\n'
        '  "description": one short sentence about the window (string)\n'
        '  "activity": the single closest activity from this list: '
        f"{vocabulary}. "
        "If nothing in the list fits, coin a concise 2-4 word label instead.\n"
        '  "category": one of ["work", "break", "other"]. '
        '"work" = the wearer\'s own occupation work (their occupation and work '
        "description above provide the context for what counts as work). "
        '"break" = an intentional restorative pause ("erholsame Pause": coffee, '
        "resting, a deliberate walk, socializing to recover). "
        '"other" = neither work nor restorative (chores, answering the door, '
        "errands, possibly cooking).\n"
        f"{enums}\n"
        "Pick the single value that best describes the dominant state across "
        'the window; use "unknown" only when the window is genuinely ambiguous.'
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


def _normalize(raw: dict) -> dict:
    """Coerce the model's JSON into our fixed shape (activity, category, description, dims)."""
    label = str(raw.get("label", "")).strip()[:200]
    description = str(raw.get("description", "")).strip()[:1000]
    # "activity" is what goes into vlm_label; fall back to the generic scene
    # summary if the model omitted it, so a chunk never ends up label-less.
    activity = str(raw.get("activity", "")).strip()[:200] or label
    category = str(raw.get("category", "")).strip().lower()
    if category not in VLM_CATEGORIES:
        category = "other"
    descriptor = {}
    for key, allowed in DESCRIPTOR_ENUMS.items():
        value = str(raw.get(key, "unknown")).strip().lower()
        descriptor[key] = value if value in allowed else "unknown"
    return {
        "label": label,
        "description": description,
        "activity": activity,
        "category": category,
        "descriptor": descriptor,
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
    )
    text = response.choices[0].message.content or ""
    return _normalize(_extract_json_object(text))


# --- DB ---------------------------------------------------------------------

def _connect() -> sqlite3.Connection:
    conn = sqlite3.connect(str(RECORDINGS_DB), timeout=30.0)
    conn.row_factory = sqlite3.Row
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
    """Single-worker crash recovery: any chunk stuck 'processing' is ours to retry."""
    info = conn.execute(
        "UPDATE chunks SET status = 'ready' WHERE status = 'processing'"
    )
    conn.commit()
    return info.rowcount


def _today_start_ms() -> int | None:
    """Epoch ms of local midnight today in DRM_TZ, or None if TZ data is missing."""
    try:
        now_local = datetime.now(ZoneInfo(DRM_TZ))
    except Exception:  # noqa: BLE001 - unknown zone / missing tzdata
        return None
    midnight = now_local.replace(hour=0, minute=0, second=0, microsecond=0)
    return int(midnight.timestamp() * 1000)


def _claim_batch(conn: sqlite3.Connection, limit: int) -> list[sqlite3.Row]:
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
            SELECT c.participant, c.chunk_start_ms, c.chunk_end_ms
            FROM chunks c
            WHERE c.status = 'ready' AND {face_gate}
            ORDER BY (c.chunk_start_ms >= ?) DESC, c.chunk_start_ms ASC
            LIMIT ?
            """,
            (today_start, limit),
        ).fetchall()
    else:
        rows = conn.execute(
            f"""
            SELECT c.participant, c.chunk_start_ms, c.chunk_end_ms
            FROM chunks c
            WHERE c.status = 'ready' AND {face_gate}
            ORDER BY c.chunk_start_ms DESC
            LIMIT ?
            """,
            (limit,),
        ).fetchall()
    for row in rows:
        conn.execute(
            "UPDATE chunks SET status = 'processing' WHERE participant = ? AND chunk_start_ms = ?",
            (row["participant"], row["chunk_start_ms"]),
        )
    conn.commit()
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


def _write_result(conn: sqlite3.Connection, row: sqlite3.Row, result: dict) -> None:
    conn.execute(
        """
        UPDATE chunks
        SET status = 'done', vlm_model = ?, vlm_label = ?, vlm_category = ?,
            vlm_description = ?, vlm_descriptor = ?, vlm_completed_at = ?,
            updated_at = ?
        WHERE participant = ? AND chunk_start_ms = ?
        """,
        (
            VLM_MODEL,
            result["activity"],
            result["category"],
            result["description"],
            json.dumps(result["descriptor"], separators=(",", ":")),
            int(time.time() * 1000),
            int(time.time() * 1000),
            row["participant"], row["chunk_start_ms"],
        ),
    )
    conn.commit()


def _mark_failed(conn: sqlite3.Connection, row: sqlite3.Row) -> None:
    conn.execute(
        """
        UPDATE chunks SET status = 'failed', vlm_completed_at = ?, updated_at = ?
        WHERE participant = ? AND chunk_start_ms = ?
        """,
        (
            int(time.time() * 1000),
            int(time.time() * 1000),
            row["participant"], row["chunk_start_ms"],
        ),
    )
    conn.commit()


def _chunk_desc(row: sqlite3.Row) -> str:
    start_s = datetime.fromtimestamp(row["chunk_start_ms"] / 1000).strftime(
        "%Y-%m-%d %H:%M"
    )
    return f"{row['participant']}@{start_s}"


# --- Worker -----------------------------------------------------------------

# Runs in a worker thread: reads the images and calls the endpoint (with
# retry). Deliberately does NO database access — the sqlite3 connection lives
# on the main thread, which writes the outcome this returns. Returns one of:
#   ("done", result_dict) | ("failed", reason_str) | ("skip", reason_str)
def _infer_chunk(
    client: OpenAI, paths: list[str], user_prompt: str
) -> tuple[str, object]:
    images: list[bytes] = []
    for path in paths:
        try:
            images.append((RECORDINGS_DIR / path).read_bytes())
        except OSError as exc:
            return ("failed", f"unreadable {path}: {exc}")

    last_err = None
    for attempt in range(1, VLM_MAX_RETRIES + 1):
        if _shutdown:
            return ("skip", "shutdown")
        try:
            return ("done", infer(client, images, user_prompt))
        except Exception as exc:  # noqa: BLE001 - API or parse error; retry then fail
            last_err = exc
            if attempt < VLM_MAX_RETRIES:
                time.sleep(min(2 ** attempt, 10))  # 2s, 4s, 8s backoff

    return ("failed", f"after {VLM_MAX_RETRIES} tries: {repr(last_err)[:200]}")


# Main thread: run a claimed batch through the endpoint VLM_CONCURRENCY-at-a-
# time and persist each outcome as it returns. Returns how many chunks reached
# a terminal state (done/failed); 'skip' chunks (shutdown mid-flight) are left
# 'processing' and reclaimed on the next start. All DB writes happen here.
def _process_batch(
    conn: sqlite3.Connection,
    client: OpenAI,
    jobs: list[tuple[sqlite3.Row, list[str], str]],
) -> int:
    settled = 0
    with ThreadPoolExecutor(max_workers=VLM_CONCURRENCY) as pool:
        future_to_row = {
            pool.submit(_infer_chunk, client, paths, prompt): row
            for row, paths, prompt in jobs
        }
        for future in as_completed(future_to_row):
            row = future_to_row[future]
            status, payload = future.result()
            if status == "done":
                result = payload  # type: ignore[assignment]
                _write_result(conn, row, result)
                _log(
                    f"done {_chunk_desc(row)} -> "
                    f"{result['activity']!r} [{result['category']}]"
                )
                settled += 1
            elif status == "failed":
                _log(f"FAILED {_chunk_desc(row)} {payload}")
                _mark_failed(conn, row)
                settled += 1
            # status == "skip": leave 'processing' for the startup reclaim
    return settled


def run(once: bool, max_chunks: int | None) -> None:
    if not KIT_API_KEY:
        _log("KIT_API_KEY is not set (put it in vlm/.env or the environment)")
        sys.exit(2)

    _log(f"db={RECORDINGS_DB}")
    _log(f"recordings={RECORDINGS_DIR}")
    _log(f"model={VLM_MODEL} via {KIT_BASE_URL}")
    _log(
        f"concurrency={VLM_CONCURRENCY} (in-flight endpoint calls), "
        f"batch={BATCH_SIZE}, frames/chunk<={VLM_CHUNK_MAX_FRAMES}"
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

    processed = 0
    while not _shutdown:
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
        # Never claim more than --max still allows, so a capped run leaves no
        # extra chunks stranded in 'processing'.
        claim_limit = BATCH_SIZE
        if max_chunks is not None:
            claim_limit = min(BATCH_SIZE, max_chunks - processed)
            if claim_limit <= 0:
                conn.close()
                break

        try:
            rows = _claim_batch(conn, claim_limit)
        except sqlite3.OperationalError as exc:
            _log(f"db not ready ({exc}); retrying")
            conn.close()
            time.sleep(POLL_INTERVAL_S)
            continue

        if not rows:
            conn.close()
            if once:
                break
            time.sleep(POLL_INTERVAL_S)
            continue

        # Build each chunk's inference job on the main thread: sampled frame
        # paths + the per-participant prompt (occupation context, cached per
        # batch). A chunk with zero anonymized frames (all blurs failed, or
        # every frame deleted) is failed here without an API call.
        prompt_cache: dict[tuple[str, int], str] = {}
        occupation_cache: dict[str, tuple[str | None, str | None]] = {}
        jobs: list[tuple[sqlite3.Row, list[str], str]] = []
        for row in rows:
            paths = sample_evenly(_chunk_frame_paths(conn, row), VLM_CHUNK_MAX_FRAMES)
            if not paths:
                _log(f"FAILED {_chunk_desc(row)} no anonymized frames in chunk")
                _mark_failed(conn, row)
                processed += 1
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
            jobs.append((row, paths, prompt_cache[prompt_key]))

        if jobs:
            processed += _process_batch(conn, client, jobs)
        conn.close()

        if max_chunks is not None and processed >= max_chunks:
            _log(f"reached --max {max_chunks}")
            break

    _log(f"stopping. processed {processed} chunk(s) this run.")


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
        help="stop after processing N chunks (for testing)",
    )
    args = parser.parse_args()

    signal.signal(signal.SIGINT, _handle_signal)
    signal.signal(signal.SIGTERM, _handle_signal)
    run(once=args.once, max_chunks=args.max)


if __name__ == "__main__":
    main()
