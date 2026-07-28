"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ImagesIcon } from "lucide-react";

import {
  ApiError,
  clearStoredToken,
  getManagedPhotos,
  getProfile,
  getStudyState,
} from "@/lib/api-client";
import { formatDayLabel } from "@/lib/time";
import { Row } from "@/components/layout/flex";
import { Text } from "@/components/layout/text";
import { Button } from "@/components/ui/button";
import { PhotoManagementDialog } from "@/components/photos/photo-management-dialog";

export const StudyNavbar = () => {
  const router = useRouter();
  const queryClient = useQueryClient();
  const [photosOpen, setPhotosOpen] = useState(false);
  const profileQuery = useQuery({
    queryKey: ["profile"],
    queryFn: getProfile,
  });
  const stateQuery = useQuery({
    queryKey: ["study-state"],
    queryFn: getStudyState,
  });
  const canManagePhotos =
    stateQuery.data?.rounds.find((round) => round.round === 1)?.status ===
    "submitted";
  const photosQuery = useQuery({
    queryKey: ["photos", "day"],
    queryFn: getManagedPhotos,
    enabled: photosOpen && canManagePhotos,
  });

  const handleSignOut = () => {
    clearStoredToken();
    // Anti-leak on a shared browser: no cached participant data may survive
    // into the next account's session.
    queryClient.clear();
    router.replace("/");
  };

  return (
    <>
      <nav className="border-b bg-white" aria-label="Study navigation">
        <div className="mx-auto flex min-h-14 w-full max-w-6xl flex-wrap items-center justify-between gap-2 px-4 py-2">
          <span className="text-sm font-medium sm:text-base">
            BLINKS Day Reconstruction Study
          </span>
          <Row gap="sm" align="center" wrap className="shrink-0">
            {canManagePhotos && (
              <Button
                variant="secondary"
                size="sm"
                onClick={() => setPhotosOpen(true)}
              >
                <ImagesIcon />
                Manage Photos
              </Button>
            )}
            <Text variant="secondary" className="text-xs sm:text-sm">
              Participant: {profileQuery.data?.username ?? "…"}
            </Text>
            <Button variant="ghost" size="sm" onClick={handleSignOut}>
              Sign out
            </Button>
          </Row>
        </div>
      </nav>

      {canManagePhotos && (
        <PhotoManagementDialog
          open={photosOpen}
          onOpenChange={setPhotosOpen}
          title={
            photosQuery.data === undefined
              ? "Manage Photos"
              : `Manage Photos · ${formatDayLabel(photosQuery.data.day)}`
          }
          description="Review every photo from your recorded day."
          frames={photosQuery.data?.frames ?? []}
          emptyMessage="No photos were recorded for this day."
          isLoading={photosQuery.isLoading}
          loadError={
            photosQuery.isError
              ? photosQuery.error instanceof ApiError
                ? photosQuery.error.message
                : "The photos could not be loaded."
              : null
          }
          onRetry={() => void photosQuery.refetch()}
        />
      )}
    </>
  );
};
