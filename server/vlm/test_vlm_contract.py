"""Offline contract tests for the constrained VLM output shape."""

import sys
import types
import unittest

# The contract can be tested without installing the network client.
dotenv_stub = types.ModuleType("dotenv")
dotenv_stub.load_dotenv = lambda *args, **kwargs: None
openai_stub = types.ModuleType("openai")
openai_stub.OpenAI = object
sys.modules.setdefault("dotenv", dotenv_stub)
sys.modules.setdefault("openai", openai_stub)

import vlm_worker  # noqa: E402


class VlmContractTest(unittest.TestCase):
    def test_closed_activity_enum_and_schema_match(self) -> None:
        self.assertEqual(len(vlm_worker.ACTIVITY_VOCABULARY), 17)
        schema = vlm_worker.VLM_RESPONSE_FORMAT["json_schema"]["schema"]
        self.assertTrue(vlm_worker.VLM_RESPONSE_FORMAT["json_schema"]["strict"])
        self.assertEqual(
            schema["properties"]["activity"]["enum"],
            list(vlm_worker.ACTIVITY_VOCABULARY),
        )
        self.assertEqual(
            schema["properties"]["category"]["enum"],
            list(vlm_worker.VLM_CATEGORIES),
        )
        self.assertFalse(schema["additionalProperties"])

    def test_valid_result_contains_only_current_outputs(self) -> None:
        result = vlm_worker._normalize(
            {
                "activity": "computer_or_monitor_use",
                "category": "work",
                "description": "  Hands are visible at a laptop keyboard.  ",
            }
        )
        self.assertEqual(
            result,
            {
                "activity": "computer_or_monitor_use",
                "category": "work",
                "description": "Hands are visible at a laptop keyboard.",
            },
        )
        self.assertNotIn("descriptor", result)
        self.assertNotIn("scene_setting", result)

    def test_off_enum_activity_is_rejected(self) -> None:
        with self.assertRaisesRegex(ValueError, "off-vocabulary activity"):
            vlm_worker._normalize(
                {
                    "activity": "free text",
                    "category": "work",
                    "description": "Visible evidence.",
                }
            )

    def test_off_enum_category_is_rejected(self) -> None:
        with self.assertRaisesRegex(ValueError, "invalid category"):
            vlm_worker._normalize(
                {
                    "activity": "other",
                    "category": "leisure",
                    "description": "Visible evidence.",
                }
            )


if __name__ == "__main__":
    unittest.main()
