"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import {
  ArrowRightIcon,
  Clock3Icon,
  ImageOffIcon,
  RotateCcwIcon,
} from "lucide-react";

import type { Frame } from "@/lib/api-types";
import { frameImageSrc } from "@/lib/api-client";
import { activityDisplayLabel } from "@/lib/activity-vocabulary";
import { formatTimeOfDay, formatTimeSpan } from "@/lib/time";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Column, Row } from "@/components/layout/flex";
import {
  FIVE_MINUTE_MS,
  sampleEvenly,
  type EditableActivity,
} from "@/components/reconstruct/editor-types";
import {
  buildFiveMinuteSlots,
  type StudyDayBounds,
  groupFiveMinuteSlots,
  slotOverlapsSpan,
  slotStartOf,
  type FiveMinuteSlot,
  type FiveMinuteSlotGroup,
  type FiveMinuteSlotGroupKind,
} from "@/components/reconstruct/time-slots";
import { frameIdentityKey } from "@/components/photos/use-photo-deletion";
import { mergeClassNames } from "@/lib/utils";

const TARGET_CELL_WIDTH_PX = 190;
const MIN_COLUMNS = 2;
const MAX_COLUMNS = 6;
const CELL_GAP_PX = 10;
const SLOT_CARD_HEIGHT_PX = 176;
const GROUP_HEADER_HEIGHT_PX = 28;
const HALF_HOUR_MS = 30 * 60 * 1000;
const MAX_SLOT_PREVIEWS = 4;

interface TimelineMark {
  epochMs: number;
  label: string;
  isFullHour: boolean;
  slotIndex: number;
}

const ceilToSlot = (epochMs: number): number => {
  const floor = slotStartOf(epochMs);
  return floor === epochMs ? epochMs : floor + FIVE_MINUTE_MS;
};

const buildTimelineMarks = (slots: FiveMinuteSlot[]): TimelineMark[] =>
  slots
    .map((slot, slotIndex) => ({ slot, slotIndex }))
    .filter(({ slot }) => slot.startMs % HALF_HOUR_MS === 0)
    .map(({ slot, slotIndex }) => {
      const label = formatTimeOfDay(slot.startMs);
      return {
        epochMs: slot.startMs,
        label,
        isFullHour: label.endsWith(":00"),
        slotIndex,
      };
    });

const slotAssignmentLabel = (
  slot: FiveMinuteSlot,
  currentActivityId: string | undefined,
): string => {
  if (
    currentActivityId !== undefined &&
    slot.owner?.localId === currentActivityId
  ) {
    return "Current activity";
  }
  if (slot.owner !== null) {
    return `Assigned to ${
      activityDisplayLabel(slot.owner.rawLabel) ?? "unlabelled activity"
    }`;
  }
  if (slot.frames.length > 0) {
    return "Unassigned images";
  }
  return "No activity assigned";
};

const groupContainerClasses = (kind: FiveMinuteSlotGroupKind): string => {
  if (kind === "current") {
    return "border border-teal-200/80 bg-teal-50/30 dark:border-teal-900/80 dark:bg-teal-950/15";
  }
  if (kind === "assigned") {
    return "border border-violet-200/80 bg-violet-50/30 dark:border-violet-900/80 dark:bg-violet-950/15";
  }
  if (kind === "unassigned") {
    return "border border-dashed border-destructive/45 bg-destructive/[0.025]";
  }
  return "border border-border/60 bg-background";
};

const groupHeaderClasses = (kind: FiveMinuteSlotGroupKind): string => {
  if (kind === "current") {
    return "border-teal-200/70 bg-teal-100/45 text-teal-800 dark:border-teal-900 dark:bg-teal-900/25 dark:text-teal-200";
  }
  if (kind === "assigned") {
    return "border-violet-200/70 bg-violet-100/45 text-violet-800 dark:border-violet-900 dark:bg-violet-900/25 dark:text-violet-200";
  }
  if (kind === "unassigned") {
    return "border-destructive/25 bg-destructive/5 text-destructive";
  }
  return "border-border/50 bg-muted/20 text-muted-foreground";
};

