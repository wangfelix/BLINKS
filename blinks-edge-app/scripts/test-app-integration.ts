// App logic against a running server (no phone, no camera): config fetch and
// per-user cache, offline start, PIN check, camera form factor and sign-out.
// Native modules are replaced by the in-memory stubs in scripts/stubs
// (scripts/tsconfig.node.json).
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
  const { loadAppConfigCache } =
    await import("@/study/storage/app-config-cache");
  const { isStudySettingsPinCorrect } =
    await import("@/study/utils/study-settings-pin");
  const { updateCameraFormFactor } =
    await import("@/study-settings/api/study-settings-api");
  const { fetchProfile } = await import("@/profile/api/profile-api");
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
  await test("no cache: no config, no PIN, Study Settings locked", async () => {
    await appConfigStore.restore(username);
    const state = appConfigStore.getState();
    assert.equal(state.config, null);
    assert.equal(state.studySettingsPin, null);
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
    const cached = await loadAppConfigCache(username);
    assert.deepEqual(cached.config, state.config);
    assert.equal(cached.studySettingsPin, pin);
    const { files } = await import("@scripts/stubs/expo-file-system");
    for (const content of files.values()) {
      assert.ok(
        !content.includes(`"${pin}"`),
        "PIN must not be in the file cache",
      );
    }
    assert.equal(isStudySettingsPinCorrect(pin, pin!), true);
    assert.equal(isStudySettingsPinCorrect(pin, `${pin}9`), false);
  });

  await test("every configured camera form factor can be stored on the profile", async () => {
    for (const formFactor of formFactors) {
      await updateCameraFormFactor(formFactor);
      assert.equal((await fetchProfile()).cameraFormFactor, formFactor);
    }
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
      assert.ok(state.config);
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  await test("sign-out clears this user's cache", async () => {
    await appConfigStore.clear();
    const cached = await loadAppConfigCache(username);
    assert.deepEqual(cached, {
      config: null,
      studySettingsPin: null,
    });
  });

  console.log(`\n${passed} integration tests passed against ${server}`);
};

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
