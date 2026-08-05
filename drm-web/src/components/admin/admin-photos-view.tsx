"use client";

import { useMemo, useState } from "react";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import {
  ChevronLeftIcon,
  ChevronRightIcon,
  ImageOffIcon,
  ImagesIcon,
  LoaderCircleIcon,
  RefreshCwIcon,
} from "lucide-react";

import {
  adminFrameImageSrc,
  getAdminPhotoFilters,
  getAdminPhotos,
  type AdminPhoto,
} from "@/lib/admin-api";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

const PAGE_SIZE = 96;
const countFormat = new Intl.NumberFormat("en");
const dateTimeFormat = new Intl.DateTimeFormat("en-GB", {
  dateStyle: "medium",
  timeStyle: "medium",
  timeZone: "Europe/Berlin",
});

const frameKey = (frame: AdminPhoto) =>
  `${frame.participant}:${frame.device}:${frame.session}:${frame.frameIndex}`;

export const AdminPhotosView = () => {
  const [selectedParticipant, setSelectedParticipant] = useState<string | null>(
    null,
  );
  const [selectedSession, setSelectedSession] = useState<number | null>(null);
  const [page, setPage] = useState(1);
  const [selectedPhoto, setSelectedPhoto] = useState<AdminPhoto | null>(null);

  const filtersQuery = useQuery({
    queryKey: ["admin", "photo-filters"],
    queryFn: getAdminPhotoFilters,
  });

  const participants = filtersQuery.data?.participants ?? [];
  const participant =
    selectedParticipant !== null &&
    participants.some((item) => item.participant === selectedParticipant)
      ? selectedParticipant
      : (participants[0]?.participant ?? "");

  const participantSessions = useMemo(
    () =>
      (filtersQuery.data?.sessions ?? []).filter(
        (item) => item.participant === participant,
      ),
    [filtersQuery.data, participant],
  );

  const session =
    selectedSession !== null &&
    participantSessions.some((item) => item.session === selectedSession)
      ? selectedSession
      : null;

  const photosQuery = useQuery({
    queryKey: ["admin", "photos", participant, session, page, PAGE_SIZE],
    queryFn: () => getAdminPhotos(participant, session, page, PAGE_SIZE),
    enabled: participant !== "",
    placeholderData: keepPreviousData,
  });

  const totalPages = Math.max(
    1,
    Math.ceil((photosQuery.data?.total ?? 0) / PAGE_SIZE),
  );

  const participantItems = (filtersQuery.data?.participants ?? []).map(
    (item) => ({ value: item.participant, label: item.participant }),
  );
  const sessionItems = [
    { value: "all", label: "All sessions" },
    ...participantSessions.map((item) => ({
      value: String(item.session),
      label: String(item.session),
    })),
  ];

  return (
    <section className="space-y-4" aria-labelledby="photos-heading">
      <div>
        <p className="text-xs font-semibold tracking-[0.14em] text-muted-foreground uppercase">
          Anonymized image review
        </p>
        <h2 id="photos-heading" className="mt-1 text-2xl font-semibold">
          Study photos
        </h2>
        <p className="mt-1 text-sm text-muted-foreground">
          Filter by participant and recording session. Only successfully
          face-anonymized, non-deleted files can be opened.
        </p>
      </div>

      <Card className="gap-0 rounded-2xl bg-background/82 py-0 shadow-lg backdrop-blur-xl">
        <CardHeader className="border-b border-border/70 py-5">
          <CardTitle>Photo library</CardTitle>
          <CardDescription>
            {photosQuery.data === undefined
              ? "Choose a participant to load photos."
              : `${countFormat.format(photosQuery.data.total)} frame records match these filters.`}
          </CardDescription>
          <CardAction>
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label="Refresh photos"
              onClick={() => {
                void filtersQuery.refetch();
                void photosQuery.refetch();
              }}
            >
              <RefreshCwIcon
                className={
                  filtersQuery.isFetching || photosQuery.isFetching
                    ? "animate-spin"
                    : undefined
                }
              />
            </Button>
          </CardAction>
        </CardHeader>

        <div className="grid gap-4 border-b border-border/70 bg-muted/20 px-4 py-4 sm:grid-cols-2 sm:px-5 lg:max-w-3xl">
          <div className="space-y-2">
            <Label htmlFor="admin-photo-participant">Participant ID</Label>
            <Select
              items={participantItems}
              value={participant || null}
              onValueChange={(value) => {
                if (value === null) return;
                setSelectedParticipant(value);
                setSelectedSession(null);
                setPage(1);
              }}
            >
              <SelectTrigger
                id="admin-photo-participant"
                className="w-full bg-background"
              >
                <SelectValue placeholder="Choose participant…" />
              </SelectTrigger>
              <SelectContent align="start" alignItemWithTrigger={false}>
                {(filtersQuery.data?.participants ?? []).map((item) => (
                  <SelectItem key={item.participant} value={item.participant}>
                    <span className="flex w-full items-center justify-between gap-6">
                      <span>{item.participant}</span>
                      <span className="text-xs text-muted-foreground tabular-nums">
                        {countFormat.format(item.frame_count)} frames
                      </span>
                    </span>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-2">
            <Label htmlFor="admin-photo-session">Recording session</Label>
            <Select
              items={sessionItems}
              value={session === null ? "all" : String(session)}
              onValueChange={(value) => {
                if (value === null) return;
                setSelectedSession(value === "all" ? null : Number(value));
                setPage(1);
              }}
              disabled={!participant}
            >
              <SelectTrigger
                id="admin-photo-session"
                className="w-full bg-background"
              >
                <SelectValue placeholder="All sessions" />
              </SelectTrigger>
              <SelectContent align="start" alignItemWithTrigger={false}>
                <SelectItem value="all">All sessions</SelectItem>
                {participantSessions.map((item) => (
                  <SelectItem key={item.session} value={String(item.session)}>
                    <span className="flex flex-col py-0.5">
                      <span className="font-mono text-xs">{item.session}</span>
                      <span className="text-xs text-muted-foreground">
                        {dateTimeFormat.format(item.started_at_ms)} ·{" "}
                        {countFormat.format(item.frame_count)} frames
                      </span>
                    </span>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>

        {filtersQuery.isError || photosQuery.isError ? (
          <CardContent className="py-10">
            <Alert variant="destructive">
              <AlertTitle>Photos unavailable</AlertTitle>
              <AlertDescription>
                {(filtersQuery.error ?? photosQuery.error) instanceof Error
                  ? (filtersQuery.error ?? photosQuery.error)?.message
                  : "The photo library could not be loaded."}
              </AlertDescription>
            </Alert>
          </CardContent>
        ) : filtersQuery.data === undefined ||
          (participant !== "" && photosQuery.data === undefined) ? (
          <CardContent className="flex min-h-72 items-center justify-center gap-2 text-sm text-muted-foreground">
            <LoaderCircleIcon className="animate-spin" aria-hidden />
            Loading photos…
          </CardContent>
        ) : filtersQuery.data.participants.length === 0 ? (
          <CardContent className="flex min-h-72 flex-col items-center justify-center gap-3 text-center text-sm text-muted-foreground">
            <span className="grid size-12 place-items-center rounded-2xl border bg-background">
              <ImagesIcon className="size-5" aria-hidden />
            </span>
            No participant photos have been recorded yet.
          </CardContent>
        ) : photosQuery.data?.frames.length === 0 ? (
          <CardContent className="flex min-h-72 flex-col items-center justify-center gap-3 text-center text-sm text-muted-foreground">
            <span className="grid size-12 place-items-center rounded-2xl border bg-background">
              <ImageOffIcon className="size-5" aria-hidden />
            </span>
            No frames match this participant and session.
          </CardContent>
        ) : (
          <CardContent className="bg-muted/10 py-5">
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4 xl:grid-cols-6 2xl:grid-cols-8">
              {photosQuery.data?.frames.map((frame) => {
                const available = frame.imageUrl !== null;
                return (
                  <figure
                    key={frameKey(frame)}
                    className="group overflow-hidden rounded-xl border bg-background shadow-sm"
                  >
                    {available ? (
                      <button
                        type="button"
                        className="relative block aspect-[4/3] w-full overflow-hidden bg-muted outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
                        onClick={() => setSelectedPhoto(frame)}
                      >
                        {/* eslint-disable-next-line @next/next/no-img-element -- authenticated image; Next image optimization cannot attach the admin cookie */}
                        <img
                          src={adminFrameImageSrc(frame.imageUrl!)}
                          alt={`Participant ${frame.participant}, frame ${frame.frameIndex}, ${dateTimeFormat.format(frame.captureEpochMs)}`}
                          loading="lazy"
                          decoding="async"
                          fetchPriority="low"
                          className="size-full object-cover transition-transform duration-300 group-hover:scale-[1.03] motion-reduce:transition-none"
                        />
                        <span className="absolute inset-x-0 bottom-0 h-12 bg-gradient-to-t from-black/55 to-transparent" />
                        <span className="absolute bottom-2 left-2 text-[10px] font-medium text-white tabular-nums">
                          {dateTimeFormat.format(frame.captureEpochMs)}
                        </span>
                      </button>
                    ) : (
                      <div className="flex aspect-[4/3] flex-col items-center justify-center gap-2 bg-muted/60 text-muted-foreground">
                        <ImageOffIcon className="size-5" aria-hidden />
                        <Badge
                          variant={
                            frame.deletedAt === null ? "secondary" : "outline"
                          }
                        >
                          {frame.deletedAt === null
                            ? frame.faceStatus
                            : "deleted"}
                        </Badge>
                      </div>
                    )}
                    <figcaption className="space-y-0.5 px-2.5 py-2 text-[11px]">
                      <p className="truncate font-medium" title={frame.device}>
                        {frame.device}
                      </p>
                      <p className="text-muted-foreground tabular-nums">
                        Session {frame.session} · Frame {frame.frameIndex}
                      </p>
                    </figcaption>
                  </figure>
                );
              })}
            </div>
          </CardContent>
        )}

        <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border/70 bg-muted/25 px-4 py-3 sm:px-5">
          <p className="text-xs text-muted-foreground tabular-nums">
            {photosQuery.data === undefined
              ? "Select a participant"
              : `${countFormat.format(photosQuery.data.total)} frames · Page ${page} of ${totalPages}`}
          </p>
          <div className="flex gap-2">
            <Button
              variant="outline"
              size="sm"
              className="bg-background"
              disabled={page <= 1 || photosQuery.data === undefined}
              onClick={() => setPage((current) => Math.max(1, current - 1))}
            >
              <ChevronLeftIcon aria-hidden />
              Previous
            </Button>
            <Button
              variant="outline"
              size="sm"
              className="bg-background"
              disabled={page >= totalPages || photosQuery.data === undefined}
              onClick={() => setPage((current) => current + 1)}
            >
              Next
              <ChevronRightIcon aria-hidden />
            </Button>
          </div>
        </div>
      </Card>

      <Dialog
        open={selectedPhoto !== null}
        onOpenChange={(open) => {
          if (!open) setSelectedPhoto(null);
        }}
      >
        <DialogContent className="max-h-[calc(100dvh-1rem)] gap-0 overflow-hidden rounded-3xl border-border/70 bg-background p-0 sm:max-w-6xl">
          <DialogHeader className="border-b border-border/70 px-5 py-5 pr-16 sm:px-7">
            <DialogTitle>Study photo</DialogTitle>
            <DialogDescription>
              {selectedPhoto === null
                ? "Anonymized frame"
                : `${selectedPhoto.participant} · Session ${selectedPhoto.session} · Frame ${selectedPhoto.frameIndex}`}
            </DialogDescription>
          </DialogHeader>
          {selectedPhoto?.imageUrl && (
            <div className="flex max-h-[78vh] items-center justify-center bg-black/95 p-2 sm:p-4">
              {/* eslint-disable-next-line @next/next/no-img-element -- authenticated image; Next image optimization cannot attach the admin cookie */}
              <img
                src={adminFrameImageSrc(selectedPhoto.imageUrl)}
                alt={`Participant ${selectedPhoto.participant}, frame ${selectedPhoto.frameIndex}`}
                className="max-h-[74vh] max-w-full rounded-xl object-contain"
              />
            </div>
          )}
        </DialogContent>
      </Dialog>
    </section>
  );
};
