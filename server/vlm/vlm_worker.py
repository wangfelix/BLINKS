#!/usr/bin/env python3
"""
BLINKS VLM scene-understanding worker.

Polls recordings.db for frames that have been face-anonymized but not yet
described (vlm_status='pending' AND face_status='done'), sends each JPEG to a
Vision Language Model, and writes a per-image scene-state descriptor + label +
description back to the row.

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
                                              writes vlm_label/description/descriptor

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
    BATCH_SIZE        rows fetched per poll       (default: 20)

CLI:
    python vlm_worker.py            # daemon: poll forever
    python vlm_worker.py --once     # process the current backlog, then exit
    python vlm_worker.py --max 50   # stop after N frames (testing)

Single-worker assumption: on startup any row left in 'processing' (from a crash)
is reclaimed to 'pending'. If you ever run more than one VLM worker at once,
switch to a time-based reclaim instead.
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
from pathlib import Path

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
BATCH_SIZE = int(os.environ.get("BATCH_SIZE", "20"))

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


def _build_user_prompt() -> str:
    enums = "\n".join(
        f'  "{k}": one of {v}' for k, v in DESCRIPTOR_ENUMS.items()
    )
    return (
        "Describe this scene and return STRICT JSON only (no prose, no code "
        "fences) with exactly these keys:\n"
        '  "label": a 2-5 word activity summary (string)\n'
        '  "description": one short sentence about the scene (string)\n'
        f"{enums}\n"
        "Pick the single best value for each dimension; use \"unknown\" only "
        "when the frame is genuinely ambiguous."
    )


USER_PROMPT = _build_user_prompt()

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
    """Coerce the model's JSON into our fixed shape (label, description, dims)."""
    label = str(raw.get("label", "")).strip()[:200]
    description = str(raw.get("description", "")).strip()[:1000]
    descriptor = {}
    for key, allowed in DESCRIPTOR_ENUMS.items():
        value = str(raw.get(key, "unknown")).strip().lower()
        descriptor[key] = value if value in allowed else "unknown"
    return {"label": label, "description": description, "descriptor": descriptor}


def infer(client: OpenAI, image_bytes: bytes) -> dict:
    """One VLM call -> normalized {label, description, descriptor}. Raises on failure."""
    b64 = base64.b64encode(image_bytes).decode("ascii")
    response = client.chat.completions.create(
        model=VLM_MODEL,
        temperature=VLM_TEMPERATURE,
        messages=[
            {"role": "system", "content": SYSTEM_PROMPT},
            {
                "role": "user",
                "content": [
                    {"type": "text", "text": USER_PROMPT},
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


def _reclaim_stale_processing(conn: sqlite3.Connection) -> int:
    """Single-worker crash recovery: any row stuck 'processing' is ours to retry."""
    info = conn.execute(
        "UPDATE frames SET vlm_status = 'pending' WHERE vlm_status = 'processing'"
    )
    conn.commit()
    return info.rowcount


def _claim_batch(conn: sqlite3.Connection, limit: int) -> list[sqlite3.Row]:
    """Atomically mark up to `limit` ready frames 'processing' and return them.

    Ready = anonymized (face_status='done') and not yet described. Claiming up
    front means a crash mid-call leaves them 'processing' (reclaimed on restart)
    rather than silently re-billed.
    """
    rows = conn.execute(
        """
        SELECT participant, device, session, frame_index, file_path
        FROM frames
        WHERE vlm_status = 'pending' AND face_status = 'done'
        ORDER BY capture_epoch_ms
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
        SET vlm_status = 'done', vlm_model = ?, vlm_label = ?,
            vlm_description = ?, vlm_descriptor = ?, vlm_completed_at = ?
        WHERE participant = ? AND device = ? AND session = ? AND frame_index = ?
        """,
        (
            VLM_MODEL,
            result["label"],
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

def process_frame(conn: sqlite3.Connection, client: OpenAI, row: sqlite3.Row) -> bool:
    abs_path = RECORDINGS_DIR / row["file_path"]
    try:
        image_bytes = abs_path.read_bytes()
    except OSError as exc:
        _log(f"FAILED unreadable {row['file_path']}: {exc}")
        _mark_failed(conn, row)
        return False

    last_err = None
    for attempt in range(1, VLM_MAX_RETRIES + 1):
        if _shutdown:
            return False
        try:
            result = infer(client, image_bytes)
            _write_result(conn, row, result)
            _log(f"done {row['file_path']} -> {result['label']!r}")
            return True
        except Exception as exc:  # noqa: BLE001 - API or parse error; retry then fail
            last_err = exc
            if attempt < VLM_MAX_RETRIES:
                time.sleep(min(2 ** attempt, 10))  # 2s, 4s, 8s backoff

    _log(f"FAILED {row['file_path']} after {VLM_MAX_RETRIES} tries: {repr(last_err)[:200]}")
    _mark_failed(conn, row)
    return False


def run(once: bool, max_frames: int | None) -> None:
    if not KIT_API_KEY:
        _log("KIT_API_KEY is not set (put it in vlm/.env or the environment)")
        sys.exit(2)

    _log(f"db={RECORDINGS_DB}")
    _log(f"recordings={RECORDINGS_DIR}")
    _log(f"model={VLM_MODEL} via {KIT_BASE_URL}")
    client = OpenAI(api_key=KIT_API_KEY, base_url=KIT_BASE_URL, timeout=VLM_TIMEOUT, max_retries=0)

    if RECORDINGS_DB.exists():
        conn = _connect()
        reclaimed = _reclaim_stale_processing(conn)
        conn.close()
        if reclaimed:
            _log(f"reclaimed {reclaimed} interrupted 'processing' row(s)")

    processed = 0
    while not _shutdown:
        if not RECORDINGS_DB.exists():
            time.sleep(POLL_INTERVAL_S)
            continue
        conn = _connect()
        try:
            rows = _claim_batch(conn, BATCH_SIZE)
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

        for row in rows:
            if _shutdown:
                break
            process_frame(conn, client, row)
            processed += 1
            if max_frames is not None and processed >= max_frames:
                break
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