const groupDividerClasses = (kind: FiveMinuteSlotGroupKind): string => {
  if (kind === "current") return "border-teal-200/70 dark:border-teal-900";
  if (kind === "assigned") {
    return "border-violet-200/70 dark:border-violet-900";
  }
  if (kind === "unassigned") return "border-destructive/20";
  return "border-border/50";
};

const groupLabel = (group: FiveMinuteSlotGroup): string => {
  if (group.kind === "current") return "Current activity";
  if (group.kind === "assigned") {
    return (
      activityDisplayLabel(group.owner?.rawLabel ?? null) ??
      "Unlabelled activity"
    );
  }
  if (group.kind === "unassigned") return "Unassigned images";
  return "No activity assigned";
};

const groupColumnCount = (
  group: FiveMinuteSlotGroup,
  columns: number,
): number => Math.min(columns, group.slots.length);

const groupHeight = (group: FiveMinuteSlotGroup, columns: number): number =>
  GROUP_HEADER_HEIGHT_PX +
  Math.ceil(group.slots.length / columns) * SLOT_CARD_HEIGHT_PX;

/** Keep semantic groups whole; only long neutral gaps are row-sized. */
const splitLongEmptyGroups = (
  groups: FiveMinuteSlotGroup[],
  columns: number,
): FiveMinuteSlotGroup[] =>
  groups.flatMap((group) => {
    if (group.kind !== "empty" || group.slots.length <= columns) return [group];
    const segments: FiveMinuteSlotGroup[] = [];
    for (let index = 0; index < group.slots.length; index += columns) {
      segments.push({
        ...group,
        key: `${group.key}:${index}`,
        slots: group.slots.slice(index, index + columns),
      });
    }
    return segments;
  });

/**
 * Five-minute time picker shared by assisted insertion and boundary editing.
 * The full pinned study day remains selectable even when no image was recorded.
 * Images are grouped into their clock-aligned slot and assignment state is
 * shown separately from image availability.
 */
