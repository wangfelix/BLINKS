"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ImagesIcon, LogOutIcon } from "lucide-react";

import {
  ApiError,
  clearStoredToken,
  getManagedPhotos,
  getProfile,
  getStudyStatus,
} from "@/lib/api-client";
import { formatDayLabel } from "@/lib/time";
import { Row } from "@/components/layout/flex";
import { Text } from "@/components/layout/text";
import { BlinksLogo } from "@/components/blinks-logo";
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
  const studyStatusQuery = useQuery({
    queryKey: ["study-status"],
    queryFn: getStudyStatus,
  });
  const canManagePhotos = studyStatusQuery.data?.canManagePhotos === true;
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
      <nav
        className="border-b border-border/60 bg-background/55 backdrop-blur-xl"
        aria-label="Study navigation"
      >
        <div className="flex min-h-16 w-full flex-wrap items-center justify-between gap-2 px-4 py-2 sm:px-8">
          <div className="flex items-center gap-3">
            <BlinksLogo className="h-10 w-[140px]" sizes="140px" priority />
            <span className="hidden border-l pl-3 text-xs text-muted-foreground sm:block">
              KIT · KD2Lab
            </span>
          </div>
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
              <LogOutIcon aria-hidden />
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
