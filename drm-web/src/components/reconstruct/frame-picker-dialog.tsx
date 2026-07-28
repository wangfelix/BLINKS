"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";

import type { Frame } from "@/lib/api-types";
import { frameImageSrc } from "@/lib/api-client";
import { formatTimeOfDay } from "@/lib/time";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Column, Row } from "@/components/layout/flex";
import { Text } from "@/components/layout/text";
import { mergeClassNames } from "@/lib/utils";

// Grid geometry. Every size is computed in pixels so each virtualized row has
// an exact height — thumbnails can never be squished by the container, no
// matter how many frames the day has.
const TARGET_CELL_WIDTH_PX = 140;
const MIN_COLUMNS = 3;
const MAX_COLUMNS = 6;
const CELL_GAP_PX = 8;
const CAPTION_HEIGHT_PX = 20;
const CELL_BORDER_PX = 2; // 1px top + 1px bottom on the cell button
const THUMBNAIL_ASPECT = 3 / 4; // height / width
const HALF_HOUR_MS = 30 * 60 * 1000;

interface TimelineMark {
  epochMs: number;
  label: string;
  isFullHour: boolean;
  /** Index of the first frame in this half-hour slot; null = slot is empty. */
  firstFrameIndex: number | null;
}

/**
 * Half-hour marks covering the frame range. Works on epoch ms: the study
 * timezone's UTC offset is a whole multiple of 30 minutes, so UTC half-hour
 * boundaries are also local half-hour boundaries.
 */
const buildTimelineMarks = (frames: Frame[]): TimelineMark[] => {
  if (frames.length === 0) return [];
  const firstMs = frames[0].captureEpochMs;
  const lastMs = frames[frames.length - 1].captureEpochMs;
  const firstMarkMs = firstMs - (firstMs % HALF_HOUR_MS);

  const marks: TimelineMark[] = [];
  let searchFrom = 0;
  for (let markMs = firstMarkMs; markMs <= lastMs; markMs += HALF_HOUR_MS) {
    while (
      searchFrom < frames.length &&
      frames[searchFrom].captureEpochMs < markMs
    ) {
      searchFrom += 1;
    }
    const slotHasFrames =
      searchFrom < frames.length &&
      frames[searchFrom].captureEpochMs < markMs + HALF_HOUR_MS;
    const label = formatTimeOfDay(markMs);
    marks.push({
      epochMs: markMs,
      label,
      isFullHour: label.endsWith(":00"),
      firstFrameIndex: slotHasFrames ? searchFrom : null,
    });
  }
  return marks;
};

/**
 * Frame-strip picker used for boundary adjustment and for inserting a new
 * activity. The participant clicks a first frame (start) and a second frame
 * (end); the activity's times derive from the chosen frames. Clicking before
 * the current start, or clicking again after both are set, starts a fresh
 * selection.
 *
 * The grid is virtualized so a whole study day (thousands of frames) stays
 * smooth; the timeline rail on the left jumps to any hour or half hour.
 */
