// Shapes returned by the server's read API (server/src/server.ts). Keep in
// sync with the server when the API changes.
export interface SessionSummary {
  device: string;
  session: number; // session epoch seconds, the server's session key
  startedAtMs: number;
  endedAtMs: number;
  frameCount: number;
}

// Deliberately carries NO VLM output: the app must never show the VLM's
// labels to participants (it would bias the control condition of the DRM
// study). The server stopped sending vlmStatus/vlmLabel for the same reason.
export interface SessionFrame {
  frameIndex: number;
  captureEpochMs: number;
  // Path on the server (e.g. /frames/...); prefix with appConfig.serverUrl
  // and send the bearer token to load it.
  imageUrl: string;
}
