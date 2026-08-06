import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useRouter } from "expo-router";
import { useEffect, useState } from "react";
import { Alert } from "react-native";

import { useRecordingSession } from "@/capture/model/use-recording-session";
import { requestCapturePermissions } from "@/capture/permissions/request-capture-permissions";
import type { ParticipantProfile } from "@/profile/api/profile-api";
import {
  profileKeys,
  profileQueryOptions,
} from "@/profile/query-options/profile-queries";
import { updateCameraFormFactor } from "@/study-settings/api/study-settings-api";
import {
  loadImageRotation,
  storeImageRotation,
} from "@/study-settings/storage/image-rotation-storage";
import type { CameraFormFactor } from "@/study-settings/types/camera-form-factor";
import type { ImageRotation } from "@/study-settings/types/image-rotation";

export const useStudySettingsModel = () => {
  const router = useRouter();
  const queryClient = useQueryClient();
  const { session, startTestSession } = useRecordingSession();
  const profileQuery = useQuery(profileQueryOptions());
  const [imageRotation, setImageRotation] = useState<ImageRotation>(0);
  const [isLoadingRotation, setIsLoadingRotation] = useState(true);
  const [isSavingRotation, setIsSavingRotation] = useState(false);
  const [isStartingRecording, setIsStartingRecording] = useState(false);
  const cameraFormFactorMutation = useMutation({
    mutationFn: updateCameraFormFactor,
    onMutate: async (cameraFormFactor) => {
      await queryClient.cancelQueries({ queryKey: profileKeys.detail() });
      const previous = queryClient.getQueryData<ParticipantProfile>(
        profileKeys.detail(),
      );
      queryClient.setQueryData<ParticipantProfile>(
        profileKeys.detail(),
        (current) => (current ? { ...current, cameraFormFactor } : current),
      );
      return { previous };
    },
    onError: (_error, _cameraFormFactor, context) => {
      if (context?.previous) {
        queryClient.setQueryData(profileKeys.detail(), context.previous);
      }
    },
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: profileKeys.all });
    },
  });

  const isTestSessionActive =
    session.kind === "test" && session.phase !== "idle";
  const canOpenTestSession =
    session.restorationStatus !== "restoring" &&
    (isTestSessionActive ||
      (session.phase === "idle" && !session.hasKnownSession));
  const testSessionButtonLabel = isTestSessionActive
    ? "Return to test recording"
    : session.restorationStatus === "restoring"
      ? "Checking recording state…"
      : "Start test recording";

  useEffect(() => {
    let isMounted = true;
    loadImageRotation()
      .then((rotation) => {
        if (isMounted) setImageRotation(rotation);
      })
      .finally(() => {
        if (isMounted) setIsLoadingRotation(false);
      });
    return () => {
      isMounted = false;
    };
  }, []);

  const selectImageRotation = async (nextRotation: ImageRotation) => {
    if (nextRotation === imageRotation || isSavingRotation) return;

    const previousRotation = imageRotation;
    setImageRotation(nextRotation);
    setIsSavingRotation(true);
    try {
      await storeImageRotation(nextRotation);
    } catch {
      setImageRotation(previousRotation);
      Alert.alert(
        "Could not save rotation",
        "The image rotation setting was not changed. Try again.",
      );
    } finally {
      setIsSavingRotation(false);
    }
  };

  const selectCameraFormFactor = async (
    nextCameraFormFactor: CameraFormFactor,
  ) => {
    if (
      nextCameraFormFactor === profileQuery.data?.cameraFormFactor ||
      cameraFormFactorMutation.isPending
    ) {
      return;
    }
    try {
      await cameraFormFactorMutation.mutateAsync(nextCameraFormFactor);
    } catch {
      Alert.alert(
        "Could not save camera type",
        "The camera type was not changed on the server. Check the connection and try again.",
      );
    }
  };

  const openTestRecording = async () => {
    if (!canOpenTestSession || isStartingRecording) return;
    if (isTestSessionActive) {
      router.push("/recording");
      return;
    }

    setIsStartingRecording(true);
    try {
      const granted = await requestCapturePermissions();
      if (!granted) {
        Alert.alert(
          "Permissions needed",
          "BLINKS needs Bluetooth and notification permissions for the test recording.",
        );
        return;
      }
      await startTestSession();
      router.push("/recording");
    } catch {
      Alert.alert(
        "Could not start recording",
        "Check the camera and try again.",
      );
    } finally {
      setIsStartingRecording(false);
    }
  };

  return {
    cameraFormFactor: profileQuery.data?.cameraFormFactor ?? null,
    isLoadingCameraFormFactor: profileQuery.isLoading,
    isSavingCameraFormFactor: cameraFormFactorMutation.isPending,
    imageRotation,
    isLoadingRotation,
    isSavingRotation,
    canOpenTestSession,
    testSessionButtonLabel,
    isStartingRecording,
    selectCameraFormFactor,
    selectImageRotation,
    openTestRecording,
  };
};
