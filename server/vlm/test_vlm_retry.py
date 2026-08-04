"""Offline tests for persistent VLM retries and continuous slot refill."""

from __future__ import annotations

import sqlite3
import sys
import tempfile
import threading
import types
import unittest
from pathlib import Path
from unittest.mock import patch

dotenv_stub = types.ModuleType("dotenv")
dotenv_stub.load_dotenv = lambda *args, **kwargs: None
openai_stub = types.ModuleType("openai")
openai_stub.OpenAI = object
sys.modules.setdefault("dotenv", dotenv_stub)
sys.modules.setdefault("openai", openai_stub)

import vlm_worker  # noqa: E402


def create_retry_db(path: Path) -> sqlite3.Connection:
    conn = sqlite3.connect(path)
    conn.row_factory = sqlite3.Row
    conn.executescript(
        """
        PRAGMA foreign_keys = ON;
        CREATE TABLE frames (
          participant TEXT NOT NULL,
          chunk_start_ms INTEGER,
          capture_epoch_ms INTEGER NOT NULL,
          file_path TEXT NOT NULL,
          face_status TEXT NOT NULL,
          deleted_at INTEGER
        );
        CREATE TABLE chunks (
          participant TEXT NOT NULL,
          chunk_start_ms INTEGER NOT NULL,
          chunk_end_ms INTEGER NOT NULL,
          status TEXT NOT NULL,
          vlm_model TEXT,
          vlm_label TEXT,
          vlm_category TEXT,
          vlm_completed_at INTEGER,
          updated_at INTEGER,
          vlm_activity_confidence REAL,
          vlm_activity_confidences_json TEXT,
          vlm_category_confidence REAL,
          vlm_category_confidences_json TEXT,
          vlm_attempt_count INTEGER NOT NULL DEFAULT 0,
          vlm_retry_count INTEGER NOT NULL DEFAULT 0,
          vlm_next_attempt_at INTEGER,
          vlm_last_error_type TEXT,
          PRIMARY KEY (participant, chunk_start_ms)
        );
        CREATE TABLE vlm_attempts (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          participant TEXT NOT NULL,
          chunk_start_ms INTEGER NOT NULL,
          attempt_number INTEGER NOT NULL,
          retry_number INTEGER NOT NULL,
          model TEXT NOT NULL,
          started_at INTEGER NOT NULL,
          completed_at INTEGER,
          duration_ms INTEGER,
          frames_sent INTEGER NOT NULL,
          timeout_seconds REAL NOT NULL,
          outcome TEXT,
          error_class TEXT,
          http_status INTEGER,
          UNIQUE (participant, chunk_start_ms, attempt_number)
        );
        """
    )
    return conn


def add_chunk(
    conn: sqlite3.Connection,
    start_ms: int,
    *,
    attempt_count: int = 0,
    retry_count: int = 0,
    next_attempt_at: int | None = None,
) -> None:
    conn.execute(
        """
        INSERT INTO chunks (
          participant, chunk_start_ms, chunk_end_ms, status,
          vlm_attempt_count, vlm_retry_count, vlm_next_attempt_at
        ) VALUES ('p', ?, ?, 'ready', ?, ?, ?)
        """,
        (
            start_ms,
            start_ms + vlm_worker.CHUNK_WINDOW_MS,
            attempt_count,
            retry_count,
            next_attempt_at,
        ),
    )
    conn.commit()


def valid_result() -> dict:
    activity_score = 1.0 / len(vlm_worker.ACTIVITY_VOCABULARY)
    category_score = 1.0 / len(vlm_worker.VLM_CATEGORIES)
    return {
        "activity": vlm_worker.ACTIVITY_VOCABULARY[0],
        "category": vlm_worker.VLM_CATEGORIES[0],
        "activity_confidence": activity_score,
        "activity_confidences": {
            label: activity_score for label in vlm_worker.ACTIVITY_VOCABULARY
        },
        "category_confidence": category_score,
        "category_confidences": {
            label: category_score for label in vlm_worker.VLM_CATEGORIES
        },
    }


