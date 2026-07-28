"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";

import type {
  Frame,
  PhotoDayResponse,
  RoundResponse,
  StudyStateResponse,
} from "@/lib/api-types";
import {
  deletePhoto,
  deletePhotos,
  getManagedPhotos,
  getRound,
} from "@/lib/api-client";

const DELETE_BATCH_SIZE = 500;

export const frameIdentityKey = (frame: Frame): string =>
  `${frame.device}\u0000${frame.session}\u0000${frame.frameIndex}`;

const uniqueLiveFrames = (frames: Frame[]): Frame[] => {
  const byIdentity = new Map<string, Frame>();
  for (const frame of frames) {
    if (frame.deletedAt === null) {
      byIdentity.set(frameIdentityKey(frame), frame);
    }
  }
  return [...byIdentity.values()];
};

const markFramesDeleted = (
  frames: Frame[],
  deletedKeys: Set<string>,
  deletedAt: number,
): Frame[] =>
  frames.map((frame) =>
    deletedKeys.has(frameIdentityKey(frame))
      ? {
          ...frame,
          imageUrl: null,
          deletedAt,
          vlmLabel: null,
          vlmCategory: null,
        }
      : frame,
  );

const groupedFrameIndexes = (
  frames: Frame[],
): { device: string; session: number; frameIndexes: number[] }[] => {
  const groups = new Map<
    string,
    { device: string; session: number; frameIndexes: number[] }
  >();
  for (const frame of frames) {
    const key = `${frame.device}\u0000${frame.session}`;
    const group = groups.get(key) ?? {
      device: frame.device,
      session: frame.session,
      frameIndexes: [],
    };
    group.frameIndexes.push(frame.frameIndex);
    groups.set(key, group);
  }
  return [...groups.values()];
};

/**
 * Shared web deletion path for activity and navbar photo dialogs. Successful
 * deletes update the existing query payloads in place, so an editable round is
 * never unmounted/refetched while its local draft is being edited.
 */
export const usePhotoDeletion = () => {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (requestedFrames: Frame[]) => {
      const frames = uniqueLiveFrames(requestedFrames);
      if (frames.length === 0) return { frames, deletedCount: 0 };

      if (frames.length === 1) {
        const result = await deletePhoto(frames[0]);
        return { frames, deletedCount: result.deletedCount };
      }

      let deletedCount = 0;
      for (const group of groupedFrameIndexes(frames)) {
        for (
          let offset = 0;
          offset < group.frameIndexes.length;
          offset += DELETE_BATCH_SIZE
        ) {
          const result = await deletePhotos(
            group.device,
            group.session,
            group.frameIndexes.slice(offset, offset + DELETE_BATCH_SIZE),
          );
          deletedCount += result.deletedCount;
        }
      }
      return { frames, deletedCount };
    },
    onSuccess: ({ frames, deletedCount }) => {
      const deletedKeys = new Set(frames.map(frameIdentityKey));
      const deletedAt = Date.now();

      queryClient.setQueryData<PhotoDayResponse>(
        ["photos", "day"],
        (current) =>
          current === undefined
            ? current
            : {
                ...current,
                frames: markFramesDeleted(
                  current.frames,
                  deletedKeys,
                  deletedAt,
                ),
              },
      );
      queryClient.setQueryData<RoundResponse>(["round", 2], (current) =>
        current === undefined || current.frames === undefined
          ? current
          : {
              ...current,
              frames: markFramesDeleted(current.frames, deletedKeys, deletedAt),
            },
      );
      queryClient.setQueryData<StudyStateResponse>(
        ["study-state"],
        (current) =>
          current === undefined
            ? current
            : {
                ...current,
                frameCount: Math.max(0, current.frameCount - deletedCount),
              },
      );
    },
    onError: async () => {
      // A batch can partly succeed before a later request fails. Reconcile
      // directly without invalidating the active round query, which would
      // unmount the editor and risk disrupting unsaved local input.
      const [photos, round] = await Promise.allSettled([
        getManagedPhotos(),
        getRound(2),
      ]);
      if (photos.status === "fulfilled") {
        queryClient.setQueryData(["photos", "day"], photos.value);
      }
      if (round.status === "fulfilled") {
        queryClient.setQueryData(["round", 2], round.value);
      }
    },
  });
};
