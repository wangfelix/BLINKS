"""Study config loader for the Python workers (BLINKS-tasks#4).

Shared by server/vlm/vlm_worker.py and server/face-blur/blur_worker.py, so
both validate the SAME file the Node server validates
(docs/study-config-contract.md, section 1):

  1. YAML parse, 2. shape via jsonschema against config/study-config.schema.json
  (generated from server/src/study-config/schema.ts), 3. the cross-checks
  marked [py], 4. on any error: every issue as `path.to.field: reason` on
  stderr and exit code 2.

Resolution (identical to server/src/study-config/load.ts):
  - env BLINKS_STUDY_CONFIG (absolute or relative to the working dir); a
    missing file is fatal
  - <repo>/config/study.yaml
  - <repo>/config/study.example.yaml ONLY outside production, with a warning.
    Production = NODE_ENV=production or BLINKS_ENV=production (F1). The
    example is refused in production even when named explicitly.

Only default: privacy.faceBlur.enabled = True (set explicitly here).
"""

from __future__ import annotations

import json
import os
import re
import sys
from pathlib import Path
from typing import Any
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

import jsonschema
import yaml

REPO_ROOT = Path(__file__).resolve().parent.parent
DEFAULT_CONFIG_PATH = REPO_ROOT / "config" / "study.yaml"
EXAMPLE_CONFIG_PATH = REPO_ROOT / "config" / "study.example.yaml"
SCHEMA_PATH = REPO_ROOT / "config" / "study-config.schema.json"

# Must match PROMPT_PLACEHOLDERS in server/src/study-config/schema.ts.
PROMPT_PLACEHOLDERS: dict[str, tuple[str, ...]] = {
    "system": ("window_minutes", "activity_count"),
    "user": (
        "occupation_context",
        "frame_count",
        "window_minutes",
        "activity_count",
        "activity_definitions",
        "category_keys",
        "category_definitions",
    ),
    "occupationKnown": ("occupation",),
    "workDescription": ("work_description",),
    "occupationUnknown": (),
}
_PLACEHOLDER = re.compile(r"\{\{([^{}]*)\}\}")


class StudyConfigError(Exception):
    def __init__(self, config_path: Path | str, issues: list[tuple[str, str]]):
        self.config_path = str(config_path)
        self.issues = issues
        lines = "\n".join(f"  {path or '(root)'}: {message}" for path, message in issues)
        super().__init__(f"invalid study config {self.config_path}:\n{lines}")


def is_production(env: dict[str, str] | None = None) -> bool:
    env = os.environ if env is None else env
    return env.get("NODE_ENV") == "production" or env.get("BLINKS_ENV") == "production"


def resolve_config_path(
    env: dict[str, str] | None = None, cwd: Path | None = None
) -> tuple[Path, bool]:
    """-> (path, using_example). Raises StudyConfigError."""
    env = os.environ if env is None else env
    explicit = (env.get("BLINKS_STUDY_CONFIG") or "").strip()
    if explicit:
        resolved = ((cwd or Path.cwd()) / explicit).resolve()
        if not resolved.exists():
            raise StudyConfigError(resolved, [("", "file not found (BLINKS_STUDY_CONFIG)")])
        using_example = resolved == EXAMPLE_CONFIG_PATH.resolve()
        if using_example and is_production(env):
            raise StudyConfigError(
                resolved,
                [("", "the example config (placeholder surveys and PIN) is not allowed in production")],
            )
        return resolved, using_example
    if DEFAULT_CONFIG_PATH.exists():
        return DEFAULT_CONFIG_PATH, False
    if is_production(env):
        raise StudyConfigError(
            DEFAULT_CONFIG_PATH,
            [(
                "",
                "file not found. Production never falls back to study.example.yaml; "
                "create config/study.yaml (see config/README.md)",
            )],
        )
    return EXAMPLE_CONFIG_PATH, True


def _json_path(error: jsonschema.ValidationError) -> str:
    return ".".join(str(part) for part in error.absolute_path)