class VlmRetryTest(unittest.TestCase):
    def setUp(self) -> None:
        self.temp_dir = tempfile.TemporaryDirectory()
        self.root = Path(self.temp_dir.name)
        self.db_path = self.root / "recordings.db"
        self.conn = create_retry_db(self.db_path)

    def tearDown(self) -> None:
        self.conn.close()
        self.temp_dir.cleanup()

    def test_endpoint_failures_are_classified_for_analysis(self) -> None:
        api_timeout = type("APITimeoutError", (Exception,), {})
        self.assertEqual(
            vlm_worker._classify_exception(api_timeout("slow")),
            ("timeout", "APITimeoutError", None),
        )
        server_error = type("InternalServerError", (Exception,), {"status_code": 503})
        self.assertEqual(
            vlm_worker._classify_exception(server_error("unavailable")),
            ("server_error", "InternalServerError", 503),
        )
        self.assertEqual(
            vlm_worker._classify_exception(ValueError("invalid distribution")),
            ("validation_error", "ValueError", None),
        )

    def test_timeout_is_audited_and_deferred(self) -> None:
        add_chunk(self.conn, 300_000)
        with (
            patch.object(vlm_worker, "VLM_MAX_ATTEMPTS", 5),
            patch.object(vlm_worker, "VLM_RETRY_DELAYS_S", (30.0, 120.0)),
            patch.object(vlm_worker.time, "time", return_value=1_000.0),
        ):
            row = vlm_worker._claim_batch(self.conn, 1, now_ms=1_000_000)[0]
            attempt_id = vlm_worker._start_attempt(self.conn, row, 20)
            disposition, delay_ms = vlm_worker._settle_attempt(
                self.conn,
                row,
                attempt_id,
                vlm_worker.AttemptResult(
                    "timeout", None, 120_000, "APITimeoutError"
                ),
            )

        self.assertEqual((disposition, delay_ms), ("retry", 30_000))
        chunk = self.conn.execute(
            "SELECT status, vlm_attempt_count, vlm_retry_count, "
            "vlm_next_attempt_at, vlm_last_error_type FROM chunks"
        ).fetchone()
        self.assertEqual(
            tuple(chunk), ("ready", 1, 1, 1_030_000, "timeout")
        )
        attempt = self.conn.execute(
            "SELECT attempt_number, retry_number, model, frames_sent, "
            "timeout_seconds, outcome, error_class FROM vlm_attempts"
        ).fetchone()
        self.assertEqual(
            tuple(attempt),
            (1, 1, vlm_worker.VLM_MODEL, 20, 120.0, "timeout", "APITimeoutError"),
        )

    def test_retry_wait_is_not_claimed_early(self) -> None:
        add_chunk(self.conn, 300_000, next_attempt_at=2_000)
        self.assertEqual(vlm_worker._claim_batch(self.conn, 1, now_ms=1_999), [])
        self.assertEqual(len(vlm_worker._claim_batch(self.conn, 1, now_ms=2_000)), 1)

    def test_fifth_failure_becomes_terminal(self) -> None:
        add_chunk(self.conn, 300_000, attempt_count=4, retry_count=4)
        with patch.object(vlm_worker, "VLM_MAX_ATTEMPTS", 5):
            row = vlm_worker._claim_batch(self.conn, 1, now_ms=1_000)[0]
            attempt_id = vlm_worker._start_attempt(self.conn, row, 20)
            disposition, delay_ms = vlm_worker._settle_attempt(
                self.conn,
                row,
                attempt_id,
                vlm_worker.AttemptResult(
                    "server_error", None, 12_000, "InternalServerError", 503
                ),
            )

        self.assertEqual((disposition, delay_ms), ("failed", None))
        chunk = self.conn.execute(
            "SELECT status, vlm_attempt_count, vlm_retry_count, "
            "vlm_next_attempt_at, vlm_last_error_type FROM chunks"
        ).fetchone()
        self.assertEqual(tuple(chunk), ("failed", 5, 5, None, "server_error"))

    def test_startup_reclaims_and_audits_interrupted_attempt(self) -> None:
        add_chunk(self.conn, 300_000)
        with patch.object(vlm_worker.time, "time", return_value=1_000.0):
            row = vlm_worker._claim_batch(self.conn, 1, now_ms=900_000)[0]
            vlm_worker._start_attempt(self.conn, row, 20)
            reclaimed = vlm_worker._reclaim_stale_processing(self.conn)

        self.assertEqual(reclaimed, 1)
        self.assertEqual(
            tuple(
                self.conn.execute(
                    "SELECT status, vlm_next_attempt_at, vlm_last_error_type FROM chunks"
                ).fetchone()
            ),
            ("ready", 1_000_000, "interrupted"),
        )
        self.assertEqual(
            tuple(
                self.conn.execute(
                    "SELECT outcome, error_class FROM vlm_attempts"
                ).fetchone()
            ),
            ("interrupted", "WorkerInterrupted"),
        )

    def test_completed_slot_is_refilled_before_slow_call_finishes(self) -> None:
        for index, start_ms in enumerate((300_000, 600_000, 900_000), start=1):
            add_chunk(self.conn, start_ms)
            filename = f"{index}.jpg"
            (self.root / filename).write_bytes(str(index).encode())
            self.conn.execute(
                """
                INSERT INTO frames (
                  participant, chunk_start_ms, capture_epoch_ms, file_path,
                  face_status, deleted_at
                ) VALUES ('p', ?, ?, ?, 'done', NULL)
                """,
                (start_ms, start_ms, filename),
            )
        self.conn.commit()
        self.conn.close()

        slow_started = threading.Event()
        release_slow = threading.Event()
        third_started = threading.Event()
        errors: list[BaseException] = []

        def fake_infer(_client, images: list[bytes], _prompt: str) -> dict:
            frame_id = images[0]
            if frame_id == b"1":
                slow_started.set()
                if not release_slow.wait(timeout=2):
                    raise TimeoutError("test did not release slow request")
            elif frame_id == b"3":
                third_started.set()
            return valid_result()

        def run_worker() -> None:
            try:
                vlm_worker.run(once=True, max_chunks=3)
            except BaseException as exc:  # surface worker-thread failures
                errors.append(exc)

        with (
            patch.object(vlm_worker, "RECORDINGS_DIR", self.root),
            patch.object(vlm_worker, "RECORDINGS_DB", self.db_path),
            patch.object(vlm_worker, "KIT_API_KEY", "test-key"),
            patch.object(vlm_worker, "OpenAI", return_value=object()),
            patch.object(vlm_worker, "infer", side_effect=fake_infer),
            patch.object(vlm_worker, "VLM_CONCURRENCY", 2),
            patch.object(vlm_worker, "BATCH_SIZE", 2),
            patch.object(vlm_worker, "VLM_MAX_ATTEMPTS", 1),
            patch.object(vlm_worker, "POLL_INTERVAL_S", 0.01),
            patch.object(vlm_worker, "_shutdown", False),
        ):
            worker = threading.Thread(target=run_worker, daemon=True)
            worker.start()
            self.assertTrue(slow_started.wait(timeout=1))
            self.assertTrue(
                third_started.wait(timeout=1),
                "third request should start while the first is still blocked",
            )
            self.assertFalse(release_slow.is_set())
            release_slow.set()
            worker.join(timeout=2)
            self.assertFalse(worker.is_alive())

        self.assertEqual(errors, [])
        verify = sqlite3.connect(self.db_path)
        self.assertEqual(
            verify.execute("SELECT COUNT(*) FROM chunks WHERE status='done'").fetchone()[0],
            3,
        )
        self.assertEqual(
            verify.execute("SELECT COUNT(*) FROM vlm_attempts WHERE outcome='done'").fetchone()[0],
            3,
        )
        verify.close()
        self.conn = sqlite3.connect(self.db_path)


if __name__ == "__main__":
    unittest.main()
