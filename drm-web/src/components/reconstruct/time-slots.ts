import type { Frame } from "@/lib/api-types";
import {
  FIVE_MINUTE_MS,
  sortActivities,
  type EditableActivity,
} from "@/components/reconstruct/editor-types";

/** Server-authoritative epoch extent of the pinned study day. */
export interface StudyDayBounds {
  startMs: number;
  endMs: number;
}

export interface FiveMinuteSlot {
  startMs: number;
  endMs: number;
  frames: Frame[];
  owner: EditableActivity | null;
}

export type FiveMinuteSlotGroupKind =
  "current" | "assigned" | "unassigned" | "empty";

export interface FiveMinuteSlotGroup {
  key: string;
  kind: FiveMinuteSlotGroupKind;
  slots: FiveMinuteSlot[];
  owner: EditableActivity | null;
}

export const slotStartOf = (epochMs: number): number =>
  epochMs - (epochMs % FIVE_MINUTE_MS);

export const slotOverlapsSpan = (
  slot: Pick<FiveMinuteSlot, "startMs" | "endMs">,
  startMs: number,
  endMs: number,
): boolean => slot.startMs < endMs && slot.endMs > startMs;

/**
 * Merge adjacent visual slots into stable assignment containers. Selection is
 * intentionally not part of this grouping: choosing Start and End must never
 * move a slot or change the virtualized layout under the pointer.
 */
export const groupFiveMinuteSlots = (
  slots: FiveMinuteSlot[],
  currentActivityId: string | undefined,
): FiveMinuteSlotGroup[] => {
  const descriptor = (
    slot: FiveMinuteSlot,
  ): Pick<FiveMinuteSlotGroup, "key" | "kind" | "owner"> => {
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

  const groups: FiveMinuteSlotGroup[] = [];
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
 * Build the complete five-minute grid for the pinned study day. The bounds
 * come from the server: the day is anchored on the recording session, so a
 * recording that ran past local midnight spans more than its calendar date.
 * Live images are grouped into their clock-aligned slot; a slot with no live
 * image remains in the result so the picker can render "No images available".
 */
export const buildFiveMinuteSlots = (
  bounds: StudyDayBounds,
  frames: Frame[],
  activities: EditableActivity[],
): FiveMinuteSlot[] => {
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
  const slots: FiveMinuteSlot[] = [];
  for (
    let slotStartMs = startMs;
    slotStartMs < endMs;
    slotStartMs += FIVE_MINUTE_MS
  ) {
    const slotEndMs = Math.min(slotStartMs + FIVE_MINUTE_MS, endMs);
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