def _cross_check_issues(config: dict[str, Any]) -> list[tuple[str, str]]:
    """The cross-checks marked [py] in the contract (section 1)."""
    issues: list[tuple[str, str]] = []

    def unique(items: list[dict], path: str) -> None:
        seen: set[str] = set()
        for index, item in enumerate(items):
            if item["key"] in seen:
                issues.append((f"{path}.{index}.key", f'duplicate key "{item["key"]}"'))
            seen.add(item["key"])

    unique(config["activities"], "activities")
    unique(config["categories"], "categories")
    unique(config["experienceItems"], "experienceItems")
    unique(config["devices"]["formFactors"], "devices.formFactors")

    window_minutes = config["windowing"]["windowMinutes"]
    for key, interval_ms in config["capture"]["intervalMsByFormFactor"].items():
        if interval_ms >= window_minutes * 60_000:
            issues.append(
                (f"capture.intervalMsByFormFactor.{key}", "must be shorter than windowing.windowMinutes")
            )
    if 1440 % window_minutes != 0:
        issues.append(("windowing.windowMinutes", "must divide 24 h (1440 min) without remainder"))
    if config["windowing"]["idleCloseMinutes"] < window_minutes:
        issues.append(("windowing.idleCloseMinutes", "must be >= windowing.windowMinutes"))

    for name, allowed in PROMPT_PLACEHOLDERS.items():
        for match in _PLACEHOLDER.finditer(config["vlm"]["prompts"][name]):
            if match.group(1) not in allowed:
                issues.append((
                    f"vlm.prompts.{name}",
                    f'unknown placeholder "{{{{{match.group(1)}}}}}" '
                    f"(allowed: {', '.join(allowed) if allowed else 'none'})",
                ))

    try:
        ZoneInfo(config["study"]["timezone"])
    except (ZoneInfoNotFoundError, ValueError):
        issues.append(("study.timezone", "unknown IANA timezone"))
    return issues


def parse_study_config(source: str, config_path: Path | str) -> dict[str, Any]:
    try:
        raw = yaml.safe_load(source)
    except yaml.YAMLError as exc:
        raise StudyConfigError(config_path, [("", f"YAML syntax error: {exc}")]) from exc
    schema = json.loads(SCHEMA_PATH.read_text(encoding="utf-8"))
    validator = jsonschema.Draft202012Validator(schema)
    errors = sorted(validator.iter_errors(raw), key=lambda e: list(map(str, e.absolute_path)))
    if errors:
        raise StudyConfigError(config_path, [(_json_path(e), e.message) for e in errors])
    config = raw
    config["privacy"]["faceBlur"].setdefault("enabled", True)
    issues = _cross_check_issues(config)
    if issues:
        raise StudyConfigError(config_path, issues)
    return config


def load_study_config_file(config_path: Path | str) -> dict[str, Any]:
    return parse_study_config(Path(config_path).read_text(encoding="utf-8"), config_path)


def load_study_config_or_exit(log_prefix: str = "") -> tuple[dict[str, Any], Path]:
    """Load once at worker start. Prints FATAL and exits 2 on any problem."""
    try:
        config_path, using_example = resolve_config_path()
        config = load_study_config_file(config_path)
    except StudyConfigError as exc:
        print(f"{log_prefix}FATAL: {exc}", file=sys.stderr, flush=True)
        sys.exit(2)
    if using_example:
        print(
            f"{log_prefix}WARNING: using config/study.example.yaml (placeholder survey "
            "links and PIN). Never run a study like this.",
            file=sys.stderr,
            flush=True,
        )
    return config, config_path


# --- Prompt templates (contract section 3, golden-tested) ---------------------

def render_template(template: str, values: dict[str, str]) -> str:
    """Single-pass {{name}} replacement; inserted values are not re-scanned."""

    def replace(match: re.Match[str]) -> str:
        name = match.group(1)
        if name not in values:
            raise KeyError(f"unknown placeholder {{{{{name}}}}}")
        return values[name]

    return _PLACEHOLDER.sub(replace, template)


def _shared_prompt_values(config: dict[str, Any]) -> dict[str, str]:
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


def render_system_prompt(config: dict[str, Any]) -> str:
    values = _shared_prompt_values(config)
    return render_template(
        config["vlm"]["prompts"]["system"],
        {key: values[key] for key in PROMPT_PLACEHOLDERS["system"]},
    )


def render_occupation_context(
    config: dict[str, Any], occupation: str | None, work_description: str | None
) -> str:
    prompts = config["vlm"]["prompts"]
    occupation = (occupation or "").strip()
    work_description = (work_description or "").strip()
    if not occupation:
        return render_template(prompts["occupationUnknown"], {})
    context = render_template(prompts["occupationKnown"], {"occupation": occupation})
    if work_description:
        context += render_template(
            prompts["workDescription"], {"work_description": work_description}
        )
    return context


def render_user_prompt(
    config: dict[str, Any],
    occupation: str | None,
    work_description: str | None,
    frame_count: int,
) -> str:
    values = _shared_prompt_values(config)
    values["occupation_context"] = render_occupation_context(
        config, occupation, work_description
    )
    values["frame_count"] = str(frame_count)
    return render_template(config["vlm"]["prompts"]["user"], values)
