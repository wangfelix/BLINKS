#!/usr/bin/env python3
"""
BLINKS VLM scene-understanding worker.

Polls recordings.db for frames that have been face-anonymized but not yet
described (vlm_status='pending' AND face_status='done'), sends each JPEG to a
Vision Language Model, and writes a per-image scene-state descriptor + label +
description back to the row.

DRM subproject additions (2026-07): per frame the model now also returns
  - "activity": the closest entry from ACTIVITY_VOCABULARY (or a coined concise
    label if nothing fits) -> written to vlm_label
  - "category": 'work' | 'break' | 'other'                 -> written to vlm_category
Classification is conditioned on the participant's occupation + work description
(read from the participants table, which the Node server owns; if the table or
the row is missing the prompt states the occupation is unknown).

Same design rule as the face-blur worker: a separate long-lived process, never
inline with WS ingestion, so VLM latency / API errors can never cost a frame and
old sessions can be re-processed later with a better model or prompt.

    camera -> BLE -> phone -> WS -> server   (row: face=pending, vlm=pending)
                                      |
                                      v
                               face-blur worker  -> face_status='done'
                                      |
                                      v
                               [this worker]  vlm_status pending->done
                                              writes vlm_label/category/description/descriptor

THE ORDERING GATE IS A COLUMN, NOT A LOCK. Both workers run as independent
daemons in parallel; this one simply never selects a frame until
face_status='done', so the VLM provably never sees an un-anonymized face. That
matters because the model is a remote API (the KIT SCC AI toolbox).

Model: the KIT SCC AI toolbox, an OpenAI-compatible endpoint (same client as the
sibling KARMA project). Default model `kit.gemma4-31b-it` (Gemma, vision-capable
over the API). The endpoint is KIT-hosted (ki-toolbox.scc.kit.edu), so even the
anonymized frames stay inside KIT infrastructure rather than a public cloud.

The descriptor dimensions (posture, movement, screen_engagement,
object_manipulation, proximity, social_interaction) follow the project's
"per-image scene-state descriptor" plan. The enums here are a v1 starting point;
refine the taxonomy for the study as needed.

Config (environment variables; a local .env next to this file is auto-loaded):
    KIT_API_KEY       required: KIT SCC AI toolbox API key
    KIT_BASE_URL      OpenAI-compatible base URL
                        (default: https://ki-toolbox.scc.kit.edu/api/v1)
    VLM_MODEL         model name           (default: kit.gemma4-31b-it)
    RECORDINGS_DIR    recordings tree      (default: ../recordings)
    RECORDINGS_DB     path to recordings.db (default: <RECORDINGS_DIR>/recordings.db)
    VLM_TIMEOUT       per-request timeout seconds (default: 60)
    VLM_TEMPERATURE   sampling temperature        (default: 0.1)
    VLM_MAX_RETRIES   retries per frame on API/parse error (default: 3)
    POLL_INTERVAL_S   sleep between polls when the queue is empty (default: 3.0)
    BATCH_SIZE        rows claimed per poll       (default: 20)
    VLM_CONCURRENCY   endpoint calls in flight at once (default: 8)
    DRM_TZ            study timezone for current-day-first ordering
                        (default: Europe/Berlin; match the server's DRM_TZ)

CLI:
    python vlm_worker.py            # daemon: poll forever
    python vlm_worker.py --once     # process the current backlog, then exit
    python vlm_worker.py --max 50   # stop after N frames (testing)

Concurrency: the VLM endpoint calls are I/O-bound, so within one process the
worker runs up to VLM_CONCURRENCY of them in parallel (a thread pool); the
endpoint was measured to parallelize cleanly with no rate-limit wall or latency
penalty at 8. Only the network calls run in threads — every DB read/write stays
on the main thread (a sqlite3 connection is not shareable across threads), so
there are no concurrent-write hazards and the batch claim stays atomic.

Single-worker assumption (still one PROCESS): on startup any row left in
'processing' (from a crash) is reclaimed to 'pending'. Scale via VLM_CONCURRENCY,
NOT by launching multiple processes — a second process would need an atomic
claim and a time-based (not startup-blanket) reclaim, which are not built.
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

VLM_TIMEOUT = float(os.environ.get("VLM_TIMEOUT", "60"))
VLM_TEMPERATURE = float(os.environ.get("VLM_TEMPERATURE", "0.1"))
VLM_MAX_RETRIES = int(os.environ.get("VLM_MAX_RETRIES", "3"))
POLL_INTERVAL_S = float(os.environ.get("POLL_INTERVAL_S", "3.0"))
VLM_CONCURRENCY = max(1, int(os.environ.get("VLM_CONCURRENCY", "8")))
# Study timezone, matching the server's DRM_TZ, so "today" agrees with the
# reconstruction gate. Drives current-day-first claim ordering.
DRM_TZ = os.environ.get("DRM_TZ", "Europe/Berlin")
BATCH_SIZE = int(os.environ.get("BATCH_SIZE", "20"))

# --- Activity vocabulary (v1) ------------------------------------------------
# RESEARCHER NOTE: review and extend this list BEFORE the study. It is the
# closed(ish) vocabulary the VLM picks the per-frame "activity" from (the model
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
# coerced to 'other' (never fails a frame over a category typo).
VLM_CATEGORIES = ("work", "break", "other")

# --- Scene-state descriptor schema (v1) -------------------------------------
# Each dimension is a small closed vocabulary so the output is consistent enough
# to feed change-point detection downstream. "unknown" is always allowed so a
# dark / ambiguous frame degrades gracefully instead of forcing a wrong label.
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
    "You analyze single frames from a body-worn (first-person) camera for a "
    "research study on knowledge work. Faces in the image are intentionally "
    "pixelated for privacy; describe the scene and activity, never attempt to "
    "identify people. Answer only about what is visibly in this one frame."
)


def _build_user_prompt(occupation: str | None, work_description: str | None) -> str:
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
        "Describe this scene and return STRICT JSON only (no prose, no code "
        "fences) with exactly these keys:\n"
        '  "label": a 2-5 word activity summary (string)\n'
        '  "description": one short sentence about the scene (string)\n'
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
        "Pick the single best value for each dimension; use \"unknown\" only "
        "when the frame is genuinely ambiguous."
    )

_shutdown = False


def _log(msg: str) -> None:
    print(f"[vlm] {msg}", flush=True)


def _handle_signal(signum, _frame) -> None:
    global _shutdown
    _shutdown = True
    _log(f"received signal {signum}, finishing current frame then exiting")


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
    # summary if the model omitted it, so a frame never ends up label-less.
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


def infer(client: OpenAI, image_bytes: bytes, user_prompt: str) -> dict:
    """One VLM call -> normalized {label, description, activity, category, descriptor}.

    Raises on failure. `user_prompt` is per-participant (occupation context).
    """
    b64 = base64.b64encode(image_bytes).decode("ascii")
    response = client.chat.completions.create(
        model=VLM_MODEL,
        temperature=VLM_TEMPERATURE,
        messages=[
            {"role": "system", "content": SYSTEM_PROMPT},
            {
                "role": "user",
                "content": [
                    {"type": "text", "text": user_prompt},
                    {
                        "type": "image_url",
                        "image_url": {"url": f"data:image/jpeg;base64,{b64}"},
                    },
                ],
            },
        ],
    )
    content = response.choices[0].message.content or ""
    return _normalize(_extract_json_object(content))


# --- DB ---------------------------------------------------------------------

def _connect() -> sqlite3.Connection:
    conn = sqlite3.connect(str(RECORDINGS_DB), timeout=30.0)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode = WAL")
    conn.execute("PRAGMA synchronous = NORMAL")
    conn.execute("PRAGMA busy_timeout = 5000")
    return conn


def _ensure_vlm_category_column(conn: sqlite3.Connection) -> bool:
    """Fail fast, with a clear message instead of a stack trace, if the
    frames.vlm_category column is missing.

    The Node server owns the migration (server/src/db.ts initDb ALTERs the
    column in on startup, same additive pattern as the face_* columns); this
    worker only writes the column. Returns False when the frames table itself
    does not exist yet (fresh DB, server not started) so the caller can keep
    polling instead of dying.
    """
    columns = {row[1] for row in conn.execute("PRAGMA table_info(frames)")}
    if not columns:
        return False  # no frames table yet; the normal "db not ready" path applies
    if "vlm_category" not in columns:
        _log(
            "FATAL: frames.vlm_category column is missing in recordings.db. "
            "The Node server owns this migration (server/src/db.ts initDb) - "
            "deploy and start the updated server once so it adds the column, "
            "then restart this worker."
        )
        sys.exit(2)
    return True


def _fetch_participant_context(
    conn: sqlite3.Connection, participant: str
) -> tuple[str | None, str | None]:
    """(occupation, work_description) from the participants table.

    The table is owned by the Node server and may not exist yet on an older
    deployment; treat any schema error, a missing row, or NULL columns as
    "occupation unknown" instead of crashing.
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
    """Single-worker crash recovery: any row stuck 'processing' is ours to retry."""
    info = conn.execute(
        "UPDATE frames SET vlm_status = 'pending' WHERE vlm_status = 'processing'"
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
    """Atomically mark up to `limit` ready frames 'processing' and return them.

    Ready = anonymized (face_status='done') and not yet described. Claiming up
    front means a crash mid-call leaves them 'processing' (reclaimed on restart)
    rather than silently re-billed.

    Ordering is current-day-first: today's frames (in DRM_TZ) are processed
    before any older backlog, so an evening reconstruction is never stuck behind
    days of catch-up; within each group it's oldest-first, so the oldest
    still-incomplete day is what finishes next. If TZ data is unavailable it
    degrades to newest-first, which still puts today ahead of older days.
    """
    today_start = _today_start_ms()
    if today_start is not None:
        rows = conn.execute(
            """
            SELECT participant, device, session, frame_index, file_path
            FROM frames
            WHERE vlm_status = 'pending' AND face_status = 'done'
            ORDER BY (capture_epoch_ms >= ?) DESC, capture_epoch_ms ASC
            LIMIT ?
            """,
            (today_start, limit),
        ).fetchall()
    else:
        rows = conn.execute(
            """
            SELECT participant, device, session, frame_index, file_path
            FROM frames
            WHERE vlm_status = 'pending' AND face_status = 'done'
            ORDER BY capture_epoch_ms DESC
            LIMIT ?
            """,
            (limit,),
        ).fetchall()
    for row in rows:
        conn.execute(
            """
            UPDATE frames SET vlm_status = 'processing'
            WHERE participant = ? AND device = ? AND session = ? AND frame_index = ?
            """,
            (row["participant"], row["device"], row["session"], row["frame_index"]),
        )
    conn.commit()
    return rows


def _write_result(conn: sqlite3.Connection, row: sqlite3.Row, result: dict) -> None:
    conn.execute(
        """
        UPDATE frames
        SET vlm_status = 'done', vlm_model = ?, vlm_label = ?, vlm_category = ?,
            vlm_description = ?, vlm_descriptor = ?, vlm_completed_at = ?
        WHERE participant = ? AND device = ? AND session = ? AND frame_index = ?
        """,
        (
            VLM_MODEL,
            result["activity"],
            result["category"],
            result["description"],
            json.dumps(result["descriptor"], separators=(",", ":")),
            int(time.time() * 1000),
            row["participant"], row["device"], row["session"], row["frame_index"],
        ),
    )
    conn.commit()


def _mark_failed(conn: sqlite3.Connection, row: sqlite3.Row) -> None:
    conn.execute(
        """
        UPDATE frames SET vlm_status = 'failed', vlm_completed_at = ?
        WHERE participant = ? AND device = ? AND session = ? AND frame_index = ?
        """,
        (
            int(time.time() * 1000),
            row["participant"], row["device"], row["session"], row["frame_index"],
        ),
    )
    conn.commit()


# --- Worker -----------------------------------------------------------------

# Runs in a worker thread: reads the image and calls the endpoint (with retry).
# Deliberately does NO database access — the sqlite3 connection lives on the
# main thread, which writes the outcome this returns. Returns one of:
#   ("done", result_dict) | ("failed", reason_str) | ("skip", reason_str)
def _infer_frame(
    client: OpenAI, row: sqlite3.Row, user_prompt: str
) -> tuple[str, object]:
    abs_path = RECORDINGS_DIR / row["file_path"]
    try:
        image_bytes = abs_path.read_bytes()
    except OSError as exc:
        return ("failed", f"unreadable {row['file_path']}: {exc}")

    last_err = None
    for attempt in range(1, VLM_MAX_RETRIES + 1):
        if _shutdown:
            return ("skip", "shutdown")
        try:
            return ("done", infer(client, image_bytes, user_prompt))
        except Exception as exc:  # noqa: BLE001 - API or parse error; retry then fail
            last_err = exc
            if attempt < VLM_MAX_RETRIES:
                time.sleep(min(2 ** attempt, 10))  # 2s, 4s, 8s backoff

    return ("failed", f"after {VLM_MAX_RETRIES} tries: {repr(last_err)[:200]}")


# Main thread: run a claimed batch through the endpoint VLM_CONCURRENCY-at-a-time
# and persist each outcome as it returns. Returns how many rows reached a
# terminal state (done/failed); 'skip' rows (shutdown mid-flight) are left
# 'processing' and reclaimed on the next start. All DB writes happen here.
def _process_batch(
    conn: sqlite3.Connection,
    client: OpenAI,
    rows: list[sqlite3.Row],
    prompt_cache: dict[str, str],
) -> int:
    settled = 0
    with ThreadPoolExecutor(max_workers=VLM_CONCURRENCY) as pool:
        future_to_row = {
            pool.submit(_infer_frame, client, row, prompt_cache[row["participant"]]): row
            for row in rows
        }
        for future in as_completed(future_to_row):
            row = future_to_row[future]
            status, payload = future.result()
            if status == "done":
                result = payload  # type: ignore[assignment]
                _write_result(conn, row, result)
                _log(
                    f"done {row['file_path']} -> "
                    f"{result['activity']!r} [{result['category']}]"
                )
                settled += 1
            elif status == "failed":
                _log(f"FAILED {row['file_path']} {payload}")
                _mark_failed(conn, row)
                settled += 1
            # status == "skip": leave 'processing' for the startup reclaim
    return settled


def run(once: bool, max_frames: int | None) -> None:
    if not KIT_API_KEY:
        _log("KIT_API_KEY is not set (put it in vlm/.env or the environment)")
        sys.exit(2)

    _log(f"db={RECORDINGS_DB}")
    _log(f"recordings={RECORDINGS_DIR}")
    _log(f"model={VLM_MODEL} via {KIT_BASE_URL}")
    _log(f"concurrency={VLM_CONCURRENCY} (in-flight endpoint calls), batch={BATCH_SIZE}")
    client = OpenAI(api_key=KIT_API_KEY, base_url=KIT_BASE_URL, timeout=VLM_TIMEOUT, max_retries=0)

    schema_checked = False
    if RECORDINGS_DB.exists():
        conn = _connect()
        schema_checked = _ensure_vlm_category_column(conn)  # exits with a clear message if the column is missing
        if schema_checked:
            reclaimed = _reclaim_stale_processing(conn)
            if reclaimed:
                _log(f"reclaimed {reclaimed} interrupted 'processing' row(s)")
        conn.close()

    processed = 0
    while not _shutdown:
        if not RECORDINGS_DB.exists():
            time.sleep(POLL_INTERVAL_S)
            continue
        conn = _connect()
        if not schema_checked:
            schema_checked = _ensure_vlm_category_column(conn)
            if not schema_checked:
                conn.close()
                time.sleep(POLL_INTERVAL_S)
                continue
        # Never claim more than --max still allows, so a capped run leaves no
        # extra rows stranded in 'processing'.
        claim_limit = BATCH_SIZE
        if max_frames is not None:
            claim_limit = min(BATCH_SIZE, max_frames - processed)
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

        # Occupation context is per participant; cache the built prompt per
        # batch (one extra participants-table query per distinct participant).
        # Built here on the main thread — the pool tasks only read this dict.
        prompt_cache: dict[str, str] = {}
        for row in rows:
            participant = row["participant"]
            if participant not in prompt_cache:
                occupation, work_description = _fetch_participant_context(conn, participant)
                prompt_cache[participant] = _build_user_prompt(occupation, work_description)

        processed += _process_batch(conn, client, rows, prompt_cache)
        conn.close()

        if max_frames is not None and processed >= max_frames:
            _log(f"reached --max {max_frames}")
            break

    _log(f"stopping. processed {processed} frame(s) this run.")


def main() -> None:
    parser = argparse.ArgumentParser(description="BLINKS VLM scene-understanding worker")
    parser.add_argument(
        "--once", action="store_true",
        help="process the current backlog and exit (default: poll forever)",
    )
    parser.add_argument(
        "--max", type=int, default=None, metavar="N",
        help="stop after processing N frames (for testing)",
    )
    args = parser.parse_args()

    signal.signal(signal.SIGINT, _handle_signal)
    signal.signal(signal.SIGTERM, _handle_signal)
    run(once=args.once, max_frames=args.max)


if __name__ == "__main__":
    main()
