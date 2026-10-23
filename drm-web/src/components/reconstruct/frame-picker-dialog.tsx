"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import {
  ArrowRightIcon,
  Clock3Icon,
  ImageOffIcon,
  RotateCcwIcon,
} from "lucide-react";

import { SectionBar } from "@/components/layout/section-bar";
import type { Frame } from "@/lib/api-types";
import { frameImageSrc } from "@/lib/api-client";
import { activityDisplayLabel } from "@/lib/activity-vocabulary";
import { windowMinuteAdjective, windowMs } from "@/lib/study-config-store";
import { formatTimeOfDay, formatTimeSpan } from "@/lib/time";
import { IconTile } from "@/components/layout/icon-tile";
import { Badge } from "@/components/ui/badge";
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
import { Column, Row } from "@/components/layout/flex";
import { Grid } from "@/components/layout/grid";
import { Text } from "@/components/layout/text";
import {
  sampleEvenly,
  type EditableActivity,
} from "@/components/reconstruct/editor-types";
import {
  buildWindowSlots,
  type StudyDayBounds,
  groupWindowSlots,
  slotOverlapsSpan,
  slotStartOf,
  type WindowSlot,
  type WindowSlotGroup,
  type WindowSlotGroupKind,
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
  return floor === epochMs ? epochMs : floor + windowMs();
};

const buildTimelineMarks = (slots: WindowSlot[]): TimelineMark[] =>
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
  slot: WindowSlot,
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

const groupContainerClasses = (kind: WindowSlotGroupKind): string => {
  if (kind === "current") {
    return "border border-teal-200/80 bg-teal-50/30";
  }
  if (kind === "assigned") {
    return "border border-violet-200/80 bg-violet-50/30";
  }
  if (kind === "unassigned") {
    return "border border-dashed border-destructive/45 bg-destructive/[0.025]";
  }
  return "border border-border/60 bg-background";
};

const groupHeaderClasses = (kind: WindowSlotGroupKind): string => {
  if (kind === "current") {
    return "border-teal-200/70 bg-teal-100/45 text-teal-800";
  }
  if (kind === "assigned") {
    return "border-violet-200/70 bg-violet-100/45 text-violet-800";
  }
  if (kind === "unassigned") {
    return "border-destructive/25 bg-destructive/5 text-destructive";
  }
  return "border-border/50 bg-muted/20 text-muted-foreground";
};

const groupDividerClasses = (kind: WindowSlotGroupKind): string => {
  if (kind === "current") return "border-teal-200/70";
  if (kind === "assigned") {
    return "border-violet-200/70";
  }
  if (kind === "unassigned") return "border-destructive/20";
  return "border-border/50";
};

