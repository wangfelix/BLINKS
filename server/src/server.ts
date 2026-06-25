import express from "express";
import http from "http";
import { WebSocketServer, WebSocket } from "ws";
import fs from "fs";
import path from "path";
import { URL } from "url";

import {
  AuthenticatedRequest,
  hashPassword,
  issueToken,
  participantFromAuthHeader,
  requireAuth,
  verifyPassword,
  verifyUserPassword,
} from "./auth";
import { getUser, initAuthDb, updatePasswordHash } from "./auth-db";
import {
  deleteFrameRow,
  exportFramesCsv,
  getFrameFilePath,
  getFrameStatusByPath,
  initDb,
  insertFrame,
  listFrames,
  listSessions,
  maxFrameIndex,
} from "./db";

// ===========================================================================
// BLINKS ingestion + API server (BLE phone-relay architecture).
//
// The WebSocket client is the participant's PHONE (blinks-edge-app), not the
// ESP32: the camera has no WiFi and talks BLE to the phone, which relays each
// JPEG over its KIT VPN to this server. The phone authenticates with a bearer
// token (issued at /api/login) on the upgrade request and declares the session
// it is writing into, so BLE/WS reconnects continue the same session.
//
//   WS /ingest?session=<epochSeconds>&device=<cameraId>
//     per frame: JSON text {"t":<captureEpochMs>,"n":<cameraFrameCounter>}
//                followed by the binary JPEG
//
// Capture timestamps are PHONE-stamped (header-receipt time, within ~100 ms of
// true capture): the ESP32 has no clock. `device` is the camera's BLE MAC with
// colons stripped, supplied by the phone.
//
// The old MAC-based /assign model is gone: identity comes from login, and a
// participant can only ever read or delete their own frames.
// ===========================================================================

const PORT = Number(process.env.CAMERA_PORT ?? 3000);
const RECORDINGS_DIR =
  process.env.RECORDINGS_DIR ?? path.join(__dirname, "..", "recordings");
const DATA_DIR = process.env.DATA_DIR ?? path.join(__dirname, "..", "data");
const PAUSED_PATH = path.join(RECORDINGS_DIR, "paused.json");

function ensureDir(dir: string): void {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

// Strip anything that is not a safe identifier character, preventing a
// malformed segment from escaping the recordings directory.
function sanitize(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]/g, "");
}

function looksLikeJpeg(buffer: Buffer): boolean {
  if (buffer.length < 4) return false;
  const soi = buffer[0] === 0xff && buffer[1] === 0xd8;
  const eoi =
    buffer[buffer.length - 2] === 0xff && buffer[buffer.length - 1] === 0xd9;
  return soi && eoi;
}

ensureDir(RECORDINGS_DIR);
ensureDir(DATA_DIR);

// Frame metadata lives next to the JPEGs (rsynced together for analysis);
// credentials live in their own DB outside the recordings tree (see auth-db).
initDb(path.join(RECORDINGS_DIR, "recordings.db"));
initAuthDb(process.env.AUTH_DB_PATH ?? path.join(DATA_DIR, "auth.db"));

// --- Pause state (participant -> paused) -----------------------------------
// The app pauses the camera directly over BLE; this server-side state is the
// defense-in-depth gate that drops any frame still in flight (or raced around
// the BLE control write) so a paused participant's images never reach disk.
let pausedParticipants = new Set<string>();

function loadPaused(): void {
  try {
    if (fs.existsSync(PAUSED_PATH)) {
      const arr: string[] = JSON.parse(fs.readFileSync(PAUSED_PATH, "utf8"));
      pausedParticipants = new Set(arr);
    }
  } catch (err) {
    console.error("Failed to load paused.json:", err);
  }
}

function persistPaused(): void {
  try {
    fs.writeFileSync(
      PAUSED_PATH,
      JSON.stringify(Array.from(pausedParticipants), null, 2),
    );
  } catch (err) {
    console.error("Failed to persist paused.json:", err);
  }
}

loadPaused();

const app = express();
app.use(express.json());

app.get("/health", (_req, res) => {
  res.json({ status: "ok", time: new Date().toISOString() });
});

// --- Auth -------------------------------------------------------------------

app.post("/api/login", async (req, res) => {
  const { username, password } = req.body as {
    username?: string;
    password?: string;
  };
  if (typeof username !== "string" || typeof password !== "string") {
    res.status(400).json({ error: "username and password are required" });
    return;
  }
  const cleanUsername = sanitize(username);
  const passwordOk = await verifyUserPassword(cleanUsername, password);
  if (!cleanUsername || !passwordOk) {
    res.status(401).json({ error: "wrong username or password" });
    return;
  }
  const token = issueToken(cleanUsername);
  console.log(`Login: ${cleanUsername}`);
  res.json({ token, username: cleanUsername });
});

