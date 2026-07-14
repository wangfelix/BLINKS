"use client";

import { useState } from "react";

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
import { Text } from "@/components/layout/text";
import { mergeClassNames } from "@/lib/utils";

/**
 * Frame-strip picker used for boundary adjustment and for inserting a new
 * activity. The participant clicks a first frame (start) and a second frame
 * (end); the activity's times derive from the chosen frames. Clicking before
 * the current start, or clicking again after both are set, starts a fresh
 * selection.
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
      <DialogContent className="sm:max-w-3xl">
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
            <div className="grid max-h-[55vh] grid-cols-3 gap-2 overflow-y-auto pr-1 sm:grid-cols-5">
              {frames.map((frame) => {
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
                    onClick={() => handleFrameClick(frame.captureEpochMs)}
                    className={mergeClassNames(
                      "relative overflow-hidden rounded-md border text-left transition-shadow focus-visible:ring-2 focus-visible:ring-ring",
                      isInSelectedRange && "ring-2 ring-primary/50",
                      isSelectionBoundary && "ring-2 ring-primary",
                    )}
                  >
                    {/* eslint-disable-next-line @next/next/no-img-element -- authenticated cross-origin image; the Next image proxy cannot forward the auth cookie */}
                    <img
                      src={frameImageSrc(frame.imageUrl)}
                      alt={`Frame at ${formatTimeOfDay(frame.captureEpochMs)}`}
                      loading="lazy"
                      className="aspect-[4/3] w-full bg-muted object-cover"
                    />
                    <span className="block bg-background/90 px-1 py-0.5 text-center text-[10px] tabular-nums">
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
