import * as SecureStore from "expo-secure-store";

import { sessionHolder } from "@/authentication/storage/session-holder";

const ACTIVE_RECORDING_KEY_PREFIX = "blinks.active-recording";

export type StoredRecordingPhase = "recording" | "paused" | "ending";

export interface StoredActiveRecording {
  version: 1;
  sessionId: number;
  startedAtMs: number;
  phase: StoredRecordingPhase;
  accumulatedActiveMs: number;
  nextSequenceNumber: number;
  savedAtMs: number;
}

const storageKey = (username: string): string =>
  `${ACTIVE_RECORDING_KEY_PREFIX}.${username}`;

const currentStorageKey = (): string => {
  const username = sessionHolder.getUsername();
  if (!username) throw new Error("recording state requires a signed-in user");
  return storageKey(username);
};

const isStoredActiveRecording = (
  value: unknown,
): value is StoredActiveRecording => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const candidate = value as Partial<StoredActiveRecording>;
  return (
    candidate.version === 1 &&
    Number.isSafeInteger(candidate.sessionId) &&
    (candidate.sessionId ?? 0) > 0 &&
    Number.isSafeInteger(candidate.startedAtMs) &&
    (candidate.startedAtMs ?? 0) > 0 &&
    (candidate.phase === "recording" ||
      candidate.phase === "paused" ||
      candidate.phase === "ending") &&
    Number.isFinite(candidate.accumulatedActiveMs) &&
    (candidate.accumulatedActiveMs ?? -1) >= 0 &&
    Number.isSafeInteger(candidate.nextSequenceNumber) &&
    (candidate.nextSequenceNumber ?? -1) >= 0 &&
    Number.isSafeInteger(candidate.savedAtMs) &&
    (candidate.savedAtMs ?? 0) > 0
  );
};

export const loadStoredActiveRecording = async (): Promise<StoredActiveRecording | null> => {
  const key = currentStorageKey();
  const stored = await SecureStore.getItemAsync(key);
  if (!stored) return null;
  try {
    const parsed = JSON.parse(stored) as unknown;
    if (isStoredActiveRecording(parsed)) return parsed;
  } catch {
    // Delete malformed state below so it cannot block a server-side recovery.
  }
  await SecureStore.deleteItemAsync(key);
  return null;
};

export const storeActiveRecording = (
  recording: StoredActiveRecording,
): Promise<void> =>
  SecureStore.setItemAsync(currentStorageKey(), JSON.stringify(recording));

export const clearStoredActiveRecording = (): Promise<void> =>
  SecureStore.deleteItemAsync(currentStorageKey());
