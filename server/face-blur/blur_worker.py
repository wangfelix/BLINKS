#!/usr/bin/env python3
"""
BLINKS face-anonymization worker.

Polls recordings.db for frames that have not yet been anonymized
(face_status = 'pending'), detects faces with CenterFace (via the `deface`
package), pixelates each detected face, OVERWRITES the original JPEG in place
(no unblurred copy is ever kept), and marks the row 'done'.

This runs as a separate long-lived process, never inline with WebSocket
ingestion, mirroring the VLM service design: detection latency or a crash here
can never cost a frame. The order in the pipeline is deliberate:

    camera -> BLE -> phone -> WS -> server  (writes JPEG + face_status='pending')
                                      |
                                      v
                               [this worker]  detect + mosaic in place -> 'done'
                                      |
                                      v
                               VLM service (later) reads the ALREADY anonymized
                               image, so the VLM (possibly a cloud API) never
                               sees a real face.

The participant read API only serves frames whose face_status='done' (see
server/src/server.ts and db.ts), so an unblurred frame is never exposed even in
the brief window before this worker processes it.

Detection uses CenterFace (the model bundled with `deface`), tuned for recall
over precision: a missed face is a privacy breach, a false positive merely
pixelates a doorknob. The threshold is configurable (FACE_THRESHOLD); the
default matches deface's own default so the method stays citable in the paper.

Idempotency / crash safety: rows stay 'pending' until the JPEG has been
atomically replaced (write to a temp file, then os.replace) AND the DB row
updated. If the process dies mid-frame the row is still 'pending' and is simply
retried on the next run; re-running over an already-blurred frame is a near
no-op (no faces left to detect).

Config (all via environment variables):
    RECORDINGS_DIR    directory holding the recordings tree   (default: ../recordings)
    RECORDINGS_DB     path to recordings.db                   (default: <RECORDINGS_DIR>/recordings.db)
    FACE_THRESHOLD    CenterFace confidence threshold         (default: 0.2)
    FACE_METHOD       'mosaic' (pixelate) or 'blur'           (default: mosaic)
    FACE_BLOCKS       mosaic granularity, smaller = coarser   (default: 8)
    FACE_BLUR_KSIZE   gaussian kernel for method=blur         (default: 0 -> auto)
    FACE_MARGIN       fraction to expand each face box         (default: 0.12)
    POLL_INTERVAL_S   sleep between polls when queue is empty  (default: 2.0)
    BATCH_SIZE        rows fetched per poll                    (default: 50)

CLI:
    python blur_worker.py            # daemon: poll forever
    python blur_worker.py --once     # process the current backlog, then exit
    python blur_worker.py --max 100  # stop after processing N frames (testing)
"""

from __future__ import annotations

import argparse
import os
import signal
import sqlite3
import sys
import time
from pathlib import Path

import cv2
import numpy as np
from deface.centerface import CenterFace

# --- Config -----------------------------------------------------------------

SCRIPT_DIR = Path(__file__).resolve().parent
RECORDINGS_DIR = Path(
    os.environ.get("RECORDINGS_DIR", SCRIPT_DIR.parent / "recordings")
).resolve()
RECORDINGS_DB = Path(
    os.environ.get("RECORDINGS_DB", RECORDINGS_DIR / "recordings.db")
).resolve()

FACE_THRESHOLD = float(os.environ.get("FACE_THRESHOLD", "0.2"))
FACE_METHOD = os.environ.get("FACE_METHOD", "mosaic").lower()
FACE_BLOCKS = int(os.environ.get("FACE_BLOCKS", "8"))
FACE_BLUR_KSIZE = int(os.environ.get("FACE_BLUR_KSIZE", "0"))
FACE_MARGIN = float(os.environ.get("FACE_MARGIN", "0.12"))
POLL_INTERVAL_S = float(os.environ.get("POLL_INTERVAL_S", "2.0"))
BATCH_SIZE = int(os.environ.get("BATCH_SIZE", "50"))

# Recorded in face_method so every anonymized frame stays traceable.
METHOD_TAG = f"{FACE_METHOD}:centerface@{FACE_THRESHOLD}"

_shutdown = False


def _log(msg: str) -> None:
    # flush so lines land in the systemd journal immediately.
    print(f"[face-blur] {msg}", flush=True)


def _handle_signal(signum, _frame) -> None:
    global _shutdown
    _shutdown = True
    _log(f"received signal {signum}, finishing current frame then exiting")


# --- Anonymization ----------------------------------------------------------

def _expand_box(x1: float, y1: float, x2: float, y2: float, w: int, h: int):
    """Pad a detection box by FACE_MARGIN and clamp to the image bounds.

    CenterFace returns a tight box around the face; padding catches the
    forehead, ears and chin that still carry identity.
    """
    bw, bh = x2 - x1, y2 - y1
    nx1 = max(0, int(x1 - FACE_MARGIN * bw))
    ny1 = max(0, int(y1 - FACE_MARGIN * bh))
    nx2 = min(w, int(x2 + FACE_MARGIN * bw))
    ny2 = min(h, int(y2 + FACE_MARGIN * bh))
    return nx1, ny1, nx2, ny2


def _mosaic(roi: np.ndarray) -> np.ndarray:
    rh, rw = roi.shape[:2]
    blocks = max(1, FACE_BLOCKS)
    small = cv2.resize(roi, (blocks, blocks), interpolation=cv2.INTER_LINEAR)
    return cv2.resize(small, (rw, rh), interpolation=cv2.INTER_NEAREST)