export const FramePickerDialog = ({
  open,
  onOpenChange,
  title,
  description,
  frames,
  initialStartMs,
  initialEndMs,
  confirmLabel,
  onConfirm,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description: string;
  frames: Frame[];
  initialStartMs?: number;
  initialEndMs?: number;
  confirmLabel: string;
  onConfirm: (startMs: number, endMs: number) => void;
}) => {
  // The selection initializes once, at mount. The round editor mounts this
  // dialog freshly for every adjust/insert interaction (it renders it only
  // while one is active), so each opening starts from the initial values.
  const [startMs, setStartMs] = useState<number | null>(initialStartMs ?? null);
  const [endMs, setEndMs] = useState<number | null>(initialEndMs ?? null);

  // --- Grid geometry, measured from the scroll container's width ------------

  // Base UI inserts the popup into the DOM a beat AFTER this component mounts
  // (and briefly keeps it hidden while positioning), so neither a mount-time
  // effect nor a plain ref sees the scroll container reliably. A callback ref
  // hands us the element exactly when it appears.
  const [scrollElement, setScrollElement] = useState<HTMLDivElement | null>(
    null,
  );
  const [gridWidth, setGridWidth] = useState(0);

  useEffect(() => {
    if (scrollElement === null) return;
    const measure = () => setGridWidth(scrollElement.clientWidth);
    measure();
    // The popup can still be hidden (width 0) at this moment; it is revealed
    // by the next macrotask.
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
  const cellWidth = (gridWidth - CELL_GAP_PX * (columns - 1)) / columns;
  const thumbnailHeight = Math.round(cellWidth * THUMBNAIL_ASPECT);
  const rowHeight =
    thumbnailHeight + CAPTION_HEIGHT_PX + CELL_BORDER_PX + CELL_GAP_PX;

  const frameRows = useMemo(() => {
    const rows: Frame[][] = [];
    for (let index = 0; index < frames.length; index += columns) {
      rows.push(frames.slice(index, index + columns));
    }
    return rows;
  }, [frames, columns]);

  const virtualizer = useVirtualizer({
    count: frameRows.length,
    getScrollElement: () => scrollElement,
    estimateSize: () => rowHeight,
    overscan: 4,
    // Wait for the width measurement; enabling earlier would make the
    // virtualizer capture the still-hidden popup's zero-size rect.
    enabled: gridWidth > 0,
  });

  // Row height depends on the measured width; re-measure when it changes.
  useEffect(() => {
    virtualizer.measure();
  }, [rowHeight, virtualizer]);

  // Open the grid at the activity's current start frame (adjust mode), so an
  // afternoon activity doesn't greet the participant with 6 AM frames.
  const initialScrollDoneRef = useRef(false);
  useEffect(() => {
    if (initialScrollDoneRef.current || gridWidth === 0) return;
    initialScrollDoneRef.current = true;
    if (initialStartMs === undefined) return;
    const frameIndex = frames.findIndex(
      (frame) => frame.captureEpochMs >= initialStartMs,
    );
    if (frameIndex === -1) return;
    virtualizer.scrollToIndex(Math.floor(frameIndex / columns), {
      align: "start",
    });
  }, [gridWidth, columns, frames, initialStartMs, virtualizer]);

  const timelineMarks = useMemo(() => buildTimelineMarks(frames), [frames]);

  const scrollToFrameIndex = (frameIndex: number) => {
    virtualizer.scrollToIndex(Math.floor(frameIndex / columns), {
      align: "start",
    });
  };

  // --- Selection -------------------------------------------------------------

  const handleFrameClick = (frameMs: number) => {
    const selectionComplete = startMs !== null && endMs !== null;
    const startsFreshSelection =
      startMs === null || frameMs < startMs || selectionComplete;
    if (startsFreshSelection) {
      setStartMs(frameMs);
      setEndMs(null);
    } else {
      setEndMs(frameMs);
    }
  };

  const hasFrames = frames.length > 0;
  const hasSelection = startMs !== null || endMs !== null;
  const canConfirm = startMs !== null && endMs !== null && startMs <= endMs;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-4xl">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>

        {!hasFrames ? (
          <Text variant="secondary" className="py-6 text-center">
            There are no unassigned frames in this gap.
          </Text>
        ) : (
          <>
            <Text variant="nudge">
              Click the first frame of the activity, then its last frame.
              {startMs !== null && (
                <span className="ml-1 font-medium text-foreground">
                  Start {formatTimeOfDay(startMs)}
                  {endMs !== null && ` — End ${formatTimeOfDay(endMs)}`}
                </span>
              )}
            </Text>

            <Row gap="md">
              {timelineMarks.length > 1 && (
                <nav
                  aria-label="Jump to time of day"
                  className="max-h-[55vh] shrink-0 overflow-y-auto pr-1"
                >
                  <Column>
                    {timelineMarks.map((mark) => (
                      <button
                        key={mark.epochMs}
                        type="button"
                        disabled={mark.firstFrameIndex === null}
                        onClick={() => {
                          if (mark.firstFrameIndex !== null) {
                            scrollToFrameIndex(mark.firstFrameIndex);
                          }
                        }}
                        className={mergeClassNames(
                          "rounded px-1.5 py-0.5 text-left text-xs tabular-nums transition-colors",
                          mark.isFullHour
                            ? "font-medium text-foreground"
                            : "text-muted-foreground",
                          mark.firstFrameIndex === null
                            ? "opacity-40"
                            : "hover:bg-muted",
                        )}
                      >
                        {mark.label}
                      </button>
                    ))}
                  </Column>
                </nav>
              )}

              <div
                ref={setScrollElement}
                className="max-h-[55vh] min-w-0 flex-1 overflow-y-auto"
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
                        const isStart = frame.captureEpochMs === startMs;
                        const isEnd = frame.captureEpochMs === endMs;
                        const isSelectionBoundary = isStart || isEnd;
                        const isInSelectedRange =
                          startMs !== null &&
                          endMs !== null &&
                          frame.captureEpochMs >= startMs &&
                          frame.captureEpochMs <= endMs;
                        return (
                          <button
                            key={frame.captureEpochMs}
                            type="button"
                            onClick={() =>
                              handleFrameClick(frame.captureEpochMs)
                            }
                            className={mergeClassNames(
                              "relative overflow-hidden rounded-md border text-left transition-shadow focus-visible:ring-2 focus-visible:ring-ring",
                              isInSelectedRange && "ring-2 ring-primary/50",
                              isSelectionBoundary && "ring-2 ring-primary",
                            )}
                          >
                            {/* eslint-disable-next-line @next/next/no-img-element -- authenticated cross-origin image; the Next image proxy cannot forward the auth cookie */}
                            <img
                              src={frameImageSrc(frame.imageUrl!)}
                              alt={`Frame at ${formatTimeOfDay(frame.captureEpochMs)}`}
                              loading="lazy"
                              className="w-full bg-muted object-cover"
                              style={{ height: thumbnailHeight }}
                            />
                            <span
                              className="block bg-background/90 px-1 text-center text-[10px] tabular-nums"
                              style={{
                                height: CAPTION_HEIGHT_PX,
                                lineHeight: `${CAPTION_HEIGHT_PX}px`,
                              }}
                            >
                              {formatTimeOfDay(frame.captureEpochMs)}
                            </span>
                            {isSelectionBoundary && (
                              <span className="absolute top-1 left-1 rounded bg-primary px-1 text-[10px] font-medium text-primary-foreground">
                                {isStart && isEnd
                                  ? "Start + End"
                                  : isStart
                                    ? "Start"
                                    : "End"}
                              </span>
                            )}
                          </button>
                        );
                      })}
                    </div>
                  ))}
                </div>
              </div>
            </Row>
          </>
        )}

        <DialogFooter>
          <Button
            variant="ghost"
            onClick={() => {
              setStartMs(null);
              setEndMs(null);
            }}
            disabled={!hasSelection}
          >
            Clear selection
          </Button>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            disabled={!canConfirm}
            onClick={() => {
              if (startMs !== null && endMs !== null) {
                onConfirm(startMs, endMs);
              }
            }}
          >
            {confirmLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};
