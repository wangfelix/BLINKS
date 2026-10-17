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
        self.assertIn("windowing.windowMinutes: must divide 24 h", result.stderr)
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

    def test_valid_config_in_production(self) -> None:
        result = self.run_loader({"BLINKS_STUDY_CONFIG": str(TEST_CONFIG_PATH), "NODE_ENV": "production"})
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("LOADED", result.stdout)

    def setUp(self) -> None:
        import tempfile

        self._tmp = tempfile.TemporaryDirectory()
        self.tmp = self._tmp.name

    def tearDown(self) -> None:
        self._tmp.cleanup()


if __name__ == "__main__":
    unittest.main()