def _blur(roi: np.ndarray) -> np.ndarray:
    rh, rw = roi.shape[:2]
    if FACE_BLUR_KSIZE > 0:
        k = FACE_BLUR_KSIZE | 1  # kernel must be odd
    else:
        # auto: kernel scales with face size so small and large faces blur evenly
        k = max(3, (int(max(rw, rh) / 3) | 1))
    return cv2.GaussianBlur(roi, (k, k), 0)


def anonymize(img: np.ndarray, dets: np.ndarray) -> int:
    """Obscure every detected face in `img` in place. Returns the face count."""
    h, w = img.shape[:2]
    count = 0
    for det in dets:
        x1, y1, x2, y2 = _expand_box(det[0], det[1], det[2], det[3], w, h)
        if x2 <= x1 or y2 <= y1:
            continue
        roi = img[y1:y2, x1:x2]
        if roi.size == 0:
            continue
        img[y1:y2, x1:x2] = _blur(roi) if FACE_METHOD == "blur" else _mosaic(roi)
        count += 1
    return count


def _atomic_write_jpeg(path: Path, img: np.ndarray) -> None:
    """Write the JPEG to a temp file in the same dir, then atomically replace.

    Guarantees a reader (the API serving frames) never sees a half-written
    image, and that the original is only ever replaced by a complete blurred one.
    """
    tmp = path.with_name(f".{path.name}.tmp-{os.getpid()}")
    ok, buf = cv2.imencode(".jpg", img, [int(cv2.IMWRITE_JPEG_QUALITY), 90])
    if not ok:
        raise RuntimeError("cv2.imencode failed")
    tmp.write_bytes(buf.tobytes())
    os.replace(tmp, path)  # atomic on the same filesystem


# --- DB ---------------------------------------------------------------------

def _connect() -> sqlite3.Connection:
    conn = sqlite3.connect(str(RECORDINGS_DB), timeout=30.0)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode = WAL")
    conn.execute("PRAGMA synchronous = NORMAL")
    conn.execute("PRAGMA busy_timeout = 5000")
    return conn


def _fetch_pending(conn: sqlite3.Connection, limit: int) -> list[sqlite3.Row]:
    return conn.execute(
        """
        SELECT participant, device, session, frame_index, file_path
        FROM frames
        WHERE face_status = 'pending'
        ORDER BY capture_epoch_ms
        LIMIT ?
        """,
        (limit,),
    ).fetchall()


def _mark(conn: sqlite3.Connection, row: sqlite3.Row, status: str,
          face_count: int | None, completed_at_ms: int | None) -> None:
    conn.execute(
        """
        UPDATE frames
        SET face_status = ?, face_count = ?, face_method = ?, face_completed_at = ?
        WHERE participant = ? AND device = ? AND session = ? AND frame_index = ?
        """,
        (
            status,
            face_count,
            METHOD_TAG if status == "done" else None,
            completed_at_ms,
            row["participant"], row["device"], row["session"], row["frame_index"],
        ),
    )
    conn.commit()


# --- Worker -----------------------------------------------------------------

def process_frame(conn: sqlite3.Connection, cf: CenterFace, row: sqlite3.Row) -> bool:
    """Anonymize one frame. Returns True on success (incl. 0-face frames)."""
    abs_path = RECORDINGS_DIR / row["file_path"]
    now_ms = int(time.time() * 1000)

    img = cv2.imread(str(abs_path))
    if img is None:
        _log(f"FAILED unreadable: {row['file_path']}")
        _mark(conn, row, "failed", None, now_ms)
        return False

    dets, _ = cf(img, threshold=FACE_THRESHOLD)
    n = anonymize(img, dets) if len(dets) else 0

    # Only rewrite the file when we actually changed pixels, so face-free
    # frames are not needlessly recompressed.
    if n > 0:
        try:
            _atomic_write_jpeg(abs_path, img)
        except Exception as exc:  # noqa: BLE001 - log and mark, keep the loop alive
            _log(f"FAILED write {row['file_path']}: {exc}")
            _mark(conn, row, "failed", None, now_ms)
            return False

    _mark(conn, row, "done", n, now_ms)
    if n > 0:
        _log(f"done {row['file_path']} ({n} face{'s' if n != 1 else ''})")
    return True


def run(once: bool, max_frames: int | None) -> None:
    if FACE_METHOD not in ("mosaic", "blur"):
        _log(f"FACE_METHOD must be 'mosaic' or 'blur', got {FACE_METHOD!r}")
        sys.exit(2)
    if not RECORDINGS_DB.exists():
        _log(f"recordings DB not found at {RECORDINGS_DB} (waiting for it)")

    _log(f"db={RECORDINGS_DB}")
    _log(f"recordings={RECORDINGS_DIR}")
    _log(f"method={METHOD_TAG} blocks={FACE_BLOCKS} margin={FACE_MARGIN}")
    cf = CenterFace()
    _log("CenterFace model loaded")

    processed = 0
    while not _shutdown:
        if not RECORDINGS_DB.exists():
            time.sleep(POLL_INTERVAL_S)
            continue
        conn = _connect()
        try:
            rows = _fetch_pending(conn, BATCH_SIZE)
        except sqlite3.OperationalError as exc:
            # e.g. the column does not exist yet because the server has not
            # started once to run the migration. Wait and retry.
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
            process_frame(conn, cf, row)
            processed += 1
            if max_frames is not None and processed >= max_frames:
                break
        conn.close()

        if max_frames is not None and processed >= max_frames:
            _log(f"reached --max {max_frames}")
            break

    _log(f"stopping. processed {processed} frame(s) this run.")


def main() -> None:
    parser = argparse.ArgumentParser(description="BLINKS face-anonymization worker")
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
