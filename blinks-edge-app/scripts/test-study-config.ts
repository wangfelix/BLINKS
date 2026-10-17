// Pure-logic checks for the runtime study config in the app (no device needed).
// Run: npx tsx scripts/test-study-config.ts
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { parse } from "yaml";

import {
  cameraIntervalWarning,
  encodeSetIntervalCommand,
  parseCameraDeviceInfo,
} from "@/capture/ble/camera-device-info";
import {
  endSessionAvailableFromLabel,
  isStudySessionEndAvailable,
} from "@/capture/utils/end-session-availability";
import type { CachedAppConfig } from "@/study/types/app-config";
import { desiredCaptureIntervalMs } from "@/study/utils/capture-interval";
import { FALLBACK_APP_TEXTS } from "@/study/utils/fallback-app-texts";

const yaml = parse(
  readFileSync(join(__dirname, "../../config/study.example.yaml"), "utf8"),
);

// Same mapping as GET /api/app-config (contract 4.3), without the PIN.
const config: CachedAppConfig = {
  timezone: yaml.study.timezone,
  schedule: { endSessionAvailableAt: yaml.schedule.endSessionAvailableAt },
  devices: { formFactors: yaml.devices.formFactors },
  capture: { intervalMsByFormFactor: yaml.capture.intervalMsByFormFactor },
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

test("default texts equal the previous hardcoded app texts", () => {
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

test("capture interval comes from the form factor map", () => {
  assert.equal(
    desiredCaptureIntervalMs({ config, cameraFormFactor: "glasses" }),
    30_000,
  );
  assert.equal(
    desiredCaptureIntervalMs({ config, cameraFormFactor: "necklace" }),
    15_000,
  );
  assert.equal(
    desiredCaptureIntervalMs({ config, cameraFormFactor: null }),
    null,
  );
  assert.equal(
    desiredCaptureIntervalMs({ config: null, cameraFormFactor: "glasses" }),
    null,
  );
  assert.equal(
    desiredCaptureIntervalMs({ config, cameraFormFactor: "wristband" }),
    null,
  );
});

test("0x03 command is exactly [0x03][uint32 BE]", () => {
  assert.deepEqual(
    Array.from(encodeSetIntervalCommand(30_000)),
    [0x03, 0x00, 0x00, 0x75, 0x30],
  );
  assert.deepEqual(
    Array.from(encodeSetIntervalCommand(600_000)),
    [0x03, 0x00, 0x09, 0x27, 0xc0],
  );
  assert.equal(encodeSetIntervalCommand(5_000).length, 5);
});

const bytes = (text: string) => Uint8Array.from(text, (c) => c.charCodeAt(0));
const infoJson =
  '{"v":1,"fw":"1.3.0","formFactor":"glasses","intervalMs":30000,"defaultMs":30000,"minMs":5000,"maxMs":600000}';

test("device info parses the spec example; invalid JSON is unsupported", () => {
  assert.deepEqual(parseCameraDeviceInfo(bytes(infoJson)), {
    v: 1,
    fw: "1.3.0",
    formFactor: "glasses",
    intervalMs: 30000,
    defaultMs: 30000,
    minMs: 5000,
    maxMs: 600000,
  });
  assert.equal(parseCameraDeviceInfo(bytes("{not json")), null);
  assert.equal(parseCameraDeviceInfo(bytes('{"v":1}')), null);
});

test("warnings for form-factor mismatch and clamping", () => {
  const info = parseCameraDeviceInfo(bytes(infoJson))!;
  assert.equal(cameraIntervalWarning(info, 30_000, "glasses"), null);
  const label = (key: string) =>
    config.devices.formFactors.find((f) => f.key === key)?.displayLabel ?? key;
  const mismatch = cameraIntervalWarning(info, 30_000, "necklace", label);
  assert.match(mismatch!, /reports “Glasses”, Study Settings say “Necklace”/);
  const clamped = cameraIntervalWarning(
    { ...info, intervalMs: 5_000 },
    1_000,
    "glasses",
  );
  assert.match(clamped!, /uses 5 s instead of the configured 1 s/);
});

console.log(`\n${passed} tests passed`);
