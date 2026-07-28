"use client";

import type { MouseEvent } from "react";
import { useEffect, useMemo, useRef, useState } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import {
  CheckIcon,
  ImageOffIcon,
  LoaderCircleIcon,
  Trash2Icon,
} from "lucide-react";

import type { Frame } from "@/lib/api-types";
import { ApiError, frameImageSrc } from "@/lib/api-client";
import { formatTimeOfDay } from "@/lib/time";
import { mergeClassNames } from "@/lib/utils";
import { Column, Row } from "@/components/layout/flex";
import { Text } from "@/components/layout/text";
import { Button } from "@/components/ui/button";
import {
  Dialog,
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

const TARGET_CELL_WIDTH_PX = 150;
const MIN_COLUMNS = 2;
const MAX_COLUMNS = 6;
const CELL_GAP_PX = 8;
const CAPTION_HEIGHT_PX = 24;
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
  const rowHeight =
    thumbnailHeight + CAPTION_HEIGHT_PX + CELL_BORDER_PX + CELL_GAP_PX;

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

  return (
    <>
      <Dialog open={open} onOpenChange={handleOpenChange}>
        <DialogContent className="sm:max-w-5xl">
          <DialogHeader>
            <DialogTitle>{title}</DialogTitle>
            <DialogDescription>{description}</DialogDescription>
          </DialogHeader>

          {!isLoading && loadError === null && (
            <Row gap="sm" align="center" justify="between" wrap>
              {isSelectionMode ? (
                <>
                  <Text variant="nudge" className="font-medium text-foreground">
                    {selectedKeys.size} selected
                  </Text>
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={deletion.isPending}
                    onClick={closeSelectionMode}
                  >
                    Cancel
                  </Button>
                </>
              ) : (
                <>
                  <Text variant="nudge">
                    {liveFrameCount}{" "}
                    {liveFrameCount === 1
                      ? "photo remaining"
                      : "photos remaining"}
                  </Text>
                  <Button
                    variant="secondary"
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
            <Text variant="destructive" role="alert">
              {deletion.error instanceof ApiError
                ? deletion.error.message
                : "Some photos could not be deleted. The gallery was refreshed; please try again."}
            </Text>
          )}

          {isLoading ? (
            <Row gap="sm" align="center" justify="center" className="py-12">
              <LoaderCircleIcon className="animate-spin" aria-hidden />
              <Text variant="secondary">Loading photos…</Text>
            </Row>
          ) : loadError !== null ? (
            <Column gap="sm" align="center" className="py-10">
              <Text variant="destructive" role="alert">
                {loadError}
              </Text>
              {onRetry !== undefined && (
                <Button variant="outline" size="sm" onClick={onRetry}>
                  Try again
                </Button>
              )}
            </Column>
          ) : orderedFrames.length === 0 ? (
            <Text variant="secondary" className="py-10 text-center">
              {emptyMessage}
            </Text>
          ) : (
            <Column gap="sm">
              {liveFrameCount === 0 && (
                <Text variant="secondary" className="text-center">
                  No photos remaining. Deleted placeholders are shown below.
                </Text>
              )}
              <div
                ref={setScrollElement}
                className="max-h-[62vh] min-h-48 overflow-y-auto pr-1"
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
                          <>
                            {isDeleted ? (
                              <div
                                className="flex w-full flex-col items-center justify-center gap-1 bg-muted text-muted-foreground"
                                style={{ height: thumbnailHeight }}
                              >
                                <ImageOffIcon aria-hidden />
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
                                className="w-full bg-muted object-cover"
                                style={{ height: thumbnailHeight }}
                              />
                            )}
                            <span
                              className="block bg-background/95 px-1 text-center text-[10px] tabular-nums"
                              style={{
                                height: CAPTION_HEIGHT_PX,
                                lineHeight: `${CAPTION_HEIGHT_PX}px`,
                              }}
                            >
                              {formatTimeOfDay(frame.captureEpochMs)}
                            </span>
                          </>
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
                                "relative overflow-hidden rounded-md border text-left transition-shadow focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed",
                                isSelected &&
                                  "border-primary ring-2 ring-primary/50",
                                isDeleted && "opacity-70",
                              )}
                            >
                              {content}
                              {!isDeleted && (
                                <span
                                  className={mergeClassNames(
                                    "absolute top-2 left-2 flex size-6 items-center justify-center rounded border-2 bg-background/90",
                                    isSelected &&
                                      "border-primary bg-primary text-primary-foreground",
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
                              "relative overflow-hidden rounded-md border",
                              isDeleted && "opacity-70",
                            )}
                          >
                            {content}
                            {!isDeleted && (
                              <Button
                                variant="destructive"
                                size="icon-sm"
                                className="absolute top-1.5 right-1.5 bg-background/90 shadow-sm"
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
            </Column>
          )}

          {!isLoading && loadError === null && isSelectionMode && (
            <DialogFooter>
              <Button
                variant="destructive"
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
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              Delete {confirmationCount} {confirmationNoun}?
            </DialogTitle>
            <DialogDescription>
              The selected {confirmationNoun} will be permanently removed from
              the study data. Its timestamped database record will remain marked
              as deleted.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="outline"
              disabled={deletion.isPending}
              onClick={() => setConfirmFrames(null)}
            >
              Cancel
            </Button>
            <Button
              variant="destructive"
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
