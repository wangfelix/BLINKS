// App logic against a RUNNING server (no phone, no camera): config fetch and
// per-user cache, offline start, PIN rule, BLE connect sequence with a fake
// camera, and the device-info POST queue. Native modules are replaced by the
// in-memory stubs in scripts/stubs (scripts/tsconfig.node.json).
//
//   BLINKS_TEST_SERVER=http://localhost:3000 BLINKS_TEST_USER=demo \
//   BLINKS_TEST_PASSWORD=demo12345 \
//     npx tsx --tsconfig scripts/tsconfig.node.json scripts/test-app-integration.ts
import assert from "node:assert/strict";

const server = process.env.BLINKS_TEST_SERVER ?? "http://localhost:3000";
const username = process.env.BLINKS_TEST_USER ?? "demo";
const password = process.env.BLINKS_TEST_PASSWORD ?? "demo12345";
process.env.EXPO_PUBLIC_SERVER_URL = server;
(globalThis as Record<string, unknown>).__DEV__ = true;

const CONTROL = "9a8b7c6d-0003-4a5b-8c9d-0e1f2a3b4c5d";
const INFO = "9a8b7c6d-0004-4a5b-8c9d-0e1f2a3b4c5d";
const FRAMES = "9a8b7c6d-0002-4a5b-8c9d-0e1f2a3b4c5d";

let passed = 0;
const test = async (name: string, run: () => Promise<void> | void) => {
  await run();
  passed += 1;
  console.log(`ok - ${name}`);
};

