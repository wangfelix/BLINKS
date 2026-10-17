// Generates config/study-config.schema.json from the zod schema (the single
// source of truth, src/study-config/schema.ts) for the Python workers.
//
//   npm run generate-study-config-schema          # write the file
//   npm run generate-study-config-schema -- --check  # exit 1 if stale
//
// scripts/test-study-config-schema.ts runs the same freshness check.

import fs from "fs";
import path from "path";

import { z } from "zod";

import { StudyConfigSchema } from "../src/study-config/schema";

export const STUDY_CONFIG_SCHEMA_PATH = path.join(
  __dirname,
  "..",
  "..",
  "config",
  "study-config.schema.json",
);

export const renderStudyConfigJsonSchema = (): string => {
  const jsonSchema = z.toJSONSchema(StudyConfigSchema, {
    // The YAML is the INPUT: fields with a default (privacy.faceBlur.enabled)
    // are optional in the file. Python workers apply the same defaults.
    io: "input",
    target: "draft-2020-12",
  });
  return (
    JSON.stringify(
      {
        ...jsonSchema,
        $id: "https://github.com/wangfelix/BLINKS/config/study-config.schema.json",
        title: "BLINKS study configuration",
        description:
          "GENERATED from server/src/study-config/schema.ts by " +
          "server/scripts/generate-study-config-schema.ts. Do not edit by hand. " +
          "Cross-field checks are not part of this schema; see " +
          "docs/study-config-contract.md.",
      },
      null,
      2,
    ) + "\n"
  );
};

if (require.main === module) {
  const rendered = renderStudyConfigJsonSchema();
  if (process.argv.includes("--check")) {
    const current = fs.existsSync(STUDY_CONFIG_SCHEMA_PATH)
      ? fs.readFileSync(STUDY_CONFIG_SCHEMA_PATH, "utf8")
      : "";
    if (current !== rendered) {
      console.error(
        `${STUDY_CONFIG_SCHEMA_PATH} is stale; run npm run generate-study-config-schema`,
      );
      process.exit(1);
    }
    console.log("study-config.schema.json is up to date");
  } else {
    fs.writeFileSync(STUDY_CONFIG_SCHEMA_PATH, rendered);
    console.log(`wrote ${STUDY_CONFIG_SCHEMA_PATH}`);
  }
}
