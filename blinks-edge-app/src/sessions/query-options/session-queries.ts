import { queryOptions } from "@tanstack/react-query";

import {
  fetchSessionFrames,
  fetchSessions,
} from "@/sessions/api/sessions-api";

export const sessionKeys = {
  all: ["sessions"] as const,
  list: () => [...sessionKeys.all, "list"] as const,
  frames: (device: string, session: number) =>
    [...sessionKeys.all, "frames", device, session] as const,
};

export const sessionsQueryOptions = () =>
  queryOptions({
    queryKey: sessionKeys.list(),
    queryFn: fetchSessions,
    select: (response) =>
      [...response.sessions].sort((a, b) => b.startedAtMs - a.startedAtMs),
  });

export const sessionFramesQueryOptions = (device: string, session: number) =>
  queryOptions({
    queryKey: sessionKeys.frames(device, session),
    queryFn: () => fetchSessionFrames(device, session),
    select: (response) => response.frames,
  });
