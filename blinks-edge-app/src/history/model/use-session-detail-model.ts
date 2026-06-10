import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useLocalSearchParams } from "expo-router";
import { Alert } from "react-native";

import { formatDate } from "@/application/utils/format-time";
import { deleteSessionFrame } from "@/sessions/api/sessions-api";
import {
  sessionFramesQueryOptions,
  sessionKeys,
} from "@/sessions/query-options/session-queries";
import { SessionFrame } from "@/sessions/types/session-types";

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

  const screenTitle = params.startedAtMs
    ? formatDate(Number(params.startedAtMs))
    : "Session";

  const deleteMutation = useMutation({
    mutationFn: (frame: SessionFrame) =>
      deleteSessionFrame(device, session, frame.frameIndex),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: sessionKeys.all });
    },
    onError: () =>
      Alert.alert("Delete failed", "The image could not be deleted. Try again."),
  });

  // ---- ACTIONS ----

  const confirmDeleteFrame = (frame: SessionFrame) => {
    Alert.alert(
      "Delete this image?",
      "The image is permanently removed from the study data.",
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

  // ---- RETURN ----

  return {
    screenTitle,
    frames: framesQuery.data ?? [],
    isLoading: framesQuery.isLoading,
    isRefetching: framesQuery.isRefetching,
    refetch: framesQuery.refetch,
    confirmDeleteFrame,
    deletingFrameIndex: deleteMutation.isPending
      ? deleteMutation.variables?.frameIndex
      : null,
  };
};
