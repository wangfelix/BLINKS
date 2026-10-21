// Pure-logic checks for the runtime study config in the app (no device needed).
// Run: npx tsx scripts/test-study-config.ts
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { parse } from "yaml";

import {
  endSessionAvailableFromLabel,
  isStudySessionEndAvailable,
} from "@/capture/utils/end-session-availability";
import type { CachedAppConfig } from "@/study/types/app-config";
import { FALLBACK_APP_TEXTS } from "@/study/utils/fallback-app-texts";

const yaml = parse(
  readFileSync(join(__dirname, "../../config/study.example.yaml"), "utf8"),
);

// Same mapping as GET /api/app-config, without the PIN.
const config: CachedAppConfig = {
  timezone: yaml.study.timezone,
  schedule: { endSessionAvailableAt: yaml.schedule.endSessionAvailableAt },
  devices: { formFactors: yaml.devices.formFactors },
  texts: { app: yaml.texts.app },
};

const at = (iso: string) => Date.parse(iso);
const seconds = (iso: string) => at(iso) / 1_000;

let passed = 0;
const test = (name: string, run: () => void) => {
  run();
  passed += 1;
  console.log(`ok - ${name}`);
};

test("default texts equal the fallback app texts", () => {
  const { endSessionAvailableFrom, ...rest } = config.texts.app;
  assert.deepEqual(rest, FALLBACK_APP_TEXTS);
  assert.equal(endSessionAvailableFromLabel(config), "Available from 19:00");
});

test("end session opens at 19:00 study time on the session day", () => {
  const session = seconds("2026-10-17T08:00:00Z"); // 10:00 CEST
  assert.equal(
    isStudySessionEndAvailable(at("2026-10-17T16:59:59Z"), session, config),
    false,
  );
  assert.equal(
    isStudySessionEndAvailable(at("2026-10-17T17:00:00Z"), session, config),
    true,
  );
  // after midnight / next morning stays available
  assert.equal(
    isStudySessionEndAvailable(at("2026-10-18T06:00:00Z"), session, config),
    true,
  );
  assert.equal(
    isStudySessionEndAvailable(at("2026-10-17T17:00:00Z"), null, config),
    false,
  );
});

test("end session cutoff is correct on the DST switch day", () => {
  const session = seconds("2026-10-25T07:00:00Z"); // 08:00 CET (after switch)
  assert.equal(
    isStudySessionEndAvailable(at("2026-10-25T17:59:00Z"), session, config),
    false,
  );
  assert.equal(
    isStudySessionEndAvailable(at("2026-10-25T18:00:00Z"), session, config),
    true,
  );
});

test("end session follows the configured timezone and time", () => {
  const ny = {
    ...config,
    timezone: "America/New_York",
    schedule: { endSessionAvailableAt: "18:30" },
  };
  const session = seconds("2026-10-17T13:00:00Z"); // 09:00 EDT
  assert.equal(
    isStudySessionEndAvailable(at("2026-10-17T22:29:00Z"), session, ny),
    false,
  );
  assert.equal(
    isStudySessionEndAvailable(at("2026-10-17T22:30:00Z"), session, ny),
    true,
  );
});

test("without a cached config ending is never blocked", () => {
  assert.equal(
    isStudySessionEndAvailable(0, seconds("2026-10-17T08:00:00Z"), null),
    true,
  );
});

console.log(`\n${passed} tests passed`);
