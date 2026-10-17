import { isApiError } from "@/application/api/api-error";
import type { DeviceInfoReportRequest } from "@/capture/api/capture-api";

// Best-effort, per-participant queue for camera device-info reports (contract
// 4.8). Kept free of native modules so it can be tested in Node; the app
// instance in device-info-queue.ts wires it to SecureStore and the API client.
export interface DeviceInfoQueueStorage {
  get: (key: string) => Promise<string | null>;
  set: (key: string, value: string) => Promise<void>;
  delete: (key: string) => Promise<void>;
}

export interface DeviceInfoQueueDependencies {
  storage: DeviceInfoQueueStorage;
  submit: (report: DeviceInfoReportRequest) => Promise<unknown>;
  getUsername: () => string | null;
}

const QUEUE_KEY_PREFIX = "blinks.device-info-reports";
// Reports are diagnostics: drop the oldest instead of growing without bound.
// SecureStore values above ~2 KB can fail; one report is ~300 bytes.
export const MAX_PENDING_DEVICE_INFO_REPORTS = 4;

// 201 = stored, 200 = duplicate or over the server cap (stored: false),
// 400/409 = will never succeed: all of them leave the queue.
// Only network errors (status 0) and 5xx are retried; anything else (e.g. 401
// before the sign-out completes) stays queued for the next attempt as well.
const isFinalResponse = (error: unknown): boolean =>
  isApiError(error) && (error.status === 400 || error.status === 409);

export const createDeviceInfoQueue = ({
  storage,
  submit,
  getUsername,
}: DeviceInfoQueueDependencies) => {
  let operation: Promise<void> = Promise.resolve();
  const withLock = <T>(run: () => Promise<T>): Promise<T> => {
    const result = operation.then(run, run);
    operation = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  };

  const key = (username: string) =>
    `${QUEUE_KEY_PREFIX}.${username.replace(/[^A-Za-z0-9.-]/g, "_")}`;

  const load = async (username: string): Promise<DeviceInfoReportRequest[]> => {
    try {
      const stored = await storage.get(key(username));
      const parsed = stored ? (JSON.parse(stored) as unknown) : [];
      return Array.isArray(parsed) ? (parsed as DeviceInfoReportRequest[]) : [];
    } catch {
      return [];
    }
  };

  const save = async (
    username: string,
    reports: DeviceInfoReportRequest[],
  ): Promise<void> => {
    if (reports.length === 0) await storage.delete(key(username));
    else await storage.set(key(username), JSON.stringify(reports));
  };

  const flush = (): Promise<void> =>
    withLock(async () => {
      const username = getUsername();
      if (!username) return;
      const reports = await load(username);
      while (reports.length > 0) {
        try {
          await submit(reports[0]);
        } catch (error) {
          if (!isFinalResponse(error)) {
            console.warn("Device-info report deferred:", error);
            return;
          }
          console.warn("Device-info report rejected, dropped:", error);
        }
        reports.shift();
        await save(username, reports);
      }
    });

  /** Persists the report, then tries to deliver it. Never throws. */
  const enqueue = async (report: DeviceInfoReportRequest): Promise<void> => {
    const username = getUsername();
    if (!username) return;
    try {
      await withLock(async () => {
        const reports = await load(username);
        if (reports.some((candidate) => candidate.eventId === report.eventId)) {
          return;
        }
        const next = [...reports, report].slice(
          -MAX_PENDING_DEVICE_INFO_REPORTS,
        );
        await save(username, next);
      });
      await flush();
    } catch (error) {
      console.warn("Device-info report could not be queued:", error);
    }
  };

  const pendingCount = async (): Promise<number> => {
    const username = getUsername();
    return username ? (await load(username)).length : 0;
  };

  return { enqueue, flush, pendingCount };
};
