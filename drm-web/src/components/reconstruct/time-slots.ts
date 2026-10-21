import type { Frame } from "@/lib/api-types";
import {
  sortActivities,
  type EditableActivity,
} from "@/components/reconstruct/editor-types";
import { windowMs } from "@/lib/study-config-store";

/** Server-authoritative epoch extent of the pinned study day. */
export interface StudyDayBounds {
  startMs: number;
  endMs: number;
}

export interface WindowSlot {
  startMs: number;
  endMs: number;
  frames: Frame[];
  owner: EditableActivity | null;
}

export type WindowSlotGroupKind =
  "current" | "assigned" | "unassigned" | "empty";

export interface WindowSlotGroup {
  key: string;
  kind: WindowSlotGroupKind;
  slots: WindowSlot[];
  owner: EditableActivity | null;
}

export const slotStartOf = (epochMs: number): number =>
  epochMs - (epochMs % windowMs());

export const slotOverlapsSpan = (
  slot: Pick<WindowSlot, "startMs" | "endMs">,
  startMs: number,
  endMs: number,
): boolean => slot.startMs < endMs && slot.endMs > startMs;

/**
 * Merge adjacent visual slots into stable assignment containers. Selection is
 * intentionally not part of this grouping: choosing Start and End must never
 * move a slot or change the virtualized layout under the pointer.
 */
export const groupWindowSlots = (
  slots: WindowSlot[],
  currentActivityId: string | undefined,
): WindowSlotGroup[] => {
  const descriptor = (
    slot: WindowSlot,
  ): Pick<WindowSlotGroup, "key" | "kind" | "owner"> => {
    if (slot.owner !== null) {
      const isCurrent =
        currentActivityId !== undefined &&
        slot.owner.localId === currentActivityId;
      return {
        key: `activity:${slot.owner.localId}`,
        kind: isCurrent ? "current" : "assigned",
        owner: slot.owner,
      };
    }
    if (slot.frames.length > 0) {
      return { key: "unassigned", kind: "unassigned", owner: null };
    }
    return { key: "empty", kind: "empty", owner: null };
  };

  const groups: WindowSlotGroup[] = [];
  for (const slot of slots) {
    const next = descriptor(slot);
    const previous = groups.at(-1);
    if (previous?.key === next.key) {
      previous.slots.push(slot);
      continue;
    }
    groups.push({ ...next, slots: [slot] });
  }
  return groups;
};

/**
 * Build the complete window grid (`windowing.windowMinutes`) for the pinned study day. The bounds
 * come from the server: the day is anchored on the recording session, so a
 * recording that ran past local midnight spans more than its calendar date.
 * Live images are grouped into their clock-aligned slot; a slot with no live
 * image remains in the result so the picker can render "No images available".
 */
export const buildWindowSlots = (
  bounds: StudyDayBounds,
  frames: Frame[],
  activities: EditableActivity[],
): WindowSlot[] => {
  const startMs = slotStartOf(bounds.startMs);
  const { endMs } = bounds;
  const liveFramesBySlot = new Map<number, Frame[]>();
  for (const frame of frames) {
    if (frame.deletedAt !== null || frame.imageUrl === null) continue;
    const slotStartMs = slotStartOf(frame.captureEpochMs);
    if (slotStartMs < startMs || slotStartMs >= endMs) continue;
    const bucket = liveFramesBySlot.get(slotStartMs) ?? [];
    bucket.push(frame);
    liveFramesBySlot.set(slotStartMs, bucket);
  }

  const completeActivities = sortActivities(activities).filter(
    (activity) => activity.startMs !== null && activity.endMs !== null,
  );
  const slotMs = windowMs();
  const slots: WindowSlot[] = [];
  for (let slotStartMs = startMs; slotStartMs < endMs; slotStartMs += slotMs) {
    const slotEndMs = Math.min(slotStartMs + slotMs, endMs);
    const owner =
      completeActivities.find(
        (activity) =>
          (activity.startMs as number) < slotEndMs &&
          (activity.endMs as number) > slotStartMs,
      ) ?? null;
    slots.push({
      startMs: slotStartMs,
      endMs: slotEndMs,
      frames: liveFramesBySlot.get(slotStartMs) ?? [],
      owner,
    });
  }
  return slots;
};