app.post(
  "/api/change-password",
  requireAuth,
  async (req: AuthenticatedRequest, res) => {
    const participant = req.participant!;
    const { currentPassword, newPassword } = req.body as {
      currentPassword?: string;
      newPassword?: string;
    };
    if (
      typeof currentPassword !== "string" ||
      typeof newPassword !== "string"
    ) {
      res
        .status(400)
        .json({ error: "currentPassword and newPassword are required" });
      return;
    }
    if (newPassword.length < 8) {
      res
        .status(400)
        .json({ error: "the new password needs at least 8 characters" });
      return;
    }
    const user = getUser(participant);
    if (!user || !(await verifyPassword(user.password_hash, currentPassword))) {
      res.status(403).json({ error: "current password is incorrect" });
      return;
    }
    updatePasswordHash(participant, await hashPassword(newPassword));
    console.log(`Password changed: ${participant}`);
    res.json({ ok: true });
  },
);

// --- Participant read/edit API (each participant sees only their own data) --

app.get("/api/sessions", requireAuth, (req: AuthenticatedRequest, res) => {
  const sessions = listSessions(req.participant!).map((row) => ({
    device: row.device,
    session: row.session,
    startedAtMs: row.started_at_ms,
    endedAtMs: row.ended_at_ms,
    frameCount: row.frame_count,
  }));
  res.json({ sessions });
});

app.get(
  "/api/sessions/:device/:session/frames",
  requireAuth,
  (req: AuthenticatedRequest, res) => {
    const device = sanitize(req.params.device);
    const session = Number(req.params.session);
    if (!device || !Number.isInteger(session)) {
      res.status(400).json({ error: "invalid device or session" });
      return;
    }
    const frames = listFrames(req.participant!, device, session).map((row) => ({
      frameIndex: row.frame_index,
      captureEpochMs: row.capture_epoch_ms,
      vlmStatus: row.vlm_status,
      vlmLabel: row.vlm_label,
      imageUrl: `/frames/${row.file_path}`,
    }));
    res.json({ frames });
  },
);

// GDPR-relevant: deletes the JPEG from disk AND the index row.
app.delete(
  "/api/sessions/:device/:session/frames/:frameIndex",
  requireAuth,
  (req: AuthenticatedRequest, res) => {
    const participant = req.participant!;
    const device = sanitize(req.params.device);
    const session = Number(req.params.session);
    const frameIndex = Number(req.params.frameIndex);
    if (!device || !Number.isInteger(session) || !Number.isInteger(frameIndex)) {
      res.status(400).json({ error: "invalid device, session, or frameIndex" });
      return;
    }

    const filePath = getFrameFilePath(participant, device, session, frameIndex);
    if (filePath === undefined) {
      res.status(404).json({ error: "frame not found" });
      return;
    }

    deleteFrameRow(participant, device, session, frameIndex);
    fs.unlink(path.join(RECORDINGS_DIR, filePath), (err) => {
      if (err && err.code !== "ENOENT") {
        console.error(`Failed to delete ${filePath}:`, err);
      }
    });
    console.log(
      `Deleted frame: ${participant}/${device}/${session}/#${frameIndex}`,
    );
    res.json({ ok: true });
  },
);

// Serves the JPEG bytes. Not express.static: every request must prove the
// requested path belongs to the authenticated participant (these are images
// of people and their homes).
app.get("/frames/*", requireAuth, (req: AuthenticatedRequest, res) => {
  const relativePath = decodeURIComponent(req.path.slice("/frames/".length));
  const normalized = path.normalize(relativePath);
  if (
    normalized.startsWith("..") ||
    path.isAbsolute(normalized) ||
    !normalized.startsWith(`${req.participant!}${path.sep}`)
  ) {
    res.status(403).json({ error: "forbidden" });
    return;
  }
  // Serving gate: never hand back a frame whose face has not been blurred yet.
  // Anonymization happens in place shortly after ingestion (face-blur worker);
  // until face_status='done' the image is withheld, even from its owner.
  if (getFrameStatusByPath(req.participant!, normalized) !== "done") {
    res.status(404).json({ error: "frame not available yet" });
    return;
  }
  res.sendFile(normalized, { root: RECORDINGS_DIR }, (err) => {
    if (err && !res.headersSent) res.status(404).json({ error: "not found" });
  });
});

// On-demand CSV export from the DB, for the authenticated participant's own
// sessions (analysis on the VM reads the SQLite file directly instead).
app.get("/api/export.csv", requireAuth, (req: AuthenticatedRequest, res) => {
  const participant = req.participant!;
  const device = sanitize(String(req.query.device ?? ""));
  const session = Number(req.query.session);
  if (!device || !Number.isFinite(session)) {
    res
      .status(400)
      .json({ error: "query params 'device' and 'session' are required" });
    return;
  }
  const csv = exportFramesCsv({ participant, device, session });
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader(
    "Content-Disposition",
    `attachment; filename="${participant}-${device}-${session}-frames.csv"`,
  );
  res.send(csv);
});

// --- Pause / resume (participant from token) --------------------------------

