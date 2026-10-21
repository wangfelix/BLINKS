// Contract test for the activity enum. The server API and the Python VLM
// worker both read activities[] from the study config; a static activity list
// in drm-web, if present, is compared against study.example.yaml.
//
//   npx tsx scripts/test-activity-vocabulary.ts

import assert = require("assert");
import fs = require("fs");
import path = require("path");

import { parse as parseYaml } from "yaml";

import { ACTIVITY_LABELS } from "../src/activity-vocabulary";
import { studyConfig } from "../src/study-config";

const example = parseYaml(
  fs.readFileSync(path.resolve(__dirname, "../../config/study.example.yaml"), "utf8"),
) as { activities: { key: string }[] };
const exampleKeys = example.activities.map((activity) => activity.key);

assert.deepStrictEqual(
  [...ACTIVITY_LABELS],
  studyConfig.activities.map((activity) => activity.key),
  "server API enum = loaded study config",
);
assert.strictEqual(new Set(ACTIVITY_LABELS).size, ACTIVITY_LABELS.length, "server labels are unique");
assert.strictEqual(exampleKeys.length, 17, "the paper taxonomy has 17 labels");

const workerSource = fs.readFileSync(path.resolve(__dirname, "../vlm/vlm_worker.py"), "utf8");
assert.match(
  workerSource,
  /ACTIVITY_DEFINITIONS = \{\s*activity\["key"\]: activity\["vlmDefinition"\] for activity in STUDY_CONFIG\["activities"\]\s*\}/,
  "Python VLM enum is built from the study config",
);
assert.doesNotMatch(workerSource, /"computer_or_monitor_use"/, "no hard-coded label left in the worker");

const webVocabularyPath = path.resolve(__dirname, "../../drm-web/src/lib/activity-vocabulary.ts");
if (fs.existsSync(webVocabularyPath)) {
  const webLabels = [
    ...fs.readFileSync(webVocabularyPath, "utf8").matchAll(/value:\s*"([a-z_]+)"/g),
  ].map((match) => match[1]);
  if (webLabels.length > 0) {
    assert.deepStrictEqual(webLabels, exampleKeys, "legacy drm-web dropdown = paper example");
  }
}

console.log("ACTIVITY VOCABULARY TEST PASSED");
