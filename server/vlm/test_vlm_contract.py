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


def probability_distribution(
    labels: tuple[str, ...], selected: str, selected_score: float = 0.8
) -> dict[str, float]:
    other_score = (1.0 - selected_score) / (len(labels) - 1)
    return {
        label: selected_score if label == selected else other_score
        for label in labels
    }


class VlmContractTest(unittest.TestCase):
    def test_prompt_uses_incremental_probability_elicitation(self) -> None:
        prompt = vlm_worker._build_user_prompt(
            "researcher", "writing and data analysis", 20
        )
        self.assertIn("Follow these steps internally for activity:", prompt)
        self.assertIn("1. Determine the single most likely activity", prompt)
        self.assertIn("2. Assess confidence", prompt)
        self.assertIn("3. Return the full probability distribution", prompt)
        self.assertIn("Follow the same steps independently for category", prompt)
        self.assertIn('"activity_probabilities"', prompt)
        self.assertIn('"category_probabilities"', prompt)
        self.assertIn("with no reasoning, selected-label fields", prompt)

    def test_closed_activity_enum_and_schema_match(self) -> None:
        self.assertEqual(len(vlm_worker.ACTIVITY_VOCABULARY), 17)
        schema = vlm_worker.VLM_RESPONSE_FORMAT["json_schema"]["schema"]
        self.assertTrue(vlm_worker.VLM_RESPONSE_FORMAT["json_schema"]["strict"])
        self.assertNotIn("activity", schema["properties"])
        self.assertNotIn("category", schema["properties"])
        self.assertEqual(
            set(schema["properties"]),
            {"activity_probabilities", "category_probabilities"},
        )
        confidence_schema = schema["properties"]["activity_probabilities"]
        self.assertEqual(
            set(confidence_schema["required"]),
            set(vlm_worker.ACTIVITY_VOCABULARY),
        )
        self.assertFalse(confidence_schema["additionalProperties"])
        category_schema = schema["properties"]["category_probabilities"]
        self.assertEqual(
            set(category_schema["required"]),
            set(vlm_worker.VLM_CATEGORIES),
        )
        self.assertFalse(category_schema["additionalProperties"])
        self.assertFalse(schema["additionalProperties"])

    def test_valid_result_derives_labels_and_normalizes_probabilities(self) -> None:
        activity_scores = probability_distribution(
            vlm_worker.ACTIVITY_VOCABULARY, "computer_or_monitor_use"
        )
        category_scores = probability_distribution(
            vlm_worker.VLM_CATEGORIES, "work", 0.7
        )
        result = vlm_worker._normalize(
            {
                "activity_probabilities": activity_scores,
                "category_probabilities": category_scores,
            }
        )
        self.assertEqual(result["activity"], "computer_or_monitor_use")
        self.assertEqual(result["category"], "work")
        self.assertAlmostEqual(result["activity_confidence"], 0.8)
        self.assertAlmostEqual(result["category_confidence"], 0.7)
        self.assertAlmostEqual(sum(result["activity_confidences"].values()), 1.0)
        self.assertAlmostEqual(sum(result["category_confidences"].values()), 1.0)
        self.assertEqual(
            set(result["activity_confidences"]),
            set(vlm_worker.ACTIVITY_VOCABULARY),
        )
        self.assertEqual(
            set(result["category_confidences"]),
            set(vlm_worker.VLM_CATEGORIES),
        )
        self.assertNotIn("descriptor", result)
        self.assertNotIn("scene_setting", result)

    def test_activity_distribution_requires_every_label(self) -> None:
        scores = probability_distribution(
            vlm_worker.ACTIVITY_VOCABULARY, "computer_or_monitor_use"
        )
        scores.pop("unclear")
        with self.assertRaisesRegex(ValueError, "exactly every allowed label"):
            vlm_worker._normalize(
                {
                    "activity_probabilities": scores,
                    "category_probabilities": probability_distribution(
                        vlm_worker.VLM_CATEGORIES, "work"
                    ),
                }
            )

    def test_activity_distribution_must_sum_approximately_to_one(self) -> None:
        scores = probability_distribution(
            vlm_worker.ACTIVITY_VOCABULARY, "computer_or_monitor_use"
        )
        scores["unclear"] += 0.1
        with self.assertRaisesRegex(ValueError, "sum approximately to 1"):
            vlm_worker._normalize(
                {
                    "activity_probabilities": scores,
                    "category_probabilities": probability_distribution(
                        vlm_worker.VLM_CATEGORIES, "work"
                    ),
                }
            )

    def test_category_distribution_requires_every_label(self) -> None:
        category_scores = probability_distribution(
            vlm_worker.VLM_CATEGORIES, "work"
        )
        category_scores.pop("other")
        with self.assertRaisesRegex(ValueError, "exactly every allowed label"):
            vlm_worker._normalize(
                {
                    "activity_probabilities": probability_distribution(
                        vlm_worker.ACTIVITY_VOCABULARY,
                        "computer_or_monitor_use",
                    ),
                    "category_probabilities": category_scores,
                }
            )

    def test_argmax_ties_follow_declared_label_order(self) -> None:
        activity_scores = {label: 0.0 for label in vlm_worker.ACTIVITY_VOCABULARY}
        activity_scores["computer_or_monitor_use"] = 0.5
        activity_scores["paper_reading_writing"] = 0.5
        category_scores = {"work": 0.5, "break": 0.5, "other": 0.0}
        result = vlm_worker._normalize(
            {
                "activity_probabilities": activity_scores,
                "category_probabilities": category_scores,
            }
        )
        self.assertEqual(result["activity"], "computer_or_monitor_use")
        self.assertEqual(result["category"], "work")


if __name__ == "__main__":
    unittest.main()
