"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = __importDefault(require("express"));
const http_1 = __importDefault(require("http"));
const ws_1 = require("ws");
const fs_1 = __importDefault(require("fs"));
const path_1 = __importDefault(require("path"));
const url_1 = require("url");
const db_1 = require("./db");
// ===========================================================================
// Camera ingestion server (Stage 1: local development)
//
// Receives JPEG frames from one or more XIAO ESP32S3 Sense devices over a
// WebSocket connection and writes them to disk, organised by participant and
// device. Each frame is preceded by a small JSON text message carrying the
// device-side capture timestamp (NTP-synced epoch milliseconds). The server
// records both the capture time and the receipt time, so transmission latency
// can be measured later.
//
// Device identity is the ESP32 MAC address (set automatically on the device).
// The firmware is therefore identical across all units. The mapping from a
// device to a participant is done here on the server, not in firmware:
//
//   POST /assign?device=<MAC>&participant=<id>   assign a participant
//   GET  /devices                                list connected devices
//
// Reassigning a connected device closes its socket so it reconnects and starts
// a fresh session under the new participant. No reflashing, no physical access.
//
// Connection path:  /camera/{deviceId}
// ===========================================================================
const PORT = Number(process.env.CAMERA_PORT ?? 3000);
const RECORDINGS_DIR = path_1.default.join(__dirname, "..", "recordings");
const ASSIGNMENTS_PATH = path_1.default.join(RECORDINGS_DIR, "assignments.json");
const PAUSED_PATH = path_1.default.join(RECORDINGS_DIR, "paused.json");
function ensureDir(dir) {
    if (!fs_1.default.existsSync(dir)) {
        fs_1.default.mkdirSync(dir, { recursive: true });
    }
}
// Strip anything that is not a safe identifier character, preventing a
// malformed segment from escaping the recordings directory.
function sanitize(value) {
    return value.replace(/[^a-zA-Z0-9_-]/g, "");
}
function looksLikeJpeg(buffer) {
    if (buffer.length < 4)
        return false;
    const soi = buffer[0] === 0xff && buffer[1] === 0xd8;
    const eoi = buffer[buffer.length - 2] === 0xff && buffer[buffer.length - 1] === 0xd9;
    return soi && eoi;
}
ensureDir(RECORDINGS_DIR);
// Open the SQLite metadata store (one row per frame; supersedes the CSV index).
(0, db_1.initDb)(path_1.default.join(RECORDINGS_DIR, "recordings.db"));
// --- Participant assignment (deviceId -> participant) ----------------------
let assignments = {};
function loadAssignments() {
    try {
        if (fs_1.default.existsSync(ASSIGNMENTS_PATH)) {
            assignments = JSON.parse(fs_1.default.readFileSync(ASSIGNMENTS_PATH, "utf8"));
        }
    }
    catch (err) {
        console.error("Failed to load assignments.json:", err);
    }
}
function persistAssignments() {
    try {
        fs_1.default.writeFileSync(ASSIGNMENTS_PATH, JSON.stringify(assignments, null, 2));
    }
    catch (err) {
        console.error("Failed to persist assignments.json:", err);
    }
}
loadAssignments();
// --- Pause state (participant -> paused) -----------------------------------
// Mobile clients call POST /pause and POST /resume per participant. The state
// is authoritative on the server: a camera that reconnects (or is reassigned)
// is told the current state immediately so it cannot silently start streaming
// while the participant is paused.
let pausedParticipants = new Set();
function loadPaused() {
    try {
        if (fs_1.default.existsSync(PAUSED_PATH)) {
            const arr = JSON.parse(fs_1.default.readFileSync(PAUSED_PATH, "utf8"));
            pausedParticipants = new Set(arr);
        }
    }
    catch (err) {
        console.error("Failed to load paused.json:", err);
    }
}
function persistPaused() {
    try {
        fs_1.default.writeFileSync(PAUSED_PATH, JSON.stringify(Array.from(pausedParticipants), null, 2));
    }
    catch (err) {
        console.error("Failed to persist paused.json:", err);
    }
}
loadPaused();
// Live WebSocket connections, keyed by deviceId.
const connections = new Map();
function broadcastToParticipant(participant, message) {
    let sent = 0;
    for (const [device, ws] of connections) {
        if (assignments[device] !== participant)
            continue;
        if (ws.readyState !== ws_1.WebSocket.OPEN)
            continue;
        ws.send(message);
        sent += 1;
    }
    return sent;
}
const app = (0, express_1.default)();
app.use(express_1.default.json());
app.get("/health", (_req, res) => {
    res.json({ status: "ok", time: new Date().toISOString() });
});
app.get("/devices", (_req, res) => {
    const connected = Array.from(connections.keys()).map((device) => {
        const participant = assignments[device] ?? "unassigned";
        return {
            device,
            participant,
            paused: pausedParticipants.has(participant),
        };
    });
    res.json({
        connected,
        assignments,
        paused: Array.from(pausedParticipants),
    });
});
// On-demand CSV export from the DB (the DB itself is the live index now).
app.get("/api/export.csv", (req, res) => {
    const participant = sanitize(String(req.query.participant ?? ""));
    const device = sanitize(String(req.query.device ?? ""));
    const session = Number(req.query.session);
    if (!participant || !device || !Number.isFinite(session)) {
        res.status(400).json({
            error: "query params 'participant', 'device', and 'session' are required",
        });
        return;
    }
    const csv = (0, db_1.exportFramesCsv)({ participant, device, session });
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="${participant}-${device}-${session}-frames.csv"`);
    res.send(csv);
});
app.post("/assign", (req, res) => {
    const device = sanitize(String(req.query.device ?? ""));
    const participant = sanitize(String(req.query.participant ?? ""));
    if (!device || !participant) {
        res
            .status(400)
            .json({ error: "query params 'device' and 'participant' are required" });
        return;
    }
    assignments[device] = participant;
    persistAssignments();
    console.log(`Assigned device ${device} to participant ${participant}`);
    // If the device is currently streaming, drop the connection so it reconnects
    // and opens a fresh session under the new participant.
    const live = connections.get(device);
    if (live) {
        live.close();
    }
    res.json({ ok: true, device, participant });
});
// Pause and resume act per participant. A participant may be wearing more than
// one device (e.g. headcam + glasses) and a single tap in the mobile UI should
// stop all of them at once.
app.post("/pause", (req, res) => {
    const participant = sanitize(String(req.query.participant ?? ""));
    if (!participant) {
        res.status(400).json({ error: "query param 'participant' is required" });
        return;
    }
    pausedParticipants.add(participant);
    persistPaused();
    const notified = broadcastToParticipant(participant, "pause");
    console.log(`Paused participant ${participant} (notified ${notified} device(s))`);
    res.json({ ok: true, participant, paused: true, notified });
});
app.post("/resume", (req, res) => {
    const participant = sanitize(String(req.query.participant ?? ""));
    if (!participant) {
        res.status(400).json({ error: "query param 'participant' is required" });
        return;
    }
    pausedParticipants.delete(participant);
    persistPaused();
    const notified = broadcastToParticipant(participant, "resume");
    console.log(`Resumed participant ${participant} (notified ${notified} device(s))`);
    res.json({ ok: true, participant, paused: false, notified });
});
const server = http_1.default.createServer(app);
const wss = new ws_1.WebSocketServer({ server });
wss.on("connection", (ws, req) => {
    const requestUrl = new url_1.URL(req.url ?? "", `http://${req.headers.host}`);
    const parts = requestUrl.pathname.split("/").filter(Boolean);
    // Expect: ["camera", deviceId]
    if (parts[0] !== "camera" || parts.length < 2) {
        console.error(`Rejected connection with path: ${requestUrl.pathname}`);
        ws.close();
        return;
    }
    const deviceId = sanitize(parts[1]);
    if (!deviceId) {
        console.error("Rejected connection: empty deviceId");
        ws.close();
        return;
    }
    const participant = assignments[deviceId] ?? "unassigned";
    connections.set(deviceId, ws);
    // If this participant is currently paused, tell the device immediately so it
    // does not stream frames during the gap between connect and the next /pause
    // call. The firmware resets its local paused flag on disconnect, so it always
    // listens for the server's authoritative state on reconnect.
    if (pausedParticipants.has(participant)) {
        ws.send("pause");
    }
    const sessionStart = Math.floor(Date.now() / 1000);
    const sessionDir = path_1.default.join(RECORDINGS_DIR, participant, deviceId, String(sessionStart));
    const imagesDir = path_1.default.join(sessionDir, "images");
    ensureDir(imagesDir);
    // One row per frame goes into the SQLite store (recordings.db) at ingestion
    // time; the JPEG bytes stay on disk. The DB is the index that supersedes the
    // old per-session CSV. Export a CSV on demand via GET /api/export.csv.
    let frameNumber = 0;
    let pendingMeta = null;
    console.log(`Camera connected: device=${deviceId} participant=${participant} session=${sessionStart}`);
    ws.on("message", (data, isBinary) => {
        if (!isBinary) {
            const text = data.toString();
            if (text === "heartbeat")
                return;
            // Frame metadata arrives as JSON just before its binary frame.
            try {
                const meta = JSON.parse(text);
                if (typeof meta.t === "number") {
                    pendingMeta = { t: meta.t, n: Number(meta.n) || 0 };
                    return;
                }
            }
            catch {
                // not JSON, fall through to control logging
            }
            console.log(`[${deviceId}] control: ${text}`);
            return;
        }
        // Defense in depth: never persist a frame for a paused participant. The
        // device is told to "pause" the moment it connects, but a frame can be in
        // flight, or be captured in the brief race right after reconnect (before the
        // device processes the "pause" message). Drop it here so a paused
        // participant's images never reach disk, regardless of firmware timing.
        if (pausedParticipants.has(participant)) {
            pendingMeta = null;
            console.log(`[${deviceId}] dropped frame: participant ${participant} is paused`);
            return;
        }
        const buffer = data;
        frameNumber += 1;
        const receivedEpochMs = Date.now();
        const captureEpochMs = pendingMeta?.t ?? null;
        const deviceFrame = pendingMeta?.n ?? null;
        pendingMeta = null;
        // Use the capture time for the filename when available, else receipt time.
        const stamp = captureEpochMs ?? receivedEpochMs;
        const jpegOk = looksLikeJpeg(buffer);
        if (!jpegOk) {
            console.warn(`[${deviceId}] frame ${frameNumber} does not look like a complete JPEG (${buffer.length} bytes)`);
        }
        const fileName = `frame-${String(frameNumber).padStart(6, "0")}-${stamp}.jpg`;
        const filePath = path_1.default.join(imagesDir, fileName);
        fs_1.default.writeFile(filePath, buffer, (err) => {
            if (err)
                console.error(`Failed to write ${fileName}:`, err);
        });
        // Index the frame in SQLite. file_path is stored relative to recordings/ so
        // one row locates its JPEG even if the recordings dir is moved or rsynced.
        // capture_epoch_ms is NOT NULL in the schema; the firmware always sends it,
        // but fall back to receipt time if the metadata message was missing.
        (0, db_1.insertFrame)({
            participant,
            device: deviceId,
            session: sessionStart,
            frame_index: frameNumber,
            capture_epoch_ms: captureEpochMs ?? receivedEpochMs,
            received_epoch_ms: receivedEpochMs,
            file_path: path_1.default.relative(RECORDINGS_DIR, filePath),
            device_frame: deviceFrame,
            byte_length: buffer.length,
            jpeg_ok: jpegOk ? 1 : 0,
        });
    });
    ws.on("close", () => {
        if (connections.get(deviceId) === ws) {
            connections.delete(deviceId);
        }
        console.log(`Connection closed: ${deviceId} (${frameNumber} frames written)`);
    });
    ws.on("error", (err) => {
        console.error(`WebSocket error for device ${deviceId}:`, err);
    });
});
server.listen(PORT, () => {
    console.log(`Camera ingestion server listening on ws://0.0.0.0:${PORT}`);
    console.log(`Health:  http://localhost:${PORT}/health`);
    console.log(`Devices: http://localhost:${PORT}/devices`);
    console.log(`Recordings directory: ${RECORDINGS_DIR}`);
});