export const FramePickerDialog = ({
  open,
  onOpenChange,
  title,
  description,
  dayBounds,
  frames,
  activities,
  currentActivityId,
  initialStartMs,
  initialEndMs,
  initialFocusMs,
  confirmLabel,
  onConfirm,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description: string;
  dayBounds: StudyDayBounds;
  frames: Frame[];
  activities: EditableActivity[];
  currentActivityId?: string;
  initialStartMs?: number;
  initialEndMs?: number;
  initialFocusMs?: number;
  confirmLabel: string;
  onConfirm: (startMs: number, endMs: number) => void;
}) => {
  const normalizedInitialStart =
    initialStartMs === undefined
      ? null
      : Math.max(dayBounds.startMs, slotStartOf(initialStartMs));
  const normalizedInitialEnd =
    initialEndMs === undefined
      ? null
      : Math.min(dayBounds.endMs, ceilToSlot(initialEndMs));
  const [startMs, setStartMs] = useState<number | null>(normalizedInitialStart);
  const [endMs, setEndMs] = useState<number | null>(normalizedInitialEnd);
  const [clickAnchorMs, setClickAnchorMs] = useState<number | null>(null);

  // Depend on the two numbers, not the bounds object: a caller passing a fresh
  // object literal must not rebuild (and re-virtualize) the whole grid on
  // every selection change.
  const { startMs: dayStartMs, endMs: dayEndMs } = dayBounds;
  const slots = useMemo(
    () =>
      buildFiveMinuteSlots(
        { startMs: dayStartMs, endMs: dayEndMs },
        frames,
        activities,
      ),
    [activities, dayEndMs, dayStartMs, frames],
  );

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
  const visualGroups = useMemo(
    () =>
      splitLongEmptyGroups(
        groupFiveMinuteSlots(slots, currentActivityId),
        columns,
      ),
    [columns, currentActivityId, slots],
  );
  const virtualizer = useVirtualizer({
    count: visualGroups.length,
    getScrollElement: () => scrollElement,
    estimateSize: (index) =>
      groupHeight(visualGroups[index], columns) + CELL_GAP_PX,
    overscan: 4,
    enabled: gridWidth > 0,
  });

  const timelineMarks = useMemo(() => buildTimelineMarks(slots), [slots]);
  const timelineEpochAtOrBefore = useCallback(
    (epochMs: number): number | null => {
      let activeEpochMs = timelineMarks[0]?.epochMs ?? null;
      for (const mark of timelineMarks) {
        if (mark.epochMs > epochMs) break;
        activeEpochMs = mark.epochMs;
      }
      return activeEpochMs;
    },
    [timelineMarks],
  );
  const initialTimelineEpochMs = timelineEpochAtOrBefore(
    initialFocusMs ?? initialStartMs ?? slots[0]?.startMs ?? dayBounds.startMs,
  );
  const [activeTimelineEpochMs, setActiveTimelineEpochMs] = useState<
    number | null
  >(initialTimelineEpochMs);
  const timelineNavRef = useRef<HTMLElement | null>(null);
  const timelineButtonRefs = useRef(new Map<number, HTMLButtonElement>());

  const scrollOffsetForSlot = useCallback(
    (slotStartMs: number): number | null => {
      let groupTop = 0;
      for (const group of visualGroups) {
        const slotIndex = group.slots.findIndex(
          (slot) => slot.startMs === slotStartMs,
        );
        if (slotIndex !== -1) {
          const groupColumns = groupColumnCount(group, columns);
          return (
            groupTop +
            GROUP_HEADER_HEIGHT_PX +
            Math.floor(slotIndex / groupColumns) * SLOT_CARD_HEIGHT_PX
          );
        }
        groupTop += groupHeight(group, columns) + CELL_GAP_PX;
      }
      return null;
    },
    [columns, visualGroups],
  );

  const syncTimelineToScroll = (scrollTop: number) => {
    let groupTop = 0;
    const anchorTop = scrollTop + 1;
    for (const group of visualGroups) {
      const nextGroupTop = groupTop + groupHeight(group, columns) + CELL_GAP_PX;
      if (anchorTop < nextGroupTop) {
        const groupColumns = groupColumnCount(group, columns);
        const rowCount = Math.ceil(group.slots.length / groupColumns);
        const rowIndex = Math.min(
          rowCount - 1,
          Math.max(
            0,
            Math.floor(
              (anchorTop - groupTop - GROUP_HEADER_HEIGHT_PX) /
                SLOT_CARD_HEIGHT_PX,
            ),
          ),
        );
        const visibleSlot =
          group.slots[
            Math.min(
              rowIndex * groupColumns + Math.floor(groupColumns / 2),
              group.slots.length - 1,
            )
          ];
        setActiveTimelineEpochMs(timelineEpochAtOrBefore(visibleSlot.startMs));
        return;
      }
      groupTop = nextGroupTop;
    }
  };

  const initialScrollDoneRef = useRef(false);
  useEffect(() => {
    if (
      initialScrollDoneRef.current ||
      gridWidth === 0 ||
      scrollElement === null
    ) {
      return;
    }
    initialScrollDoneRef.current = true;
    const focusMs = initialFocusMs ?? initialStartMs;
    if (focusMs === undefined) return;
    const focusSlot = slots.find(
      (slot) => focusMs >= slot.startMs && focusMs < slot.endMs,
    );
    if (focusSlot === undefined) return;
    const focusOffset = scrollOffsetForSlot(focusSlot.startMs);
    if (focusOffset === null) return;
    virtualizer.scrollToOffset(
      Math.max(
        0,
        focusOffset - (scrollElement.clientHeight - SLOT_CARD_HEIGHT_PX) / 2,
      ),
    );
    setActiveTimelineEpochMs(timelineEpochAtOrBefore(focusSlot.startMs));
  }, [
    gridWidth,
    initialFocusMs,
    initialStartMs,
    scrollElement,
    scrollOffsetForSlot,
    slots,
    timelineEpochAtOrBefore,
    virtualizer,
  ]);

  useEffect(() => {
    if (activeTimelineEpochMs === null) return;
    const nav = timelineNavRef.current;
    const button = timelineButtonRefs.current.get(activeTimelineEpochMs);
    if (nav === null || button === undefined) return;
    const padding = 8;
    const buttonTop = button.offsetTop;
    const buttonBottom = buttonTop + button.offsetHeight;
    if (buttonTop < nav.scrollTop + padding) {
      nav.scrollTo({ top: Math.max(0, buttonTop - padding) });
    } else if (buttonBottom > nav.scrollTop + nav.clientHeight - padding) {
      nav.scrollTo({
        top: buttonBottom - nav.clientHeight + padding,
      });
    }
  }, [activeTimelineEpochMs]);

  const scrollToSlotIndex = (slotIndex: number) => {
    const targetStartMs = slots[slotIndex]?.startMs;
    if (targetStartMs === undefined) return;
    const targetOffset = scrollOffsetForSlot(targetStartMs);
    if (targetOffset === null) return;
    virtualizer.scrollToOffset(targetOffset);
    setActiveTimelineEpochMs(timelineEpochAtOrBefore(targetStartMs));
  };

  const selectSlot = (slot: FiveMinuteSlot) => {
    if (clickAnchorMs === null) {
      setClickAnchorMs(slot.startMs);
      setStartMs(slot.startMs);
      setEndMs(slot.endMs);
      return;
    }
    setClickAnchorMs(null);
    setStartMs(Math.min(clickAnchorMs, slot.startMs));
    setEndMs(Math.max(clickAnchorMs, slot.startMs) + FIVE_MINUTE_MS);
  };

  const setStartBoundary = (value: string) => {
    setClickAnchorMs(null);
    const nextStartMs = Number(value);
    setStartMs(nextStartMs);
    if (endMs === null || endMs <= nextStartMs) {
      setEndMs(Math.min(nextStartMs + FIVE_MINUTE_MS, dayBounds.endMs));
    }
  };
  const setEndBoundary = (value: string) => {
    setClickAnchorMs(null);
    const nextEndMs = Number(value);
    setEndMs(nextEndMs);
    if (startMs === null || startMs >= nextEndMs) {
      setStartMs(Math.max(dayBounds.startMs, nextEndMs - FIVE_MINUTE_MS));
    }
  };

  const hasSelection = startMs !== null || endMs !== null;
  const canConfirm =
    startMs !== null &&
    endMs !== null &&
    startMs >= dayBounds.startMs &&
    endMs <= dayBounds.endMs &&
    startMs < endMs;
  const selectionInstruction =
    clickAnchorMs === null
      ? "Choose a five-minute slot, or set Start and End directly."
      : "Choose another slot to extend the range, or apply this five-minute span.";
  // "24:00" reads better than "00:00" for an exclusive end on local midnight.
  // A day whose recording ran past midnight ends at a real wall-clock time
  // instead, which is already unambiguous.
  const boundaryLabel = (epochMs: number): string =>
    epochMs === dayBounds.endMs && formatTimeOfDay(epochMs) === "00:00"
      ? "24:00"
      : formatTimeOfDay(epochMs);

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

        <div className="flex min-h-16 flex-wrap items-center justify-between gap-3 border-b border-border/70 bg-muted/20 px-5 py-3 sm:px-7">
          <Column gap="xs">
            <p className="text-sm font-medium">Select the time span</p>
            <p className="text-xs text-muted-foreground">
              {selectionInstruction}
            </p>
          </Column>

          <Row gap="xs" align="center" wrap>
            <label
              className={mergeClassNames(
                "inline-flex min-h-10 items-center gap-1.5 rounded-lg border bg-background px-2.5 py-1 text-xs",
                startMs !== null &&
                  "border-blue-200 bg-blue-50 text-blue-700 dark:border-blue-800 dark:bg-blue-950/50 dark:text-blue-300",
              )}
            >
              <span className="text-muted-foreground">Start</span>
              <select
                aria-label="Activity start time"
                value={startMs ?? ""}
                onChange={(event) => setStartBoundary(event.target.value)}
                className="min-w-16 bg-transparent font-medium tabular-nums outline-none"
              >
                <option value="" disabled>
                  —
                </option>
                {slots.map((slot) => (
                  <option key={slot.startMs} value={slot.startMs}>
                    {boundaryLabel(slot.startMs)}
                  </option>
                ))}
              </select>
            </label>
            <ArrowRightIcon
              className="size-3.5 text-muted-foreground"
              aria-hidden
            />
            <label
              className={mergeClassNames(
                "inline-flex min-h-10 items-center gap-1.5 rounded-lg border bg-background px-2.5 py-1 text-xs",
                endMs !== null &&
                  "border-blue-200 bg-blue-50 text-blue-700 dark:border-blue-800 dark:bg-blue-950/50 dark:text-blue-300",
              )}
            >
              <span className="text-muted-foreground">End</span>
              <select
                aria-label="Activity end time"
                value={endMs ?? ""}
                onChange={(event) => setEndBoundary(event.target.value)}
                className="min-w-16 bg-transparent font-medium tabular-nums outline-none"
              >
                <option value="" disabled>
                  —
                </option>
                {slots.map((slot) => (
                  <option key={slot.endMs} value={slot.endMs}>
                    {boundaryLabel(slot.endMs)}
                  </option>
                ))}
              </select>
            </label>
          </Row>
        </div>

        <div className="bg-muted/15 p-3 sm:p-5">
          <Row gap="md" align="start">
            <nav
              ref={timelineNavRef}
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
                    ref={(button) => {
                      if (button === null) {
                        timelineButtonRefs.current.delete(mark.epochMs);
                      } else {
                        timelineButtonRefs.current.set(mark.epochMs, button);
                      }
                    }}
                    type="button"
                    onClick={() => scrollToSlotIndex(mark.slotIndex)}
                    aria-current={
                      activeTimelineEpochMs === mark.epochMs
                        ? "time"
                        : undefined
                    }
                    className={mergeClassNames(
                      "w-full rounded-lg px-2 py-1 text-left text-xs tabular-nums transition-colors outline-none ring-inset hover:bg-muted focus-visible:ring-2 focus-visible:ring-blue-400",
                      activeTimelineEpochMs === mark.epochMs
                        ? "bg-blue-50 font-semibold text-blue-700 shadow-sm ring-1 ring-blue-300 dark:bg-blue-950/55 dark:text-blue-200 dark:ring-blue-700"
                        : mark.isFullHour
                          ? "font-medium text-foreground"
                          : "text-muted-foreground",
                    )}
                  >
                    {mark.label}
                  </button>
                ))}
              </Column>
            </nav>

            <div
              ref={setScrollElement}
              onScroll={(event) =>
                syncTimelineToScroll(event.currentTarget.scrollTop)
              }
              className="max-h-[62vh] min-w-0 flex-1 overflow-y-auto pr-1"
            >
              <div
                className="relative"
                style={{ height: virtualizer.getTotalSize() }}
              >
                {virtualizer.getVirtualItems().map((virtualRow) => (
                  <div
                    key={virtualRow.key}
                    className="absolute top-0 left-0 flex w-full"
                    style={{
                      height: groupHeight(
                        visualGroups[virtualRow.index],
                        columns,
                      ),
                      transform: `translateY(${virtualRow.start}px)`,
                    }}
                  >
                    {[visualGroups[virtualRow.index]].map((group) => {
                      const firstSlot = group.slots[0];
                      const lastSlot = group.slots[group.slots.length - 1];
                      const groupColumns = groupColumnCount(group, columns);
                      const groupStartMs =
                        group.owner?.startMs ?? firstSlot.startMs;
                      const groupEndMs = group.owner?.endMs ?? lastSlot.endMs;
                      return (
                        <section
                          key={`${group.key}-${firstSlot.startMs}`}
                          aria-label={`${groupLabel(group)}, ${formatTimeSpan(
                            groupStartMs,
                            groupEndMs,
                          )}`}
                          className={mergeClassNames(
                            "flex min-w-0 flex-col overflow-hidden rounded-xl",
                            groupContainerClasses(group.kind),
                          )}
                          style={{
                            width: `${(groupColumns / columns) * 100}%`,
                          }}
                        >
                          <div
                            className={mergeClassNames(
                              "flex min-h-7 items-center justify-between gap-2 border-b px-2 py-1 text-[10px] font-medium",
                              groupHeaderClasses(group.kind),
                            )}
                          >
                            <span className="truncate">
                              {groupLabel(group)}
                            </span>
                            <span className="shrink-0 tabular-nums">
                              {formatTimeSpan(groupStartMs, groupEndMs)}
                            </span>
                          </div>

                          <div
                            className="grid min-h-0 flex-1"
                            style={{
                              gridTemplateColumns: `repeat(${groupColumns}, minmax(0, 1fr))`,
                              gridTemplateRows: `repeat(${Math.ceil(
                                group.slots.length / groupColumns,
                              )}, minmax(0, 1fr))`,
                            }}
                          >
                            {group.slots.map((slot, slotIndex) => {
                              const slotColumn = slotIndex % groupColumns;
                              const slotRow = Math.floor(
                                slotIndex / groupColumns,
                              );
                              const isSelected =
                                startMs !== null &&
                                endMs !== null &&
                                slotOverlapsSpan(slot, startMs, endMs);
                              const slotIsSelected = (
                                index: number,
                              ): boolean => {
                                const candidate = group.slots[index];
                                return (
                                  candidate !== undefined &&
                                  startMs !== null &&
                                  endMs !== null &&
                                  slotOverlapsSpan(candidate, startMs, endMs)
                                );
                              };
                              const selectedAbove =
                                isSelected &&
                                slotIsSelected(slotIndex - groupColumns);
                              const selectedBelow =
                                isSelected &&
                                slotIsSelected(slotIndex + groupColumns);
                              const selectedLeft =
                                isSelected &&
                                slotColumn > 0 &&
                                slotIsSelected(slotIndex - 1);
                              const selectedRight =
                                isSelected &&
                                slotColumn < groupColumns - 1 &&
                                slotIsSelected(slotIndex + 1);
                              const assignmentLabel = slotAssignmentLabel(
                                slot,
                                currentActivityId,
                              );
                              const isStart = slot.startMs === startMs;
                              const isEnd = slot.endMs === endMs;
                              const previews = sampleEvenly(
                                slot.frames,
                                MAX_SLOT_PREVIEWS,
                              );
                              const timeSpan = formatTimeSpan(
                                slot.startMs,
                                slot.endMs,
                              );
                              const ownerDetail =
                                slot.owner?.startMs !== null &&
                                slot.owner?.startMs !== undefined &&
                                slot.owner.endMs !== null
                                  ? `${
                                      activityDisplayLabel(
                                        slot.owner.rawLabel,
                                      ) ?? "Unlabelled activity"
                                    }, ${formatTimeSpan(
                                      slot.owner.startMs,
                                      slot.owner.endMs,
                                    )}`
                                  : assignmentLabel;
                              const imageSummary =
                                slot.frames.length === 0
                                  ? "No images available"
                                  : `${slot.frames.length} ${
                                      slot.frames.length === 1
                                        ? "image"
                                        : "images"
                                    }`;
                              return (
                                <button
                                  key={slot.startMs}
                                  type="button"
                                  title={`${timeSpan} · ${ownerDetail}`}
                                  aria-label={`${timeSpan}. ${assignmentLabel}. ${
                                    slot.owner === null
                                      ? ""
                                      : `Activity: ${ownerDetail}. `
                                  }${imageSummary}. Select this five-minute interval.`}
                                  aria-pressed={isSelected}
                                  onClick={() => selectSlot(slot)}
                                  className={mergeClassNames(
                                    "relative flex min-w-0 flex-col overflow-hidden text-left transition-colors outline-none hover:bg-foreground/[0.025] focus-visible:z-10 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset",
                                    isSelected &&
                                      "z-[1] bg-blue-50/65 dark:bg-blue-950/35",
                                    slotColumn > 0 && "border-l",
                                    slotRow > 0 && "border-t",
                                    (slotColumn > 0 || slotRow > 0) &&
                                      (isSelected
                                        ? "border-blue-200/90 dark:border-blue-800"
                                        : groupDividerClasses(group.kind)),
                                  )}
                                >
                                  <div
                                    className={mergeClassNames(
                                      "flex min-h-9 items-center border-b px-2 py-1.5",
                                      groupDividerClasses(group.kind),
                                    )}
                                  >
                                    <span className="text-xs font-semibold tabular-nums">
                                      {timeSpan}
                                    </span>
                                  </div>

                                  {previews.length === 0 ? (
                                    <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-1.5 text-muted-foreground">
                                      <ImageOffIcon
                                        className="size-5"
                                        aria-hidden
                                      />
                                      <span className="text-[11px] font-medium">
                                        No images available
                                      </span>
                                    </div>
                                  ) : (
                                    <div
                                      className={mergeClassNames(
                                        "grid min-h-0 flex-1 gap-0.5 bg-muted",
                                        previews.length === 1
                                          ? "grid-cols-1"
                                          : "grid-cols-2",
                                      )}
                                    >
                                      {previews.map((frame) => (
                                        /* eslint-disable-next-line @next/next/no-img-element -- authenticated image; the Next proxy cannot forward the auth cookie */
                                        <img
                                          key={frameIdentityKey(frame)}
                                          src={frameImageSrc(frame.imageUrl!)}
                                          alt=""
                                          loading="lazy"
                                          decoding="async"
                                          fetchPriority="low"
                                          className="size-full min-h-0 object-cover"
                                        />
                                      ))}
                                    </div>
                                  )}

                                  {isSelected && (
                                    <span
                                      aria-hidden
                                      className={mergeClassNames(
                                        "pointer-events-none absolute inset-0 z-20 border-blue-600 bg-blue-500/12 dark:border-blue-400 dark:bg-blue-400/15",
                                        !selectedAbove && "border-t-[3px]",
                                        !selectedRight && "border-r-[3px]",
                                        !selectedBelow && "border-b-[3px]",
                                        !selectedLeft && "border-l-[3px]",
                                      )}
                                    />
                                  )}

                                  {slot.frames.length > MAX_SLOT_PREVIEWS && (
                                    <span className="pointer-events-none absolute bottom-2 left-2 z-30 rounded-md border border-white/15 bg-black/70 px-2 py-1 text-[9px] font-medium text-white">
                                      +{slot.frames.length - MAX_SLOT_PREVIEWS}{" "}
                                      images
                                    </span>
                                  )}

                                  {(isStart || isEnd) && (
                                    <span
                                      className={mergeClassNames(
                                        "pointer-events-none absolute z-30 inline-flex min-h-7 items-center rounded-lg bg-blue-600 px-3 py-1.5 text-[11px] font-bold tracking-wider text-white uppercase shadow-lg ring-2 ring-white/90 dark:bg-blue-500 dark:ring-blue-950",
                                        isStart && !isEnd
                                          ? "top-12 left-2"
                                          : "right-2 bottom-2",
                                      )}
                                    >
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
                        </section>
                      );
                    })}
                  </div>
                ))}
              </div>
            </div>
          </Row>
        </div>

        <div className="flex flex-col gap-3 border-t border-border/70 bg-background px-5 py-4 sm:flex-row sm:items-center sm:justify-between sm:px-7">
          <Button
            variant="ghost"
            className="self-start"
            onClick={() => {
              setClickAnchorMs(null);
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
