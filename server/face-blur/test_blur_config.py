"""Config tests for the face-blur worker (no OpenCV/deface needed).

cv2, numpy and deface are stubbed, so this only covers what the study config
controls: parameters, METHOD_TAG, and the enabled=false exit path
(docs/study-config-contract.md section 6).

Run from server/face-blur:  python -m unittest test_blur_config
"""

from __future__ import annotations

import os
import sqlite3
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
REPO_ROOT = HERE.parents[1]
EXAMPLE = REPO_ROOT / "config" / "study.example.yaml"
TEST_CONFIG = REPO_ROOT / "config" / "study.test.yaml"

STUB = """
import sys, types
for name in ("cv2", "numpy", "deface", "deface.centerface"):
    sys.modules[name] = types.ModuleType(name)
class CenterFace:
    def __init__(self):
        print("[stub] CenterFace loaded", flush=True)
    def __call__(self, img, threshold):
        return [], None
sys.modules["deface.centerface"].CenterFace = CenterFace
sys.modules["numpy"].ndarray = object
"""


def run_worker(config: Path, code: str, extra_env: dict[str, str] | None = None):
    env = {"PATH": os.environ.get("PATH", ""), "BLINKS_STUDY_CONFIG": str(config), **(extra_env or {})}
    return subprocess.run(
        [sys.executable, "-c", STUB + code], cwd=HERE, env=env, capture_output=True, text=True
    )


def make_frames_db(recordings: Path) -> None:
    conn = sqlite3.connect(recordings / "recordings.db")
    conn.execute(
        "CREATE TABLE frames (participant TEXT, device TEXT, session INTEGER, frame_index INTEGER,"
        " file_path TEXT, face_status TEXT, face_count INTEGER, face_method TEXT,"
        " face_completed_at INTEGER, deleted_at INTEGER, capture_epoch_ms INTEGER,"
        " received_epoch_ms INTEGER)"
    )
    conn.commit()
    conn.close()


class BlurConfigTest(unittest.TestCase):
    def test_paper_parameters_and_method_tag(self) -> None:
        result = run_worker(
            EXAMPLE,
            "import blur_worker as b; print(b.FACE_BLUR_ENABLED, b.FACE_THRESHOLD, b.FACE_METHOD,"
            " b.FACE_BLOCKS, b.FACE_BLUR_KSIZE, b.FACE_MARGIN, b.METHOD_TAG)",
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stdout.split(), ["True", "0.2", "mosaic", "8", "0", "0.12", "mosaic:centerface@0.2"])

    def test_test_config_parameters(self) -> None:
        result = run_worker(TEST_CONFIG, "import blur_worker as b; print(b.METHOD_TAG, b.FACE_BLOCKS, b.FACE_MARGIN)")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stdout.split(), ["blur:centerface@0.3", "6", "0.1"])

    def test_invalid_config_exits_2(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            broken = Path(tmp) / "broken.yaml"
            broken.write_text(
                TEST_CONFIG.read_text(encoding="utf-8").replace("method: blur", "method: pixelate"),
                encoding="utf-8",
            )
            result = run_worker(broken, "import blur_worker")
            self.assertEqual(result.returncode, 2)
            self.assertIn("privacy.faceBlur.method", result.stderr)

    def test_disabled_processes_backlog_once_then_exits_3_or_0(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            cfg = Path(tmp) / "noblur.yaml"
            cfg.write_text(
                TEST_CONFIG.read_text(encoding="utf-8").replace(
                    "faceBlur:\n    enabled: true", "faceBlur:\n    enabled: false"
                ),
                encoding="utf-8",
            )
            recordings = Path(tmp) / "recordings"
            recordings.mkdir()
            make_frames_db(recordings)
            result = run_worker(
                cfg,
                "import sys, blur_worker as b; sys.argv=['blur_worker.py']; b.main()",
                {"RECORDINGS_DIR": str(recordings), "POLL_INTERVAL_S": "0.01"},
            )
            # daemon mode: EXIT_DISABLED, which the systemd unit does not restart
            self.assertEqual(result.returncode, 3, result.stderr + result.stdout)
            self.assertIn("NOTICE: privacy.faceBlur.enabled=false", result.stdout)
            self.assertIn("sent to the VLM endpoint", result.stdout)
            self.assertIn("face blur disabled: exiting (3)", result.stdout)
            once = run_worker(
                cfg,
                "import sys, blur_worker as b; sys.argv=['blur_worker.py', '--once']; b.main()",
                {"RECORDINGS_DIR": str(recordings), "POLL_INTERVAL_S": "0.01"},
            )
            self.assertEqual(once.returncode, 0, once.stderr + once.stdout)
            self.assertIn("face blur disabled: exiting (0)", once.stdout)

    def test_retired_env_vars_are_reported(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            make_frames_db(Path(tmp))
            result = run_worker(
                EXAMPLE,
                "import sys, blur_worker as b; sys.argv=['blur_worker.py', '--once']; b.main()",
                {"RECORDINGS_DIR": tmp, "FACE_THRESHOLD": "0.5"},
            )
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertIn("ignoring retired env var(s) FACE_THRESHOLD", result.stdout)
            self.assertIn("method=mosaic:centerface@0.2", result.stdout)


if __name__ == "__main__":
    unittest.main()
