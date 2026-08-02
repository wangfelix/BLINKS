"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import {
  ArrowRightIcon,
  Clock3Icon,
  ImageOffIcon,
  RotateCcwIcon,
} from "lucide-react";

import type { Frame } from "@/lib/api-types";
import { frameImageSrc } from "@/lib/api-client";
import { formatTimeOfDay } from "@/lib/time";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Column, Row } from "@/components/layout/flex";
import { Text } from "@/components/layout/text";
import { mergeClassNames } from "@/lib/utils";

// Grid geometry. Every size is computed in pixels so each virtualized row has
// an exact height — thumbnails can never be squished by the container, no
// matter how many frames the day has.
const TARGET_CELL_WIDTH_PX = 168;
const MIN_COLUMNS = 2;
const MAX_COLUMNS = 6;
const CELL_GAP_PX = 12;
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
  const cellWidth =
    gridWidth === 0
      ? TARGET_CELL_WIDTH_PX
      : (gridWidth - CELL_GAP_PX * (columns - 1)) / columns;
  const thumbnailHeight = Math.round(cellWidth * THUMBNAIL_ASPECT);
  const rowHeight = thumbnailHeight + CELL_BORDER_PX + CELL_GAP_PX;

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
  const selectionInstruction =
    startMs === null
      ? "Choose the first frame of the activity."
      : endMs === null
        ? "Now choose the last frame of the activity."
        : "Review the selected range, then apply it.";

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[calc(100dvh-1rem)] gap-0 overflow-hidden rounded-3xl border-border/70 bg-background p-0 sm:max-w-6xl [&_[data-slot=dialog-close]]:top-5 [&_[data-slot=dialog-close]]:right-5">
        <DialogHeader className="border-b border-border/70 px-5 py-5 pr-16 sm:px-7 sm:py-6 sm:pr-20">
          <Row gap="md" align="start">
            <div className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-primary/10 text-primary ring-1 ring-primary/10">
              <Clock3Icon className="size-5" aria-hidden />
            </div>
            <Column gap="xs" className="min-w-0">
              <DialogTitle className="text-lg leading-tight font-semibold sm:text-xl">
                {title}
              </DialogTitle>
              <DialogDescription className="leading-relaxed">
                {description}
              </DialogDescription>
            </Column>
          </Row>
        </DialogHeader>

        {!hasFrames ? (
          <div className="flex min-h-72 items-center justify-center bg-muted/15 px-5 py-12">
            <Column gap="sm" align="center" className="max-w-md text-center">
              <div className="flex size-12 items-center justify-center rounded-2xl border bg-background text-muted-foreground">
                <ImageOffIcon className="size-5" aria-hidden />
              </div>
              <Text variant="secondary">
                There are no unassigned frames in this gap.
              </Text>
            </Column>
          </div>
        ) : (
          <>
            <div className="flex min-h-16 flex-wrap items-center justify-between gap-3 border-b border-border/70 bg-muted/20 px-5 py-3 sm:px-7">
              <Column gap="xs">
                <p className="text-sm font-medium">Select the time span</p>
                <Text variant="nudge">{selectionInstruction}</Text>
              </Column>

              <Row gap="xs" align="center" wrap>
                <span
                  className={mergeClassNames(
                    "inline-flex min-h-8 items-center gap-1.5 rounded-lg border bg-background px-2.5 py-1 text-xs",
                    startMs !== null &&
                      "border-blue-200 bg-blue-50 text-blue-700 dark:border-blue-800 dark:bg-blue-950/50 dark:text-blue-300",
                  )}
                >
                  <span className="text-muted-foreground">Start</span>
                  <strong className="font-medium tabular-nums">
                    {startMs === null ? "—" : formatTimeOfDay(startMs)}
                  </strong>
                </span>
                <ArrowRightIcon
                  className="size-3.5 text-muted-foreground"
                  aria-hidden
                />
                <span
                  className={mergeClassNames(
                    "inline-flex min-h-8 items-center gap-1.5 rounded-lg border bg-background px-2.5 py-1 text-xs",
                    endMs !== null &&
                      "border-blue-200 bg-blue-50 text-blue-700 dark:border-blue-800 dark:bg-blue-950/50 dark:text-blue-300",
                  )}
                >
                  <span className="text-muted-foreground">End</span>
                  <strong className="font-medium tabular-nums">
                    {endMs === null ? "—" : formatTimeOfDay(endMs)}
                  </strong>
                </span>
              </Row>
            </div>

            <div className="bg-muted/15 p-3 sm:p-5">
              <Row gap="md" align="start">
                {timelineMarks.length > 1 && (
                  <nav
                    aria-label="Jump to time of day"
                    className="hidden max-h-[62vh] w-20 shrink-0 overflow-y-auto rounded-xl border bg-background p-2 sm:block"
                  >
                    <p className="px-1 pb-2 text-[10px] font-medium tracking-wide text-muted-foreground uppercase">
                      Jump to
                    </p>
                    <Column gap="xs">
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
                            "w-full rounded-lg px-2 py-1 text-left text-xs tabular-nums transition-colors",
                            mark.isFullHour
                              ? "font-medium text-foreground"
                              : "text-muted-foreground",
                            mark.firstFrameIndex === null
                              ? "opacity-35"
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
                  className="max-h-[62vh] min-w-0 flex-1 overflow-y-auto pr-1"
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
                          const frameTime = formatTimeOfDay(
                            frame.captureEpochMs,
                          );
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
                              aria-label={`Select frame at ${frameTime}`}
                              aria-pressed={
                                isSelectionBoundary || isInSelectedRange
                              }
                              onClick={() =>
                                handleFrameClick(frame.captureEpochMs)
                              }
                              className={mergeClassNames(
                                "relative overflow-hidden rounded-xl border bg-background text-left transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring",
                                isInSelectedRange &&
                                  "border-blue-500 bg-blue-50/50 dark:border-blue-500 dark:bg-blue-950/30",
                                isSelectionBoundary &&
                                  "border-blue-600 dark:border-blue-500",
                              )}
                            >
                              {/* eslint-disable-next-line @next/next/no-img-element -- authenticated cross-origin image; the Next image proxy cannot forward the auth cookie */}
                              <img
                                src={frameImageSrc(frame.imageUrl!)}
                                alt={`Frame at ${frameTime}`}
                                loading="lazy"
                                decoding="async"
                                fetchPriority="low"
                                className="w-full bg-muted object-cover"
                                style={{ height: thumbnailHeight }}
                              />
                              <span
                                className="pointer-events-none absolute inset-x-0 bottom-0 h-12 bg-gradient-to-t from-black/45 to-transparent"
                                aria-hidden
                              />
                              {(isSelectionBoundary || isInSelectedRange) && (
                                <span
                                  className="pointer-events-none absolute inset-0 z-10 rounded-[inherit] border-[3.5px] border-blue-600 bg-blue-500/10 dark:border-blue-500"
                                  aria-hidden
                                />
                              )}
                              <span className="pointer-events-none absolute bottom-2 left-2 z-20 rounded-md border border-white/15 bg-black/70 px-2 py-1 text-[10px] font-medium text-white tabular-nums">
                                {frameTime}
                              </span>
                              {isSelectionBoundary && (
                                <span className="pointer-events-none absolute top-2 left-2 z-20 rounded-md bg-blue-600 px-2 py-1 text-[10px] font-medium text-white dark:bg-blue-500">
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
            </div>
          </>
        )}

        <div className="flex flex-col gap-3 border-t border-border/70 bg-background px-5 py-4 sm:flex-row sm:items-center sm:justify-between sm:px-7">
          <Button
            variant="ghost"
            className="self-start"
            onClick={() => {
              setStartMs(null);
              setEndMs(null);
            }}
            disabled={!hasSelection}
          >
            <RotateCcwIcon aria-hidden />
            Clear selection
          </Button>
          <div className="flex flex-col-reverse gap-2 sm:flex-row">
            <Button
              variant="outline"
              className="bg-background"
              onClick={() => onOpenChange(false)}
            >
              Cancel
            </Button>
            <Button
              className="sm:min-w-36"
              disabled={!canConfirm}
              onClick={() => {
                if (startMs !== null && endMs !== null) {
                  onConfirm(startMs, endMs);
                }
              }}
            >
              {confirmLabel}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
};