const groupLabel = (group: WindowSlotGroup): string => {
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

const groupColumnCount = (group: WindowSlotGroup, columns: number): number =>
  Math.min(columns, group.slots.length);

const groupHeight = (group: WindowSlotGroup, columns: number): number =>
  GROUP_HEADER_HEIGHT_PX +
  Math.ceil(group.slots.length / columns) * SLOT_CARD_HEIGHT_PX;

/** Keep semantic groups whole; only long neutral gaps are row-sized. */
const splitLongEmptyGroups = (
  groups: WindowSlotGroup[],
  columns: number,
): WindowSlotGroup[] =>
  groups.flatMap((group) => {
    if (group.kind !== "empty" || group.slots.length <= columns) return [group];
    const segments: WindowSlotGroup[] = [];
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
 * Window time picker (`windowing.windowMinutes`) shared by assisted insertion and boundary editing.
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
      buildWindowSlots(
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
      splitLongEmptyGroups(groupWindowSlots(slots, currentActivityId), columns),
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

  const selectSlot = (slot: WindowSlot) => {
    if (clickAnchorMs === null) {
      setClickAnchorMs(slot.startMs);
      setStartMs(slot.startMs);
      setEndMs(slot.endMs);
      return;
    }
    setClickAnchorMs(null);
    setStartMs(Math.min(clickAnchorMs, slot.startMs));
    setEndMs(Math.max(clickAnchorMs, slot.startMs) + windowMs());
  };

  const setStartBoundary = (value: string) => {
    setClickAnchorMs(null);
    const nextStartMs = Number(value);
    setStartMs(nextStartMs);
    if (endMs === null || endMs <= nextStartMs) {
      setEndMs(Math.min(nextStartMs + windowMs(), dayBounds.endMs));
    }
  };
  const setEndBoundary = (value: string) => {
    setClickAnchorMs(null);
    const nextEndMs = Number(value);
    setEndMs(nextEndMs);
    if (startMs === null || startMs >= nextEndMs) {
      setStartMs(Math.max(dayBounds.startMs, nextEndMs - windowMs()));
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
      ? `Choose a ${windowMinuteAdjective()} slot, or set Start and End directly.`
      : `Choose another slot to extend the range, or apply this ${windowMinuteAdjective()} span.`;
  // "24:00" reads better than "00:00" for an exclusive end on local midnight.
  // A day whose recording ran past midnight ends at a real wall-clock time
  // instead, which is already unambiguous.
  const boundaryLabel = (epochMs: number): string =>
    epochMs === dayBounds.endMs && formatTimeOfDay(epochMs) === "00:00"
      ? "24:00"
      : formatTimeOfDay(epochMs);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent variant="panel" closePosition="inset">
        <DialogHeader variant="bar-spacious">
          <Row gap="md" align="start">
            <IconTile>
              <Clock3Icon aria-hidden />
            </IconTile>
            <Column gap="xs" className="min-w-0">
              <DialogTitle size="xl">{title}</DialogTitle>
              <DialogDescription className="leading-relaxed">
                {description}
              </DialogDescription>
            </Column>
          </Row>
        </DialogHeader>

        <SectionBar
          tone="muted"
          inset="dialog"
          layout="toolbar"
          className="min-h-16"
        >
          <Column gap="xs">
            <Text variant="label">Select the time span</Text>
            <Text variant="caption">{selectionInstruction}</Text>
          </Column>

          <Row gap="xs" align="center" wrap>
            <label
              className={mergeClassNames(
                "inline-flex min-h-10 items-center gap-1.5 rounded-lg border bg-background px-2.5 py-1 text-xs",
                startMs !== null && "border-blue-200 bg-blue-50 text-blue-700",
              )}
            >
              <Text as="span" variant="inherit" tone="muted">
                Start
              </Text>
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
                endMs !== null && "border-blue-200 bg-blue-50 text-blue-700",
              )}
            >
              <Text as="span" variant="inherit" tone="muted">
                End
              </Text>
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
        </SectionBar>

        <DialogBody variant="media">
          <Row gap="md" align="start">
            <nav
              ref={timelineNavRef}
              aria-label="Jump to time of day"
              className="hidden max-h-[62vh] w-20 shrink-0 overflow-y-auto rounded-xl border bg-background p-2 sm:block"
            >
              <Text
                variant="overline"
                weight="medium"
                className="px-1 pb-2 text-3xs tracking-wide"
              >
                Jump to
              </Text>
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
                        ? "bg-blue-50 font-semibold text-blue-700 shadow-sm ring-1 ring-blue-300"
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
                  <Row
                    key={virtualRow.key}
                    className="absolute top-0 left-0 w-full"
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
                          <Row
                            gap="sm"
                            align="center"
                            justify="between"
                            className={mergeClassNames(
                              "min-h-7 border-b px-2 py-1 text-3xs font-medium",
                              groupHeaderClasses(group.kind),
                            )}
                          >
                            <Text as="span" variant="inherit" truncate>
                              {groupLabel(group)}
                            </Text>
                            <Text
                              as="span"
                              variant="inherit"
                              className="shrink-0 tabular-nums"
                            >
                              {formatTimeSpan(groupStartMs, groupEndMs)}
                            </Text>
                          </Row>

                          <Grid
                            className="min-h-0 flex-1"
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
                                  }${imageSummary}. Select this ${windowMinuteAdjective()} interval.`}
                                  aria-pressed={isSelected}
                                  onClick={() => selectSlot(slot)}
                                  className={mergeClassNames(
                                    "relative flex min-w-0 flex-col overflow-hidden text-left transition-colors outline-none hover:bg-foreground/[0.025] focus-visible:z-10 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset",
                                    isSelected && "z-[1] bg-blue-50/65",
                                    slotColumn > 0 && "border-l",
                                    slotRow > 0 && "border-t",
                                    (slotColumn > 0 || slotRow > 0) &&
                                      (isSelected
                                        ? "border-blue-200/90"
                                        : groupDividerClasses(group.kind)),
                                  )}
                                >
                                  <Row
                                    align="center"
                                    className={mergeClassNames(
                                      "min-h-9 border-b px-2 py-1.5",
                                      groupDividerClasses(group.kind),
                                    )}
                                  >
                                    <Text
                                      as="span"
                                      variant="small"
                                      weight="semibold"
                                      className="tabular-nums"
                                    >
                                      {timeSpan}
                                    </Text>
                                  </Row>

                                  {previews.length === 0 ? (
                                    <Column
                                      align="center"
                                      justify="center"
                                      className="min-h-0 flex-1 gap-1.5 text-muted-foreground"
                                    >
                                      <ImageOffIcon
                                        className="size-5"
                                        aria-hidden
                                      />
                                      <Text
                                        as="span"
                                        variant="small"
                                        className="text-2xs"
                                      >
                                        No images available
                                      </Text>
                                    </Column>
                                  ) : (
                                    <Grid
                                      gap="2xs"
                                      cols={previews.length === 1 ? 1 : 2}
                                      className="min-h-0 flex-1 bg-muted"
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
                                    </Grid>
                                  )}

                                  {isSelected && (
                                    <span
                                      aria-hidden
                                      className={mergeClassNames(
                                        "pointer-events-none absolute inset-0 z-20 border-blue-600 bg-blue-500/12",
                                        !selectedAbove && "border-t-[3px]",
                                        !selectedRight && "border-r-[3px]",
                                        !selectedBelow && "border-b-[3px]",
                                        !selectedLeft && "border-l-[3px]",
                                      )}
                                    />
                                  )}

                                  {slot.frames.length > MAX_SLOT_PREVIEWS && (
                                    <Badge
                                      variant="pill"
                                      className="pointer-events-none absolute bottom-2 left-2 z-30 rounded-md border border-white/15 bg-black/70 px-2 py-1 text-4xs text-white"
                                    >
                                      +{slot.frames.length - MAX_SLOT_PREVIEWS}{" "}
                                      images
                                    </Badge>
                                  )}

                                  {(isStart || isEnd) && (
                                    <Badge
                                      variant="pill"
                                      className={mergeClassNames(
                                        "pointer-events-none absolute z-30 min-h-7 rounded-lg bg-blue-600 px-3 py-1.5 text-2xs font-bold tracking-wider text-white uppercase shadow-lg ring-2 ring-white/90",
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
                                    </Badge>
                                  )}
                                </button>
                              );
                            })}
                          </Grid>
                        </section>
                      );
                    })}
                  </Row>
                ))}
              </div>
            </div>
          </Row>
        </DialogBody>

        <DialogFooter variant="split" className="flex-col gap-3">
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
          <Column gap="sm" className="flex-col-reverse sm:flex-row">
            <Button variant="outline" onClick={() => onOpenChange(false)}>
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
          </Column>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};
