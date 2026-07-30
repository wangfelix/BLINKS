import * as SecureStore from "expo-secure-store";

import {
  RecordingEventPayload,
  submitRecordingEvent,
} from "@/capture/api/capture-api";
import { sessionHolder } from "@/authentication/storage/session-holder";

const QUEUE_KEY_PREFIX = "blinks.recording-events";
const MAX_PENDING_EVENTS = 256;

let queueOperation: Promise<void> = Promise.resolve();

const withQueueLock = <T>(operation: () => Promise<T>): Promise<T> => {
  const result = queueOperation.then(operation, operation);
  queueOperation = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
};

const queueKey = (username: string): string =>
  `${QUEUE_KEY_PREFIX}.${username}`;

const loadQueue = async (
  username: string,
): Promise<RecordingEventPayload[]> => {
  const stored = await SecureStore.getItemAsync(queueKey(username));
  if (!stored) return [];
  const parsed = JSON.parse(stored) as unknown;
  if (!Array.isArray(parsed)) {
    throw new Error("stored recording-event queue is malformed");
  }
  return parsed as RecordingEventPayload[];
};

const storeQueue = async (
  username: string,
  events: RecordingEventPayload[],
): Promise<void> => {
  if (events.length === 0) {
    await SecureStore.deleteItemAsync(queueKey(username));
    return;
  }
  await SecureStore.setItemAsync(queueKey(username), JSON.stringify(events));
};

// Persists before returning, then starts an idempotent delivery attempt. A
// failed request leaves the event in SecureStore for the next event, login,
// or app restoration to retry.
export const queueRecordingEvent = async (
  event: RecordingEventPayload,
  options: { deliver?: boolean } = {},
): Promise<void> => {
  const username = sessionHolder.getUsername();
  if (!username) throw new Error("cannot queue a recording event while signed out");

  await withQueueLock(async () => {
    const events = await loadQueue(username);
    if (events.some((candidate) => candidate.eventId === event.eventId)) return;
    if (events.length >= MAX_PENDING_EVENTS) {
      throw new Error("recording-event queue is full");
    }
    await storeQueue(username, [...events, event]);
  });

  if (options.deliver !== false) {
    void flushPendingRecordingEvents();
  }
};

export const flushPendingRecordingEvents = (): Promise<void> =>
  withQueueLock(async () => {
    const username = sessionHolder.getUsername();
    if (!username) return;

    const events = await loadQueue(username);
    while (events.length > 0) {
      try {
        await submitRecordingEvent(events[0]);
      } catch (error) {
        console.warn("Recording event delivery deferred:", error);
        return;
      }
      events.shift();
      await storeQueue(username, events);
    }
  });
