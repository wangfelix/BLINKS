import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useLocalSearchParams } from "expo-router";
import { useEffect, useState } from "react";
import { Alert } from "react-native";

import { formatDate } from "@/application/utils/format-time";
import {
  deleteSessionFrame,
  deleteSessionFrames,
} from "@/sessions/api/sessions-api";
import {
  sessionFramesQueryOptions,
  sessionKeys,
} from "@/sessions/query-options/session-queries";
import { SessionFrame } from "@/sessions/types/session-types";

const DELETE_BATCH_SIZE = 500;

export const useSessionDetailModel = () => {
  const params = useLocalSearchParams<{
    device: string;
    session: string;
    startedAtMs: string;
  }>();
  const device = params.device ?? "";
  const session = Number(params.session ?? 0);
  const queryClient = useQueryClient();

  // ---- STATE ----

  const framesQuery = useQuery(sessionFramesQueryOptions(device, session));
  const [previewFrame, setPreviewFrame] = useState<SessionFrame | null>(null);
  const [isSelectionMode, setIsSelectionMode] = useState(false);
  const [selectedFrameIndexes, setSelectedFrameIndexes] = useState<Set<number>>(
    new Set(),
  );

  const screenTitle = params.startedAtMs
    ? formatDate(Number(params.startedAtMs))
    : "Session";

  const deleteMutation = useMutation({
    mutationFn: (frame: SessionFrame) =>
      deleteSessionFrame(device, session, frame.frameIndex),
    onSuccess: (_result, frame) => {
      setPreviewFrame((current) =>
        current?.frameIndex === frame.frameIndex ? null : current,
      );
      void queryClient.invalidateQueries({ queryKey: sessionKeys.all });
    },
    onError: () =>
      Alert.alert("Delete failed", "The image could not be deleted. Try again."),
  });

  const batchDeleteMutation = useMutation({
    mutationFn: async (frameIndexes: number[]) => {
      for (let offset = 0; offset < frameIndexes.length; offset += DELETE_BATCH_SIZE) {
        await deleteSessionFrames(
          device,
          session,
          frameIndexes.slice(offset, offset + DELETE_BATCH_SIZE),
        );
      }
    },
    onSuccess: () => {
      setSelectedFrameIndexes(new Set());
      setIsSelectionMode(false);
    },
    onError: () =>
      Alert.alert(
        "Delete failed",
        "Some images could not be deleted. The list has been refreshed; try again.",
      ),
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: sessionKeys.all });
    },
  });

  useEffect(() => {
    const visibleIndexes = new Set(
      (framesQuery.data ?? []).map((frame) => frame.frameIndex),
    );
    setSelectedFrameIndexes((current) => {
      const next = new Set(
        [...current].filter((frameIndex) => visibleIndexes.has(frameIndex)),
      );
      return next.size === current.size ? current : next;
    });
    setPreviewFrame((current) =>
      current && visibleIndexes.has(current.frameIndex) ? current : null,
    );
  }, [framesQuery.data]);

  // ---- ACTIONS ----

  const confirmDeleteFrame = (frame: SessionFrame) => {
    Alert.alert(
      "Delete this image?",
      "The image file is permanently removed from the study data.",
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Delete",
          style: "destructive",
          onPress: () => deleteMutation.mutate(frame),
        },
      ],
    );
  };

  const openFramePreview = (frame: SessionFrame) => {
    setPreviewFrame(frame);
  };

  const closeFramePreview = () => {
    setPreviewFrame(null);
  };

  const enterSelectionMode = () => {
    setSelectedFrameIndexes(new Set());
    setIsSelectionMode(true);
  };

  const exitSelectionMode = () => {
    setSelectedFrameIndexes(new Set());
    setIsSelectionMode(false);
  };

  const toggleFrameSelection = (frameIndex: number) => {
    setSelectedFrameIndexes((current) => {
      const next = new Set(current);
      if (next.has(frameIndex)) next.delete(frameIndex);
      else next.add(frameIndex);
      return next;
    });
  };

  const confirmDeleteSelected = () => {
    const frameIndexes = [...selectedFrameIndexes];
    if (frameIndexes.length === 0) return;
    const noun = frameIndexes.length === 1 ? "image file" : "image files";
    Alert.alert(
      `Delete ${frameIndexes.length} ${noun}?`,
      `The selected ${noun} will be permanently removed from the study data.`,
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Delete",
          style: "destructive",
          onPress: () => batchDeleteMutation.mutate(frameIndexes),
        },
      ],
    );
  };

  // ---- RETURN ----

  return {
    screenTitle,
    frames: framesQuery.data ?? [],
    isLoading: framesQuery.isLoading,
    isRefetching: framesQuery.isRefetching,
    refetch: framesQuery.refetch,
    confirmDeleteFrame,
    previewFrame,
    openFramePreview,
    closeFramePreview,
    deletingFrameIndex: deleteMutation.isPending
      ? deleteMutation.variables?.frameIndex
      : null,
    isSelectionMode,
    selectedFrameIndexes,
    selectedCount: selectedFrameIndexes.size,
    enterSelectionMode,
    exitSelectionMode,
    toggleFrameSelection,
    confirmDeleteSelected,
    isDeletingSelection: batchDeleteMutation.isPending,
  };
};
