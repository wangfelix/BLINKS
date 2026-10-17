"""Golden test (WP0): config/study.example.yaml reproduces today's worker.

Renders the prompt templates from the example config with the REFERENCE
renderer below (the rendering rules fixed in docs/study-config-contract.md)
and asserts byte-identity with the current hard-coded SYSTEM_PROMPT and
_build_user_prompt(). It also checks that the example validates against the
generated JSON Schema and that vocabulary, categories and request parameters
equal today's worker constants.

When the worker is switched to the config (implementation phase), this
renderer moves into the worker and the expected strings are frozen as
fixtures before the hard-coded prompt is deleted.

Run from server/vlm:  python -m unittest test_study_example_prompts
Needs: PyYAML, jsonschema (+ the worker's own requirements).
"""

from __future__ import annotations

import json
import re
import unittest
from pathlib import Path

import jsonschema
import yaml

import vlm_worker

REPO_ROOT = Path(__file__).resolve().parents[2]
EXAMPLE_PATH = REPO_ROOT / "config" / "study.example.yaml"
SCHEMA_PATH = REPO_ROOT / "config" / "study-config.schema.json"

_PLACEHOLDER = re.compile(r"\{\{([^{}]*)\}\}")


def render(template: str, values: dict[str, str]) -> str:
    """Single-pass {{name}} replacement; inserted values are not re-scanned."""

    def replace(match: re.Match[str]) -> str:
        name = match.group(1)
        if name not in values:
            raise KeyError(f"unknown placeholder {{{{{name}}}}}")
        return values[name]

    return _PLACEHOLDER.sub(replace, template)


def occupation_context(config: dict, occupation: str | None, work: str | None) -> str:
    prompts = config["vlm"]["prompts"]
    occupation = (occupation or "").strip()
    work = (work or "").strip()
    if not occupation:
        return render(prompts["occupationUnknown"], {})
    context = render(prompts["occupationKnown"], {"occupation": occupation})
    if work:
        context += render(prompts["workDescription"], {"work_description": work})
    return context


def shared_values(config: dict) -> dict[str, str]:
    activities = config["activities"]
    categories = config["categories"]
    return {
        "window_minutes": str(config["windowing"]["windowMinutes"]),
        "activity_count": str(len(activities)),
        "activity_definitions": "\n".join(
            f'- "{a["key"]}": {a["vlmDefinition"]}' for a in activities
        ),
        "category_keys": "[" + ", ".join(f'"{c["key"]}"' for c in categories) + "]",
        "category_definitions": " ".join(
            f'"{c["key"]}" = {c["vlmDefinition"]}' for c in categories
        ),
    }


def render_system(config: dict) -> str:
    values = shared_values(config)
    return render(
        config["vlm"]["prompts"]["system"],
        {k: values[k] for k in ("window_minutes", "activity_count")},
    )


def render_user(
    config: dict, occupation: str | None, work: str | None, frame_count: int
) -> str:
    values = shared_values(config)
    values["occupation_context"] = occupation_context(config, occupation, work)
    values["frame_count"] = str(frame_count)
    return render(config["vlm"]["prompts"]["user"], values)


class StudyExampleGoldenTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        with EXAMPLE_PATH.open(encoding="utf-8") as handle:
            cls.config = yaml.safe_load(handle)

    def test_example_validates_against_generated_schema(self) -> None:
        schema = json.loads(SCHEMA_PATH.read_text(encoding="utf-8"))
        jsonschema.validate(self.config, schema)

    def test_system_prompt_is_byte_identical(self) -> None:
        self.assertEqual(render_system(self.config), vlm_worker.SYSTEM_PROMPT)

    def test_user_prompt_is_byte_identical(self) -> None:
        cases = [
            ("Software engineer", "Builds backend services", 20),
            ("Software engineer", "", 20),
            ("  PhD student  ", None, 7),
            (None, "ignored without occupation", 1),
            ("", "", 13),
            ("Uses {{frame_count}} literally", "and {{occupation}}", 3),
        ]
        for occupation, work, frame_count in cases:
            with self.subTest(occupation=occupation, work=work, frames=frame_count):
                self.assertEqual(
                    render_user(self.config, occupation, work, frame_count),
                    vlm_worker._build_user_prompt(occupation, work, frame_count),
                )

    def test_vocabulary_and_categories_match_worker(self) -> None:
        self.assertEqual(
            {a["key"]: a["vlmDefinition"] for a in self.config["activities"]},
            vlm_worker.ACTIVITY_DEFINITIONS,
        )
        self.assertEqual(
            [a["key"] for a in self.config["activities"]],
            list(vlm_worker.ACTIVITY_VOCABULARY),
        )
        self.assertEqual(
            tuple(c["key"] for c in self.config["categories"]),
            vlm_worker.VLM_CATEGORIES,
        )

    def test_request_parameters_match_worker_defaults(self) -> None:
        vlm = self.config["vlm"]
        self.assertEqual(vlm["model"], "azure.gpt-5.6-terra")
        self.assertEqual(float(vlm["request"]["temperature"]), 0.0)
        self.assertEqual(vlm["request"]["reasoningEffort"], "high")
        self.assertEqual(vlm["request"]["maxCompletionTokens"], 8192)
        self.assertEqual(vlm["maxFramesPerWindow"], 20)
        self.assertEqual(
            self.config["windowing"]["windowMinutes"] * 60 * 1000,
            vlm_worker.CHUNK_WINDOW_MS,
        )
        self.assertEqual(self.config["study"]["timezone"], "Europe/Berlin")


if __name__ == "__main__":
    unittest.main()
