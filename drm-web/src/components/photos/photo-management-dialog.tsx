"use client";

import type { MouseEvent } from "react";
import { useEffect, useMemo, useRef, useState } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import {
  CheckIcon,
  ImageOffIcon,
  ImagesIcon,
  LoaderCircleIcon,
  Trash2Icon,
} from "lucide-react";

import type { Frame } from "@/lib/api-types";
import { ApiError, frameImageSrc } from "@/lib/api-client";
import { formatTimeOfDay } from "@/lib/time";
import { mergeClassNames } from "@/lib/utils";
import { IconTile } from "@/components/layout/icon-tile";
import { Column, Row } from "@/components/layout/flex";
import { Text } from "@/components/layout/text";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  frameIdentityKey,
  usePhotoDeletion,
} from "@/components/photos/use-photo-deletion";

const TARGET_CELL_WIDTH_PX = 168;
const MIN_COLUMNS = 2;
const MAX_COLUMNS = 6;
const CELL_GAP_PX = 12;
const CELL_BORDER_PX = 2;
const THUMBNAIL_ASPECT = 3 / 4;

interface PhotoManagementDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description: string;
  frames: Frame[];
  initialFrameKey?: string;
  emptyMessage?: string;
  isLoading?: boolean;
  loadError?: string | null;
  onRetry?: () => void;
}

