import assert from "assert";
import WebSocket from "ws";

// End-to-end smoke test against a locally running server. Expects:
//   RECORDINGS_DIR/DATA_DIR pointing at a throwaway directory
//   a user created via create-user
// Run via: npm run smoke-test (see scripts/run-smoke-test.sh)

const BASE_URL = process.env.SMOKE_BASE_URL ?? "http://127.0.0.1:3100";
const WS_URL = BASE_URL.replace(/^http/, "ws");
const USERNAME = "smoketester";
const PASSWORD = "password123";

// Minimal bytes that pass the SOI/EOI JPEG sanity check.
const FAKE_JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x42, 0x42, 0xff, 0xd9]);

const api = async (
  path: string,
  options: {
    method?: string;
    token?: string;
    body?: unknown;
    expectStatus?: number;
  } = {},
): Promise<any> => {
  const response = await fetch(`${BASE_URL}${path}`, {
    method: options.method ?? "GET",
    headers: {
      ...(options.token ? { Authorization: `Bearer ${options.token}` } : {}),
      ...(options.body ? { "Content-Type": "application/json" } : {}),
    },
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  assert.strictEqual(
    response.status,
    options.expectStatus ?? 200,
    `${options.method ?? "GET"} ${path} -> ${response.status}`,
  );
  const contentType = response.headers.get("content-type") ?? "";
  return contentType.includes("application/json")
    ? response.json()
    : response.arrayBuffer();
};

const sendFramesOverWs = (
  token: string,
  session: number,
  frames: { t: number; n: number }[],
): Promise<void> =>
  new Promise((resolve, reject) => {
    const ws = new WebSocket(`${WS_URL}/ingest?session=${session}&device=AABBCCDDEEFF`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    ws.on("open", () => {
      for (const frame of frames) {
        ws.send(JSON.stringify(frame));
        ws.send(FAKE_JPEG);
      }
      ws.send("heartbeat");
      setTimeout(() => {
        ws.close();
        resolve();
      }, 300);
    });
    ws.on("error", reject);
  });

const expectWsRejected = (headers?: Record<string, string>): Promise<void> =>
  new Promise((resolve, reject) => {
    const ws = new WebSocket(`${WS_URL}/ingest?session=1&device=X`, { headers });
    ws.on("close", (code) => {
      code === 1008
        ? resolve()
        : reject(new Error(`expected close 1008, got ${code}`));
    });
    ws.on("error", () => {}); // close event still fires
  });

const main = async (): Promise<void> => {
  // health is open
  await api("/health");

  // auth required everywhere else
  await api("/api/sessions", { expectStatus: 401 });
  await api("/api/login", {
    method: "POST",
    body: { username: USERNAME, password: "wrong-password" },
    expectStatus: 401,
  });

  const { token } = await api("/api/login", {
    method: "POST",
    body: { username: USERNAME, password: PASSWORD },
  });
  assert.ok(typeof token === "string" && token.length === 64, "token issued");

  // unauthenticated WS upgrade is rejected
  await expectWsRejected();

  // ingest three frames; phone-stamped capture times
  const session = Math.floor(Date.now() / 1000);
  const baseT = Date.now();
  await sendFramesOverWs(token, session, [
    { t: baseT, n: 1 },
    { t: baseT + 30_000, n: 2 },
    { t: baseT + 60_000, n: 3 },
  ]);

  // reconnect into the same session: frame numbering continues
  await sendFramesOverWs(token, session, [{ t: baseT + 90_000, n: 4 }]);

  const { sessions } = await api("/api/sessions", { token });
  assert.strictEqual(sessions.length, 1, "one session listed");
  assert.strictEqual(sessions[0].frameCount, 4, "4 frames after reconnect");
  assert.strictEqual(sessions[0].startedAtMs, baseT, "phone capture time kept");

  const device = sessions[0].device;
  const { frames } = await api(
    `/api/sessions/${device}/${session}/frames`,
    { token },
  );
  assert.strictEqual(frames.length, 4);
  assert.strictEqual(frames[3].frameIndex, 4, "numbering continued");
  assert.strictEqual(frames[0].vlmStatus, "pending");

  // image serving with ownership check
  const imageBytes = await api(frames[0].imageUrl, { token });
  assert.strictEqual(imageBytes.byteLength, FAKE_JPEG.length, "jpeg served");
  await api(frames[0].imageUrl, { expectStatus: 401 });
  await api(`/frames/otheruser/some/path.jpg`, { token, expectStatus: 403 });

  // delete one frame: row + file gone
  await api(`/api/sessions/${device}/${session}/frames/2`, {
    method: "DELETE",
    token,
  });
  const afterDelete = await api(
    `/api/sessions/${device}/${session}/frames`,
    { token },
  );
  assert.strictEqual(afterDelete.frames.length, 3, "frame deleted");
  await api(`/api/sessions/${device}/${session}/frames/2`, {
    method: "DELETE",
    token,
    expectStatus: 404,
  });

  // pause gate drops ingested frames
  await api("/api/pause", { method: "POST", token });
  await sendFramesOverWs(token, session, [{ t: baseT + 120_000, n: 5 }]);
  const whilePaused = await api(
    `/api/sessions/${device}/${session}/frames`,
    { token },
  );
  assert.strictEqual(whilePaused.frames.length, 3, "paused frame dropped");
  await api("/api/resume", { method: "POST", token });

  // change password: wrong current rejected, then real change + re-login
  await api("/api/change-password", {
    method: "POST",
    token,
    body: { currentPassword: "nope", newPassword: "password456" },
    expectStatus: 403,
  });
  await api("/api/change-password", {
    method: "POST",
    token,
    body: { currentPassword: PASSWORD, newPassword: "password456" },
  });
  await api("/api/login", {
    method: "POST",
    body: { username: USERNAME, password: "password456" },
  });

  console.log("SMOKE TEST PASSED");
};

main().catch((error) => {
  console.error("SMOKE TEST FAILED:", error.message);
  process.exit(1);
});
