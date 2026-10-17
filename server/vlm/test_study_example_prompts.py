"""Golden test: the config-driven worker reproduces the paper-study prompts.

fixtures/golden-prompts.json froze the pre-config worker's SYSTEM_PROMPT,
six _build_user_prompt() cases and VLM_RESPONSE_FORMAT (commit a3977ee,
before the hard-coded prompts were deleted). With config/study.example.yaml
the worker must stay byte-identical to them.

A second test renders config/study.test.yaml to prove the templates and the
response schema really follow the config (nothing left hard-coded).

Run from server/vlm:  python -m unittest test_study_example_prompts
Needs: PyYAML, jsonschema (+ the worker's own requirements).
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
REPO_ROOT = HERE.parents[1]
EXAMPLE_PATH = REPO_ROOT / "config" / "study.example.yaml"
TEST_CONFIG_PATH = REPO_ROOT / "config" / "study.test.yaml"
GOLDEN = json.loads((HERE / "fixtures" / "golden-prompts.json").read_text(encoding="utf-8"))

# Pin the example for the in-process import, whatever study.yaml exists locally.
os.environ["BLINKS_STUDY_CONFIG"] = str(EXAMPLE_PATH)
os.environ.pop("NODE_ENV", None)
os.environ.pop("BLINKS_ENV", None)
import vlm_worker  # noqa: E402

sys.path.insert(0, str(HERE.parent))
import blinks_study_config  # noqa: E402


class StudyExampleGoldenTest(unittest.TestCase):
    def test_worker_loaded_the_example(self) -> None:
        self.assertEqual(Path(vlm_worker.STUDY_CONFIG_PATH), EXAMPLE_PATH)

    def test_system_prompt_is_byte_identical(self) -> None:
        self.assertEqual(vlm_worker.SYSTEM_PROMPT, GOLDEN["system"])

    def test_user_prompts_are_byte_identical(self) -> None:
        self.assertEqual(len(GOLDEN["user"]), 6)
        for case in GOLDEN["user"]:
            with self.subTest(occupation=case["occupation"], work=case["work_description"]):
                self.assertEqual(
                    vlm_worker._build_user_prompt(
                        case["occupation"], case["work_description"], case["frame_count"]
                    ),
                    case["prompt"],
                )

    def test_response_format_is_identical(self) -> None:
        self.assertEqual(vlm_worker.VLM_RESPONSE_FORMAT, GOLDEN["response_format"])

    def test_request_parameters_come_from_the_example(self) -> None:
        self.assertEqual(vlm_worker.VLM_MODEL, "azure.gpt-5.6-terra")
        self.assertEqual(vlm_worker.VLM_TEMPERATURE, 0.0)
        self.assertEqual(vlm_worker.VLM_REASONING_EFFORT, "high")
        self.assertEqual(vlm_worker.VLM_MAX_COMPLETION_TOKENS, 8192)
        self.assertEqual(vlm_worker.VLM_CHUNK_MAX_FRAMES, 20)
        self.assertEqual(vlm_worker.CHUNK_WINDOW_MS, 5 * 60 * 1000)
        self.assertEqual(vlm_worker.DRM_TZ, "Europe/Berlin")


class StudyTestConfigRenderingTest(unittest.TestCase):
    """config/study.test.yaml in a fresh interpreter (config loads at import)."""

    def test_worker_follows_a_different_config(self) -> None:
        script = (
            "import json, vlm_worker as w;"
            "print(json.dumps({'system': w.SYSTEM_PROMPT,"
            " 'user': w._build_user_prompt('Nurse', 'night shifts', 4),"
            " 'unknown': w._build_user_prompt('  ', 'x', 1),"
            " 'activities': list(w.ACTIVITY_VOCABULARY), 'categories': list(w.VLM_CATEGORIES),"
            " 'schema_categories': w.VLM_RESPONSE_FORMAT['json_schema']['schema']"
            "['properties']['category_probabilities']['required'],"
            " 'model': w.VLM_MODEL, 'frames': w.VLM_CHUNK_MAX_FRAMES, 'window': w.CHUNK_WINDOW_MS}))"
        )
        env = {"PATH": os.environ.get("PATH", ""), "BLINKS_STUDY_CONFIG": str(TEST_CONFIG_PATH)}
        result = subprocess.run(
            [sys.executable, "-c", script], cwd=HERE, env=env, capture_output=True, text=True
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        out = json.loads(result.stdout.strip().splitlines()[-1])
        self.assertEqual(
            out["system"],
            "[TEST] You classify 10-minute sequences of first-person camera frames into one "
            "of 5 activities. Faces are pixelated; never identify people.",
        )
        self.assertTrue(out["user"].startswith("[TEST] Occupation: Nurse. [TEST] Work: night shifts.\n\n"))
        self.assertIn("[TEST] 4 frames, 10 minutes.", out["user"])
        self.assertIn('- "screen_work": A computer, laptop or monitor is the visible focus.', out["user"])
        self.assertIn('["work", "break"]', out["user"])
        self.assertTrue(out["unknown"].startswith("[TEST] Occupation unknown.\n\n"))
        self.assertEqual(out["activities"], ["screen_work", "conversation", "eating", "moving", "unclear"])
        self.assertEqual(out["categories"], ["work", "break"])
        self.assertEqual(out["schema_categories"], ["work", "break"])
        self.assertEqual([out["model"], out["frames"], out["window"]], ["test-model", 8, 600000])


class LoaderTest(unittest.TestCase):
    def run_loader(self, env: dict[str, str]) -> subprocess.CompletedProcess[str]:
        script = "import blinks_study_config as b; b.load_study_config_or_exit('[t] '); print('LOADED')"
        return subprocess.run(
            [sys.executable, "-c", script],
            cwd=HERE.parent,
            env={"PATH": os.environ.get("PATH", ""), **env},
            capture_output=True,
            text=True,
        )

    def test_invalid_config_exits_2_with_paths(self) -> None:
        broken = Path(self.tmp) / "broken.yaml"
        broken.write_text(
            TEST_CONFIG_PATH.read_text(encoding="utf-8")
            .replace("windowMinutes: 10", "windowMinutes: 7")
            .replace("occupationUnknown: \"[TEST] Occupation unknown.\"", "occupationUnknown: \"{{occupation}}\""),
            encoding="utf-8",
        )
        result = self.run_loader({"BLINKS_STUDY_CONFIG": str(broken)})
        self.assertEqual(result.returncode, 2)
        self.assertIn("[t] FATAL: invalid study config", result.stderr)
        self.assertIn("windowing.windowMinutes: must divide 60 and every UTC offset of Europe/Berlin", result.stderr)
        self.assertIn('vlm.prompts.occupationUnknown: unknown placeholder "{{occupation}}"', result.stderr)

    def test_unknown_field_is_a_shape_error(self) -> None:
        broken = Path(self.tmp) / "unknown.yaml"
        broken.write_text(
            TEST_CONFIG_PATH.read_text(encoding="utf-8").replace("  rate: 0\n", "  rate: 0\n  rat: 1\n"),
            encoding="utf-8",
        )
        result = self.run_loader({"BLINKS_STUDY_CONFIG": str(broken)})
        self.assertEqual(result.returncode, 2)
        self.assertIn("overreliance:", result.stderr)
        self.assertIn("'rat'", result.stderr)

    def test_production_refuses_example(self) -> None:
        for env_name in ("NODE_ENV", "BLINKS_ENV"):
            result = self.run_loader({"BLINKS_STUDY_CONFIG": str(EXAMPLE_PATH), env_name: "production"})
            self.assertEqual(result.returncode, 2, env_name)
            self.assertIn("not allowed in production", result.stderr)
        if not blinks_study_config.DEFAULT_CONFIG_PATH.exists():
            result = self.run_loader({"NODE_ENV": "production"})
            self.assertEqual(result.returncode, 2)
            self.assertIn("Production never falls back", result.stderr)

    def test_missing_explicit_file_exits_2(self) -> None:
        result = self.run_loader({"BLINKS_STUDY_CONFIG": str(Path(self.tmp) / "nope.yaml")})
        self.assertEqual(result.returncode, 2)
        self.assertIn("file not found (BLINKS_STUDY_CONFIG)", result.stderr)

    def production_ready(self, name: str, source: str) -> Path:
        # study.test.yaml uses example.org links on purpose (refused in production)
        import re

        path = Path(self.tmp) / name
        path.write_text(re.sub(r"https://([a-z.]*)example\.org", r"https://\1blinks-test.invalid", source), encoding="utf-8")
        return path

    def test_valid_config_in_production(self) -> None:
        cfg = self.production_ready("prod.yaml", TEST_CONFIG_PATH.read_text(encoding="utf-8"))
        for env_name in ("NODE_ENV", "BLINKS_ENV"):
            result = self.run_loader({"BLINKS_STUDY_CONFIG": str(cfg), env_name: "production"})
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertIn("LOADED", result.stdout)

    def test_production_refuses_placeholders_and_retired_pin(self) -> None:
        import hashlib

        links = self.run_loader({"BLINKS_STUDY_CONFIG": str(TEST_CONFIG_PATH), "BLINKS_ENV": "production"})
        self.assertEqual(links.returncode, 2)
        self.assertIn("surveys.payoutUrl: is a placeholder example.org", links.stderr)

        copy = Path(self.tmp) / "study.yaml"
        copy.write_text(EXAMPLE_PATH.read_text(encoding="utf-8"), encoding="utf-8")
        copied = self.run_loader({"BLINKS_STUDY_CONFIG": str(copy), "BLINKS_ENV": "production"})
        self.assertEqual(copied.returncode, 2)
        self.assertIn("app.studySettingsPin: is the placeholder PIN", copied.stderr)
        self.assertEqual(self.run_loader({"BLINKS_STUDY_CONFIG": str(copy)}).returncode, 0)

        # the retired PIN, found by its hash (not written here in clear text)
        retired = next(
            pin for pin in (f"{n:04d}" for n in range(10_000))
            if hashlib.sha256(pin.encode()).hexdigest() in blinks_study_config.RETIRED_PIN_SHA256
        )
        old = self.production_ready(
            "retired.yaml",
            TEST_CONFIG_PATH.read_text(encoding="utf-8").replace('studySettingsPin: "123456"', f'studySettingsPin: "{retired}"'),
        )
        result = self.run_loader({"BLINKS_STUDY_CONFIG": str(old), "NODE_ENV": "production"})
        self.assertEqual(result.returncode, 2)
        self.assertIn("app.studySettingsPin: is a retired PIN", result.stderr)
        self.assertNotIn(retired, result.stderr)

    def window_issue(self, window: int, time_zone: str = "Europe/Berlin") -> str | None:
        import re

        source = EXAMPLE_PATH.read_text(encoding="utf-8")
        source = re.sub(r"(?m)^  timezone: .*$", f'  timezone: "{time_zone}"', source)
        source = re.sub(r"(?m)^  windowMinutes: .*$", f"  windowMinutes: {window}", source)
        source = re.sub(r"(?m)^  idleCloseMinutes: .*$", f"  idleCloseMinutes: {max(10, window)}", source)
        try:
            blinks_study_config.parse_study_config(source, "inline.yaml")
            return None
        except blinks_study_config.StudyConfigError as exc:
            messages = [message for path, message in exc.issues if path == "windowing.windowMinutes"]
            return messages[0] if messages else None

    def test_window_alignment_review_m3(self) -> None:
        berlin = "1, 2, 3, 4, 5, 6, 10, 12, 15, 20, 30, 60"
        self.assertEqual(", ".join(map(str, blinks_study_config.allowed_window_minutes("Europe/Berlin"))), berlin)
        self.assertEqual(blinks_study_config.allowed_window_minutes("Asia/Kolkata"), [1, 2, 3, 5, 6, 10, 15, 30])
        self.assertEqual(blinks_study_config.time_zone_offsets_minutes("Europe/Berlin"), [60, 120])
        for window in (7, 45, 90, 120):
            message = self.window_issue(window)
            self.assertIsNotNone(message, window)
            self.assertIn("must divide 60 and every UTC offset of Europe/Berlin", message)
            self.assertTrue(message.endswith(f"allowed: {berlin}"), message)
        for window in (5, 30, 60):
            self.assertIsNone(self.window_issue(window), window)
        kolkata = self.window_issue(60, "Asia/Kolkata")
        self.assertIsNotNone(kolkata)
        self.assertTrue(kolkata.endswith("allowed: 1, 2, 3, 5, 6, 10, 15, 30"), kolkata)
        self.assertIsNone(self.window_issue(30, "Asia/Kolkata"))

    def test_dst_days_windows_stay_on_local_marks(self) -> None:
        # Same alignment as chunkStartOf in server/src/db.ts (t - t % W).
        from datetime import datetime, timedelta, timezone
        from zoneinfo import ZoneInfo

        berlin = ZoneInfo("Europe/Berlin")
        window_ms = 5 * 60_000
        for day, expected in (("2026-03-29", 276), ("2026-10-25", 300), ("2026-07-14", 288)):
            start = datetime.fromisoformat(day).replace(tzinfo=berlin)
            end = start + timedelta(days=1)
            end = end.replace(tzinfo=berlin)  # next local midnight (wall clock)
            start_ms = int(start.timestamp() * 1000)
            end_ms = int(end.timestamp() * 1000)
            starts = sorted({t - t % window_ms for t in range(start_ms, end_ms, 60_000)})
            self.assertEqual(len(starts), expected, day)
            self.assertEqual(starts[0], start_ms, day)
            for s in starts:
                first = datetime.fromtimestamp(s / 1000, timezone.utc).astimezone(berlin)
                last = datetime.fromtimestamp((s + window_ms - 1) / 1000, timezone.utc).astimezone(berlin)
                self.assertEqual(first.minute % 5, 0)
                self.assertEqual(first.date().isoformat(), day)
                self.assertEqual(last.date().isoformat(), day)

    def test_overreliance_needs_two_categories(self) -> None:
        source = EXAMPLE_PATH.read_text(encoding="utf-8")
        start = source.index("\ncategories:\n")
        end = source.index("\nexperienceItems:", start)
        first_item = source[start:end].split("\n  - ")[1]
        single = Path(self.tmp) / "one.yaml"
        single.write_text(source[:start] + "\ncategories:\n  - " + first_item + source[end:], encoding="utf-8")
        result = self.run_loader({"BLINKS_STUDY_CONFIG": str(single)})
        self.assertEqual(result.returncode, 2)
        self.assertIn("overreliance.enabled: needs at least 2 categories", result.stderr)

    def setUp(self) -> None:
        import tempfile

        self._tmp = tempfile.TemporaryDirectory()
        self.tmp = self._tmp.name

    def tearDown(self) -> None:
        self._tmp.cleanup()


if __name__ == "__main__":
    unittest.main()