const main = async () => {
  const { sessionHolder } =
    await import("@/authentication/storage/session-holder");
  const { appConfigStore } = await import("@/study/model/app-config-store");
  const { desiredCaptureIntervalMs } =
    await import("@/study/utils/capture-interval");
  const { loadAppConfigCache } =
    await import("@/study/storage/app-config-cache");
  const { isStudySettingsPinCorrect } =
    await import("@/study/utils/study-settings-pin");
  const { updateCameraFormFactor } =
    await import("@/study-settings/api/study-settings-api");
  const { fetchRecordingState, submitDeviceInfoReport } =
    await import("@/capture/api/capture-api");
  const { createDeviceInfoQueue } =
    await import("@/capture/storage/device-info-queue-core");
  const { CameraLink } = await import("@/capture/ble/camera-link");
  const { toByteArray, fromByteArray } = await import("base64-js");
  const realFetch = globalThis.fetch;

  const login = await (
    await realFetch(`${server}/api/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username, password }),
    })
  ).json();
  assert.ok(login.token, "login failed");
  sessionHolder.setSession(login.token, username);

  let pin: string | null = null;
  await test("no cache: no config, no PIN, no 0x03 interval, Study Settings locked", async () => {
    await appConfigStore.restore(username);
    const state = appConfigStore.getState();
    assert.equal(state.config, null);
    assert.equal(state.studySettingsPin, null);
    assert.equal(desiredCaptureIntervalMs(state), null);
    assert.equal(isStudySettingsPinCorrect(state.studySettingsPin, ""), false);
    assert.equal(
      isStudySettingsPinCorrect(state.studySettingsPin, "0000"),
      false,
    );
  });

  let formFactors: string[] = [];
  await test("GET /api/app-config fills store and cache (PIN in SecureStore only)", async () => {
    assert.equal(await appConfigStore.refresh(), true);
    const state = appConfigStore.getState();
    assert.ok(state.config);
    pin = state.studySettingsPin;
    assert.match(pin ?? "", /^\d{4,8}$/);
    formFactors = state.config.devices.formFactors.map((f) => f.key);
    assert.ok(formFactors.length > 0);
    for (const key of formFactors) {
      assert.ok(state.config.capture.intervalMsByFormFactor[key] >= 5000);
    }
    const cached = await loadAppConfigCache(username);
    assert.deepEqual(cached.config, state.config);
    assert.equal(cached.studySettingsPin, pin);
    const { files } = await import("./stubs/expo-file-system");
    for (const content of files.values()) {
      assert.ok(
        !content.includes(`"${pin}"`),
        "PIN must not be in the file cache",
      );
    }
    assert.equal(isStudySettingsPinCorrect(pin, pin!), true);
    assert.equal(isStudySettingsPinCorrect(pin, `${pin}9`), false);
  });

  const formFactor = formFactors[formFactors.length - 1];
  let expectedInterval = 0;
  await test(`form factor "${formFactor}" from the profile selects its interval`, async () => {
    await updateCameraFormFactor(formFactor);
    await appConfigStore.refresh();
    const state = appConfigStore.getState();
    assert.equal(state.cameraFormFactor, formFactor);
    expectedInterval = state.config!.capture.intervalMsByFormFactor[formFactor];
    assert.equal(desiredCaptureIntervalMs(state), expectedInterval);
  });

  await test("offline start uses the per-user cache; refresh failure keeps it", async () => {
    globalThis.fetch = (async () => {
      throw new TypeError("network down");
    }) as typeof fetch;
    try {
      await appConfigStore.restore("someone-else");
      assert.equal(
        appConfigStore.getState().config,
        null,
        "other user has no cache",
      );
      await appConfigStore.restore(username);
      assert.equal(await appConfigStore.refresh(), false);
      const state = appConfigStore.getState();
      assert.equal(state.studySettingsPin, pin);
      assert.equal(desiredCaptureIntervalMs(state), expectedInterval);
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  // Fake camera: records every BLE call in order.
  const calls: string[] = [];
  let firmwareInterval = 15_000;
  const deviceInfo = () =>
    fromByteArray(
      Uint8Array.from(
        JSON.stringify({
          v: 1,
          fw: "1.3.0",
          formFactor: "necklace",
          intervalMs: firmwareInterval,
          defaultMs: 15000,
          minMs: 5000,
          maxMs: 600000,
        }),
        (c) => c.charCodeAt(0),
      ),
    );
  const fakeDevice = (withInfo: boolean) => ({
    id: "AA:BB:CC:DD:EE:01",
    requestMTU: async (mtu: number) => void calls.push(`mtu ${mtu}`),
    discoverAllServicesAndCharacteristics: async () =>
      void calls.push("discover"),
    characteristicsForService: async () => [
      { uuid: FRAMES },
      { uuid: CONTROL },
      ...(withInfo ? [{ uuid: INFO }] : []),
    ],
    readCharacteristicForService: async (_s: string, uuid: string) => {
      calls.push(`read ${uuid.slice(9, 13)}`);
      return { value: deviceInfo() };
    },
    writeCharacteristicWithResponseForService: async (
      _s: string,
      uuid: string,
      value: string,
    ) => {
      const bytes = Array.from(toByteArray(value));
      calls.push(
        `write ${uuid.slice(9, 13)} [${bytes.map((b) => b.toString(16).padStart(2, "0")).join(" ")}]`,
      );
      if (bytes[0] === 0x03) {
        const ms =
          (bytes[1] << 24) | (bytes[2] << 16) | (bytes[3] << 8) | bytes[4];
        firmwareInterval = Math.min(600000, Math.max(5000, ms));
      }
    },
    onDisconnected: () => ({ remove: () => {} }),
    monitorCharacteristicForService: (_s: string, uuid: string) => {
      calls.push(`monitor ${uuid.slice(9, 13)}`);
      return { remove: () => {} };
    },
    cancelConnection: async () => {},
  });
  const reports: {
    requestedIntervalMs: number | null;
    info: unknown;
    settingsFormFactor: string | null;
  }[] = [];
  const newLink = () => {
    const link = new CameraLink({
      onFrame: () => {},
      onStatusChange: () => {},
      onDeviceIdentified: () => {},
      onCaptureConfigReport: (report) => reports.push(report),
    });
    (link as unknown as { running: boolean }).running = true;
    return link as unknown as {
      finishConnection: (d: unknown) => Promise<void>;
      setPaused: (p: boolean) => Promise<void>;
      appConfigUnsubscribe: (() => void) | null;
    };
  };

  const be = (ms: number) =>
    [
      "03",
      ...[24, 16, 8, 0].map((s) =>
        ((ms >>> s) & 0xff).toString(16).padStart(2, "0"),
      ),
    ].join(" ");

  await test("connect order: MTU, discover, read 0004, write 0x03, re-read 0004, pause, monitor", async () => {
    const link = newLink();
    await link.setPaused(true);
    await link.finishConnection(fakeDevice(true));
    assert.deepEqual(calls, [
      "mtu 517",
      "discover",
      "read 0004",
      `write 0003 [${be(expectedInterval)}]`,
      "read 0004",
      "write 0003 [01]",
      "monitor 0002",
    ]);
    const last = reports.at(-1)!;
    assert.equal(last.requestedIntervalMs, expectedInterval);
    assert.equal(last.settingsFormFactor, formFactor);
    assert.equal(
      (last.info as { intervalMs: number }).intervalMs,
      expectedInterval,
    );
  });

  await test("old firmware without 0004: no 0x03, report with info null", async () => {
    calls.length = 0;
    await newLink().finishConnection(fakeDevice(false));
    assert.deepEqual(calls, ["mtu 517", "discover", "monitor 0002"]);
    assert.deepEqual(
      { r: reports.at(-1)!.requestedIntervalMs, i: reports.at(-1)!.info },
      { r: null, i: null },
    );
  });

  await test("form-factor change on a live connection rewrites 0x03 immediately", async () => {
    calls.length = 0;
    const link = newLink();
    (link as unknown as { device: unknown }).device = null;
    // subscribe like start() does
    link.appConfigUnsubscribe = appConfigStore.subscribe(() =>
      (
        link as unknown as { handleAppConfigChange: () => void }
      ).handleAppConfigChange(),
    );
    await link.finishConnection(fakeDevice(true));
    calls.length = 0;
    const other = formFactors[0];
    appConfigStore.setCameraFormFactor(other);
    await new Promise((r) => setTimeout(r, 50));
    const otherMs =
      appConfigStore.getState().config!.capture.intervalMsByFormFactor[other];
    assert.deepEqual(calls, [`write 0003 [${be(otherMs)}]`, "read 0004"]);
    link.appConfigUnsubscribe?.();
    appConfigStore.setCameraFormFactor(formFactor);
  });

  await test("POST /api/recording/device-info: 201, duplicate 200, 409 dropped, offline kept", async () => {
    const state = await fetchRecordingState();
    const session = state.sessionId ?? Math.floor(Date.now() / 1000);
    const memory = new Map<string, string>();
    const queue = createDeviceInfoQueue({
      storage: {
        get: async (k) => memory.get(k) ?? null,
        set: async (k, v) => void memory.set(k, v),
        delete: async (k) => void memory.delete(k),
      },
      submit: submitDeviceInfoReport,
      getUsername: () => username,
    });
    const report = reports[0];
    const base = {
      eventId: `${session}-AABBCCDDEE01-${Date.now()}`,
      session,
      device: "AABBCCDDEE01",
      clientEpochMs: Date.now(),
      requestedIntervalMs: report.requestedIntervalMs,
      settingsFormFactor: report.settingsFormFactor,
      info: report.info as Record<string, unknown>,
    };
    const first = await submitDeviceInfoReport(base);
    assert.deepEqual(first, { ok: true, duplicate: false });
    assert.deepEqual(await submitDeviceInfoReport(base), {
      ok: true,
      duplicate: true,
    });

    await queue.enqueue({ ...base, requestedIntervalMs: 99_999 }); // 409 -> dropped
    assert.equal(await queue.pendingCount(), 0);

    globalThis.fetch = (async () => {
      throw new TypeError("network down");
    }) as typeof fetch;
    await queue.enqueue({ ...base, eventId: `${base.eventId}-offline` });
    assert.equal(await queue.pendingCount(), 1, "kept while offline");
    globalThis.fetch = realFetch;
    await queue.flush();
    assert.equal(await queue.pendingCount(), 0, "delivered after reconnect");
    console.log(
      `   reported eventIds ${base.eventId}, ${base.eventId}-offline`,
    );
  });

  await test("sign-out clears this user's cache", async () => {
    await appConfigStore.clear();
    const cached = await loadAppConfigCache(username);
    assert.deepEqual(cached, {
      config: null,
      cameraFormFactor: null,
      studySettingsPin: null,
    });
  });

  console.log(`\n${passed} integration tests passed against ${server}`);
};

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
