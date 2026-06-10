// Shapes returned by the server's read API (server/src/server.ts). Keep in
// sync with the server when the API changes.
export interface SessionSummary {
  device: string;
  session: number; // session epoch seconds, the server's session key
  startedAtMs: number;
  endedAtMs: number;
  frameCount: number;
}

export type VlmStatus = "pending" | "processing" | "done" | "failed";

export interface SessionFrame {
  frameIndex: number;
  captureEpochMs: number;
  vlmStatus: VlmStatus;
  vlmLabel: string | null;
  // Path on the server (e.g. /frames/...); prefix with appConfig.serverUrl
  // and send the bearer token to load it.
  imageUrl: string;
}