app.post("/api/pause", requireAuth, (req: AuthenticatedRequest, res) => {
  pausedParticipants.add(req.participant!);
  persistPaused();
  console.log(`Paused participant ${req.participant}`);
  res.json({ ok: true, paused: true });
});

app.post("/api/resume", requireAuth, (req: AuthenticatedRequest, res) => {
  pausedParticipants.delete(req.participant!);
  persistPaused();
  console.log(`Resumed participant ${req.participant}`);
  res.json({ ok: true, paused: false });
});

// --- WebSocket ingestion (the phone is the client) ---------------------------

const server = http.createServer(app);
const wss = new WebSocketServer({ server });

wss.on("connection", (ws: WebSocket, req) => {
  const requestUrl = new URL(req.url ?? "", `http://${req.headers.host}`);

  if (requestUrl.pathname !== "/ingest") {
    console.error(`Rejected WS connection with path: ${requestUrl.pathname}`);
    ws.close(1008, "unknown path");
    return;
  }

  const participant = participantFromAuthHeader(req.headers.authorization);
  if (!participant) {
    console.error("Rejected WS connection: invalid or missing token");
    ws.close(1008, "unauthorized");
    return;
  }

  const device = sanitize(requestUrl.searchParams.get("device") ?? "");
  const session = Number(requestUrl.searchParams.get("session"));
  if (!device || !Number.isInteger(session) || session <= 0) {
    console.error(
      `Rejected WS connection for ${participant}: bad device/session params`,
    );
    ws.close(1008, "device and session query params required");
    return;
  }

  const sessionDir = path.join(
    RECORDINGS_DIR,
    participant,
    device,
    String(session),
  );
  const imagesDir = path.join(sessionDir, "images");
  ensureDir(imagesDir);

  // Continue numbering across reconnects within the same declared session.
  let frameNumber = maxFrameIndex(participant, device, session);
  let pendingMeta: { t: number; n: number | null } | null = null;

  console.log(
    `Phone connected: participant=${participant} device=${device} session=${session} (resuming at frame ${frameNumber})`,
  );

  ws.on("message", (data: Buffer, isBinary: boolean) => {
    if (!isBinary) {
      const text = data.toString();
      if (text === "heartbeat") return;

      // Frame metadata arrives as JSON just before its binary frame.
      try {
        const meta = JSON.parse(text);
        if (typeof meta.t === "number") {
          pendingMeta = {
            t: meta.t,
            n: Number.isFinite(meta.n) ? Number(meta.n) : null,
          };
          return;
        }
      } catch {
        // not JSON, fall through to control logging
      }
      console.log(`[${participant}/${device}] control: ${text}`);
      return;
    }

    // Defense in depth: never persist a frame for a paused participant, no
    // matter what the phone or camera did with the pause state.
    if (pausedParticipants.has(participant)) {
      pendingMeta = null;
      console.log(
        `[${participant}/${device}] dropped frame: participant is paused`,
      );
      return;
    }

    const buffer = data;
    frameNumber += 1;
    const receivedEpochMs = Date.now();

    const captureEpochMs = pendingMeta?.t ?? null;
    const cameraFrame = pendingMeta?.n ?? null;
    pendingMeta = null;

    // Use the capture time for the filename when available, else receipt time.
    const stamp = captureEpochMs ?? receivedEpochMs;

    const jpegOk = looksLikeJpeg(buffer);
    if (!jpegOk) {
      console.warn(
        `[${participant}/${device}] frame ${frameNumber} does not look like a complete JPEG (${buffer.length} bytes)`,
      );
    }

    const fileName = `frame-${String(frameNumber).padStart(6, "0")}-${stamp}.jpg`;
    const filePath = path.join(imagesDir, fileName);

    fs.writeFile(filePath, buffer, (err) => {
      if (err) console.error(`Failed to write ${fileName}:`, err);
    });

    insertFrame({
      participant,
      device,
      session,
      frame_index: frameNumber,
      capture_epoch_ms: captureEpochMs ?? receivedEpochMs,
      received_epoch_ms: receivedEpochMs,
      file_path: path.relative(RECORDINGS_DIR, filePath),
      device_frame: cameraFrame,
      byte_length: buffer.length,
      jpeg_ok: jpegOk ? 1 : 0,
    });
  });

  ws.on("close", () => {
    console.log(
      `Phone disconnected: ${participant}/${device} session=${session} (at frame ${frameNumber})`,
    );
  });

  ws.on("error", (err) => {
    console.error(`WebSocket error for ${participant}/${device}:`, err);
  });
});

server.listen(PORT, () => {
  console.log(`BLINKS server listening on http://0.0.0.0:${PORT}`);
  console.log(`Health:  http://localhost:${PORT}/health`);
  console.log(`Ingest:  ws://localhost:${PORT}/ingest (bearer token required)`);
  console.log(`Recordings directory: ${RECORDINGS_DIR}`);
});
