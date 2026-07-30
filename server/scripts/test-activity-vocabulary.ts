// Contract test for the activity enum copied across the Python VLM worker,
// TypeScript API, and Next.js participant dropdown.
//
//   node --import tsx scripts/test-activity-vocabulary.ts

import assert = require("assert");
import fs = require("fs");
import path = require("path");

import { ACTIVITY_LABELS } from "../src/activity-vocabulary";

const workerSource = fs.readFileSync(
  path.resolve(__dirname, "../vlm/vlm_worker.py"),
  "utf8",
);
const webVocabularySource = fs.readFileSync(
  path.resolve(__dirname, "../../drm-web/src/lib/activity-vocabulary.ts"),
  "utf8",
);

const pythonDefinitions = workerSource.slice(
  workerSource.indexOf("ACTIVITY_DEFINITIONS = {"),
  workerSource.indexOf("ACTIVITY_VOCABULARY ="),
);
const pythonLabels = [
  ...pythonDefinitions.matchAll(/^    "([a-z_]+)":/gm),
].map((match) => match[1]);
const webLabels = [
  ...webVocabularySource.matchAll(/value:\s*"([a-z_]+)"/g),
].map((match) => match[1]);

assert.strictEqual(ACTIVITY_LABELS.length, 17, "the study taxonomy has 17 labels");
assert.strictEqual(
  new Set(ACTIVITY_LABELS).size,
  ACTIVITY_LABELS.length,
  "server labels are unique",
);
assert.deepStrictEqual(
  pythonLabels,
  [...ACTIVITY_LABELS],
  "Python VLM enum matches the server API enum",
);
assert.deepStrictEqual(
  webLabels,
  [...ACTIVITY_LABELS],
  "participant dropdown matches the server API enum",
);

console.log("ACTIVITY VOCABULARY TEST PASSED");