/** Full-day or activity-span gallery with auditable single/batch deletion. */
export const PhotoManagementDialog = ({
  open,
  onOpenChange,
  title,
  description,
  frames,
  initialFrameKey,
  emptyMessage = "No photos were recorded in this time frame.",
  isLoading = false,
  loadError = null,
  onRetry,
}: PhotoManagementDialogProps) => {
  const deletion = usePhotoDeletion();
  const [isSelectionMode, setIsSelectionMode] = useState(false);
  const [selectedKeys, setSelectedKeys] = useState<Set<string>>(new Set());
  const [confirmFrames, setConfirmFrames] = useState<Frame[] | null>(null);
  const selectionAnchorKeyRef = useRef<string | null>(null);

  const orderedFrames = useMemo(
    () =>
      [...frames].sort(
        (first, second) =>
          first.captureEpochMs - second.captureEpochMs ||
          frameIdentityKey(first).localeCompare(frameIdentityKey(second)),
      ),
    [frames],
  );
  const liveFrameCount = orderedFrames.filter(
    (frame) => frame.deletedAt === null,
  ).length;

  useEffect(() => {
    const liveKeys = new Set(
      orderedFrames
        .filter((frame) => frame.deletedAt === null)
        .map(frameIdentityKey),
    );
    if (
      selectionAnchorKeyRef.current !== null &&
      !liveKeys.has(selectionAnchorKeyRef.current)
    ) {
      selectionAnchorKeyRef.current = null;
    }
    setSelectedKeys((current) => {
      const next = new Set([...current].filter((key) => liveKeys.has(key)));
      return next.size === current.size ? current : next;
    });
  }, [orderedFrames]);

  const closeSelectionMode = () => {
    setSelectedKeys(new Set());
    selectionAnchorKeyRef.current = null;
    setIsSelectionMode(false);
  };

  const handleOpenChange = (nextOpen: boolean) => {
    if (!nextOpen && deletion.isPending) return;
    if (!nextOpen) {
      closeSelectionMode();
      setConfirmFrames(null);
    }
    onOpenChange(nextOpen);
  };

  const toggleSelection = (
    frame: Frame,
    event: MouseEvent<HTMLButtonElement>,
  ) => {
    if (frame.deletedAt !== null) return;
    const key = frameIdentityKey(frame);

    if (event.shiftKey && selectionAnchorKeyRef.current !== null) {
      const anchorIndex = orderedFrames.findIndex(
        (candidate) =>
          frameIdentityKey(candidate) === selectionAnchorKeyRef.current,
      );
      const frameIndex = orderedFrames.findIndex(
        (candidate) => frameIdentityKey(candidate) === key,
      );

      if (anchorIndex !== -1 && frameIndex !== -1) {
        const rangeStart = Math.min(anchorIndex, frameIndex);
        const rangeEnd = Math.max(anchorIndex, frameIndex);
        const rangeKeys = orderedFrames
          .slice(rangeStart, rangeEnd + 1)
          .filter((candidate) => candidate.deletedAt === null)
          .map(frameIdentityKey);

        setSelectedKeys((current) => new Set([...current, ...rangeKeys]));
        return;
      }
    }

    selectionAnchorKeyRef.current = key;
    setSelectedKeys((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const selectedFrames = orderedFrames.filter((frame) =>
    selectedKeys.has(frameIdentityKey(frame)),
  );

  const confirmDeletion = () => {
    if (confirmFrames === null || confirmFrames.length === 0) return;
    deletion.mutate(confirmFrames, {
      onSuccess: () => {
        setConfirmFrames(null);
        closeSelectionMode();
      },
      onError: () => setConfirmFrames(null),
    });
  };

  // --- Virtualized grid geometry --------------------------------------------

  const [scrollElement, setScrollElement] = useState<HTMLDivElement | null>(
    null,
  );
  const [gridWidth, setGridWidth] = useState(0);

  useEffect(() => {
    if (scrollElement === null) return;
    const measure = () => setGridWidth(scrollElement.clientWidth);
    measure();
    const measureTimeout = setTimeout(measure, 0);
    const observer = new ResizeObserver(([entry]) => {
      setGridWidth(entry.contentRect.width);
    });
    observer.observe(scrollElement);
    return () => {
      clearTimeout(measureTimeout);
      observer.disconnect();
    };
  }, [scrollElement]);

  const columns =
    gridWidth === 0
      ? MIN_COLUMNS
      : Math.min(
          MAX_COLUMNS,
          Math.max(
            MIN_COLUMNS,
            Math.floor(
              (gridWidth + CELL_GAP_PX) / (TARGET_CELL_WIDTH_PX + CELL_GAP_PX),
            ),
          ),
        );
  const cellWidth =
    gridWidth === 0
      ? TARGET_CELL_WIDTH_PX
      : (gridWidth - CELL_GAP_PX * (columns - 1)) / columns;
  const thumbnailHeight = Math.round(cellWidth * THUMBNAIL_ASPECT);
  const rowHeight = thumbnailHeight + CELL_BORDER_PX + CELL_GAP_PX;

  const frameRows = useMemo(() => {
    const rows: Frame[][] = [];
    for (let index = 0; index < orderedFrames.length; index += columns) {
      rows.push(orderedFrames.slice(index, index + columns));
    }
    return rows;
  }, [orderedFrames, columns]);

  const virtualizer = useVirtualizer({
    count: frameRows.length,
    getScrollElement: () => scrollElement,
    estimateSize: () => rowHeight,
    overscan: 4,
    enabled: gridWidth > 0,
  });

  useEffect(() => {
    virtualizer.measure();
  }, [rowHeight, virtualizer]);

  const initialScrollDoneRef = useRef(false);
  useEffect(() => {
    if (!open) {
      initialScrollDoneRef.current = false;
      return;
    }
    if (
      initialScrollDoneRef.current ||
      gridWidth === 0 ||
      initialFrameKey === undefined
    ) {
      return;
    }
    initialScrollDoneRef.current = true;
    const frameIndex = orderedFrames.findIndex(
      (frame) => frameIdentityKey(frame) === initialFrameKey,
    );
    if (frameIndex !== -1) {
      virtualizer.scrollToIndex(Math.floor(frameIndex / columns), {
        align: "center",
      });
    }
  }, [columns, gridWidth, initialFrameKey, open, orderedFrames, virtualizer]);

  const confirmationCount = confirmFrames?.length ?? 0;
  const confirmationNoun =
    confirmationCount === 1 ? "image file" : "image files";
  const deletedFrameCount = orderedFrames.length - liveFrameCount;

  return (
    <>
      <Dialog open={open} onOpenChange={handleOpenChange}>
        <DialogContent variant="panel" closePosition="inset">
          <DialogHeader variant="bar-spacious">
            <Row gap="md" align="start">
              <IconTile>
                <ImagesIcon aria-hidden />
              </IconTile>
              <Column gap="xs" className="min-w-0">
                <DialogTitle size="xl">{title}</DialogTitle>
                <DialogDescription className="leading-relaxed">
                  {description}
                </DialogDescription>
              </Column>
            </Row>
          </DialogHeader>

          {!isLoading && loadError === null && (
            <Row
              gap="md"
              align="center"
              justify="between"
              wrap
              className="min-h-14 border-b border-border/70 bg-muted/20 px-5 py-3 sm:px-7"
            >
              {isSelectionMode ? (
                <>
                  <Row gap="sm" align="center" wrap>
                    <span
                      className="rounded-lg bg-foreground px-2.5 py-1 text-xs font-medium text-background tabular-nums"
                      aria-live="polite"
                    >
                      {selectedKeys.size} selected
                    </span>
                    <Text variant="nudge" className="hidden sm:block">
                      Shift-click to select a continuous range.
                    </Text>
                  </Row>
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={deletion.isPending}
                    onClick={closeSelectionMode}
                  >
                    Cancel
                  </Button>
                </>
              ) : (
                <>
                  <Row gap="sm" align="center" wrap>
                    <span className="inline-flex items-center gap-1.5 rounded-lg border bg-background px-2.5 py-1.5 text-xs font-medium tabular-nums">
                      <ImagesIcon
                        className="size-3.5 text-muted-foreground"
                        aria-hidden
                      />
                      {liveFrameCount}{" "}
                      {liveFrameCount === 1 ? "photo" : "photos"}
                    </span>
                    {deletedFrameCount > 0 && (
                      <Text variant="nudge">{deletedFrameCount} deleted</Text>
                    )}
                  </Row>
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={liveFrameCount === 0}
                    onClick={() => setIsSelectionMode(true)}
                  >
                    Choose Multiple
                  </Button>
                </>
              )}
            </Row>
          )}

          {!isLoading && loadError === null && deletion.isError && (
            <div className="border-b border-destructive/20 bg-destructive/5 px-5 py-3 sm:px-7">
              <Text variant="destructive" role="alert">
                {deletion.error instanceof ApiError
                  ? deletion.error.message
                  : "Some photos could not be deleted. The gallery was refreshed; please try again."}
              </Text>
            </div>
          )}

          {isLoading ? (
            <div className="flex min-h-72 items-center justify-center bg-muted/15 px-5 py-12">
              <Row gap="sm" align="center">
                <LoaderCircleIcon className="animate-spin" aria-hidden />
                <Text variant="secondary">Loading photos…</Text>
              </Row>
            </div>
          ) : loadError !== null ? (
            <div className="flex min-h-72 items-center justify-center bg-muted/15 px-5 py-12">
              <Column gap="md" align="center" className="max-w-md text-center">
                <Text variant="destructive" role="alert">
                  {loadError}
                </Text>
                {onRetry !== undefined && (
                  <Button variant="outline" size="sm" onClick={onRetry}>
                    Try again
                  </Button>
                )}
              </Column>
            </div>
          ) : orderedFrames.length === 0 ? (
            <div className="flex min-h-72 items-center justify-center bg-muted/15 px-5 py-12">
              <Column gap="sm" align="center" className="max-w-md text-center">
                <IconTile tone="outline" size="xl">
                  <ImageOffIcon aria-hidden />
                </IconTile>
                <Text variant="secondary">{emptyMessage}</Text>
              </Column>
            </div>
          ) : (
            <div className="bg-muted/15 p-3 sm:p-5">
              {liveFrameCount === 0 && (
                <Text variant="secondary" className="pb-3 text-center">
                  No photos remaining. Deleted placeholders are shown below.
                </Text>
              )}
              <div
                ref={setScrollElement}
                className="max-h-[66vh] min-h-64 overflow-y-auto pr-1"
              >
                <div
                  className="relative"
                  style={{ height: virtualizer.getTotalSize() }}
                >
                  {virtualizer.getVirtualItems().map((virtualRow) => (
                    <div
                      key={virtualRow.key}
                      className="absolute top-0 left-0 grid w-full"
                      style={{
                        transform: `translateY(${virtualRow.start}px)`,
                        gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))`,
                        gap: CELL_GAP_PX,
                      }}
                    >
                      {frameRows[virtualRow.index].map((frame) => {
                        const key = frameIdentityKey(frame);
                        const isDeleted = frame.deletedAt !== null;
                        const isSelected = selectedKeys.has(key);
                        const content = (
                          <div
                            className="relative w-full overflow-hidden bg-muted"
                            style={{ height: thumbnailHeight }}
                          >
                            {isDeleted ? (
                              <div className="flex size-full flex-col items-center justify-center gap-1.5 bg-muted/70 text-muted-foreground">
                                <IconTile tone="subtle" size="sm">
                                  <ImageOffIcon aria-hidden />
                                </IconTile>
                                <span className="text-xs font-medium">
                                  Deleted
                                </span>
                              </div>
                            ) : (
                              /* eslint-disable-next-line @next/next/no-img-element -- authenticated image; the Next image proxy cannot forward the auth cookie */
                              <img
                                src={frameImageSrc(frame.imageUrl!)}
                                alt={`Frame at ${formatTimeOfDay(frame.captureEpochMs)}`}
                                loading="lazy"
                                decoding="async"
                                fetchPriority="low"
                                className="size-full bg-muted object-cover"
                              />
                            )}
                            {!isDeleted && (
                              <span
                                className="pointer-events-none absolute inset-x-0 bottom-0 h-12 bg-gradient-to-t from-black/45 to-transparent"
                                aria-hidden
                              />
                            )}
                            <span className="pointer-events-none absolute bottom-2 left-2 rounded-md border border-white/15 bg-black/70 px-2 py-1 text-3xs font-medium text-white tabular-nums">
                              {formatTimeOfDay(frame.captureEpochMs)}
                            </span>
                          </div>
                        );

                        if (isSelectionMode) {
                          return (
                            <button
                              key={key}
                              type="button"
                              role="checkbox"
                              aria-checked={isSelected}
                              aria-label={
                                isDeleted
                                  ? `Deleted photo from ${formatTimeOfDay(frame.captureEpochMs)}`
                                  : `Select photo from ${formatTimeOfDay(frame.captureEpochMs)}`
                              }
                              disabled={isDeleted || deletion.isPending}
                              onClick={(event) => toggleSelection(frame, event)}
                              className={mergeClassNames(
                                "relative overflow-hidden rounded-xl border bg-background text-left transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed",
                                isSelected && "border-blue-600",
                                isDeleted && "opacity-70",
                              )}
                            >
                              {content}
                              {isSelected && (
                                <span
                                  className="pointer-events-none absolute inset-0 z-10 rounded-[inherit] border-[3.5px] border-blue-600"
                                  aria-hidden
                                />
                              )}
                              {!isDeleted && (
                                <span
                                  className={mergeClassNames(
                                    "absolute top-2 left-2 z-20 flex size-7 items-center justify-center rounded-lg border-2 bg-background/95",
                                    isSelected &&
                                      "border-blue-600 bg-blue-600 text-white",
                                  )}
                                  aria-hidden
                                >
                                  {isSelected && (
                                    <CheckIcon className="size-4" />
                                  )}
                                </span>
                              )}
                            </button>
                          );
                        }

                        return (
                          <figure
                            key={key}
                            className={mergeClassNames(
                              "relative overflow-hidden rounded-xl border bg-background",
                              isDeleted && "opacity-70",
                            )}
                          >
                            {content}
                            {!isDeleted && (
                              <Button
                                variant="destructive-fill"
                                size="icon-sm"
                                surface="overlay"
                                className="absolute top-2 right-2 border-destructive/15"
                                aria-label={`Delete photo from ${formatTimeOfDay(frame.captureEpochMs)}`}
                                disabled={deletion.isPending}
                                onClick={() => setConfirmFrames([frame])}
                              >
                                <Trash2Icon />
                              </Button>
                            )}
                          </figure>
                        );
                      })}
                    </div>
                  ))}
                </div>
              </div>
            </div>
          )}

          {!isLoading && loadError === null && isSelectionMode && (
            <DialogFooter variant="split">
              <Text variant="nudge" className="text-center sm:text-left">
                Deleted files cannot be restored.
              </Text>
              <Button
                variant="destructive-fill"
                className="sm:min-w-44"
                disabled={selectedFrames.length === 0 || deletion.isPending}
                onClick={() => setConfirmFrames(selectedFrames)}
              >
                {deletion.isPending && (
                  <LoaderCircleIcon className="animate-spin" />
                )}
                Delete Selected ({selectedFrames.length})
              </Button>
            </DialogFooter>
          )}
        </DialogContent>
      </Dialog>

      <Dialog
        open={confirmFrames !== null}
        onOpenChange={(nextOpen) => {
          if (!nextOpen && !deletion.isPending) setConfirmFrames(null);
        }}
      >
        <DialogContent variant="confirm">
          <DialogBody>
            <DialogHeader>
              <IconTile tone="destructive" size="lg" className="mb-2">
                <Trash2Icon aria-hidden />
              </IconTile>
              <DialogTitle size="lg">
                Delete {confirmationCount} {confirmationNoun}?
              </DialogTitle>
              <DialogDescription className="leading-relaxed">
                The selected {confirmationNoun} will be permanently removed from
                the study data. Its timestamped database record will remain
                marked as deleted.
              </DialogDescription>
            </DialogHeader>
          </DialogBody>
          <DialogFooter variant="flush">
            <Button
              variant="outline"
              disabled={deletion.isPending}
              onClick={() => setConfirmFrames(null)}
            >
              Cancel
            </Button>
            <Button
              variant="destructive-fill"
              disabled={deletion.isPending}
              onClick={confirmDeletion}
            >
              {deletion.isPending && (
                <LoaderCircleIcon className="animate-spin" />
              )}
              Delete
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
};
