import type {
  Activity,
  ActivityLabel,
  ActivityInput,
  ActivitySource,
  CategoryLabel,
  ExperienceRating,
  Frame,
} from "@/lib/api-types";
import { isActivityLabel } from "@/lib/activity-vocabulary";

/**
 * Local editing model for one activity row. Self-round rows start with no
 * times (the participant types them from memory); assisted rows always carry
 * the frame times they were derived from.
 */
export interface EditableActivity {
  localId: string;
  startMs: number | null;
  endMs: number | null;
  rawLabel: ActivityLabel | null;
  categoryLabel: CategoryLabel | null;
  source: ActivitySource;
  // Opaque immutable-proposal link (null for user-added rows), carried through
  // edits so the server can preserve hidden provenance without exposing it.
  proposalActivityId: number | null;
  // The server exposes this only in DRM_DEV_MODE for visual verification.
  isIncorrectAnnotationInjected: boolean;
  // Experience ratings (7-point Likert). Both are kept independently so an
  // answer survives the participant flipping the category back and forth;
  // only the one matching the final category is required to submit.
  workloadRating: ExperienceRating | null;
  recoveryRating: ExperienceRating | null;
}

export const FIVE_MINUTE_MS = 5 * 60 * 1000;

let localIdCounter = 0;
export const makeLocalId = (): string => {
  localIdCounter += 1;
  return `activity-${localIdCounter}`;
};

export const fromServerActivity = (activity: Activity): EditableActivity => ({
  localId: makeLocalId(),
  startMs: activity.startMs,
  endMs: activity.endMs,
  rawLabel: isActivityLabel(activity.rawLabel) ? activity.rawLabel : null,
  categoryLabel: activity.categoryLabel,
  source: activity.source,
  proposalActivityId: activity.proposalActivityId,
  isIncorrectAnnotationInjected:
    activity.isIncorrectAnnotationInjected === true,
  workloadRating: activity.workloadRating,
  recoveryRating: activity.recoveryRating,
});

/** Sorted by start time; rows without a start time sink to the end. */
export const sortActivities = (rows: EditableActivity[]): EditableActivity[] =>
  [...rows].sort((first, second) => {
    if (first.startMs === null && second.startMs === null) return 0;
    if (first.startMs === null) return 1;
    if (second.startMs === null) return -1;
    return first.startMs - second.startMs;
  });

/**
 * Serialize rows for PUT/POST. The server assigns `position` from array order,
 * so rows are sorted by start time first. Rows without complete times (self
 * rows still being filled in) are excluded — they only exist locally.
 */
export const toActivityInputs = (rows: EditableActivity[]): ActivityInput[] =>
  sortActivities(rows)
    .filter((row) => row.startMs !== null && row.endMs !== null)
    .map((row) => ({
      startMs: row.startMs as number,
      endMs: row.endMs as number,
      rawLabel: row.rawLabel,
      categoryLabel: row.categoryLabel,
      source: row.source,
      proposalActivityId: row.proposalActivityId,
      workloadRating: row.workloadRating,
      recoveryRating: row.recoveryRating,
    }));

export const isEpochInActivitySpan = (
  epochMs: number,
  activity: Pick<EditableActivity, "startMs" | "endMs">,
): boolean =>
  activity.startMs !== null &&
  activity.endMs !== null &&
  epochMs >= activity.startMs &&
  epochMs < activity.endMs;

export type SpanAdjustmentKind = "shortened" | "deleted" | "split";
export type SpanAdjustmentSide = "preceding" | "following" | "overlapping";

export interface SpanAdjustmentEffect {
  localId: string;
  kind: SpanAdjustmentKind;
  side: SpanAdjustmentSide;
  originalStartMs: number;
  originalEndMs: number;
}

export interface SpanResolution {
  rows: EditableActivity[];
  effects: SpanAdjustmentEffect[];
}

/**
 * Give one activity exclusive ownership of a half-open time span [start, end).
 * Other rows are shortened at exact boundaries, removed when fully covered,
 * or split into head + tail when they surround the claimed span. Split rows
 * deliberately retain their label, rating, source, and immutable-proposal
 * link so the assisted list remains a faithful, queryable edit history.
 */
export const claimActivitySpan = (
  rows: EditableActivity[],
  localId: string,
  newStartMs: number,
  newEndMs: number,
): SpanResolution => {
  if (!rows.some((row) => row.localId === localId)) {
    return { rows, effects: [] };
  }
  const resolved: EditableActivity[] = [];
  const effects: SpanAdjustmentEffect[] = [];
  for (const row of rows) {
    if (row.localId === localId) {
      resolved.push({ ...row, startMs: newStartMs, endMs: newEndMs });
      continue;
    }
    if (row.startMs === null || row.endMs === null) {
      resolved.push(row);
      continue;
    }
    const overlaps = row.startMs < newEndMs && row.endMs > newStartMs;
    if (!overlaps) {
      resolved.push(row);
      continue;
    }
    const side: SpanAdjustmentSide =
      row.startMs < newStartMs
        ? "preceding"
        : row.endMs > newEndMs
          ? "following"
          : "overlapping";
    const effect = (
      kind: SpanAdjustmentKind,
      effectSide: SpanAdjustmentSide = side,
    ) =>
      effects.push({
        localId: row.localId,
        kind,
        side: effectSide,
        originalStartMs: row.startMs as number,
        originalEndMs: row.endMs as number,
      });
    const surroundsClaim = row.startMs < newStartMs && row.endMs > newEndMs;
    if (surroundsClaim) {
      resolved.push({ ...row, endMs: newStartMs });
      resolved.push({
        ...row,
        localId: makeLocalId(),
        startMs: newEndMs,
      });
      effect("split", "overlapping");
      continue;
    }
    const isFullyCovered = row.startMs >= newStartMs && row.endMs <= newEndMs;
    if (isFullyCovered) {
      effect("deleted");
      continue;
    }
    const overlapsNewStart = row.startMs < newStartMs && row.endMs > newStartMs;
    if (overlapsNewStart) {
      resolved.push({ ...row, endMs: newStartMs });
      effect("shortened");
      continue;
    }
    const overlapsNewEnd = row.endMs > newEndMs && row.startMs < newEndMs;
    if (overlapsNewEnd) {
      resolved.push({ ...row, startMs: newEndMs });
      effect("shortened");
      continue;
    }
    resolved.push(row);
  }
  return { rows: sortActivities(resolved), effects };
};

/** Backward-compatible convenience for callers that only need the rows. */
export const resolveSpanOverlaps = (
  rows: EditableActivity[],
  localId: string,
  newStartMs: number,
  newEndMs: number,
): EditableActivity[] =>
  claimActivitySpan(rows, localId, newStartMs, newEndMs).rows;

/**
 * True only when the gap adjacent to one Insert button contains a live image
 * that is not covered by any activity. Image-free time never turns the button
 * red; it remains selectable in the five-minute picker.
 */
export const gapHasUnassignedImages = (
  rows: EditableActivity[],
  frames: Frame[],
  afterLocalId: string | null,
): boolean => {
  const sorted = sortActivities(rows);
  const anchorIndex =
    afterLocalId === null
      ? -1
      : sorted.findIndex((row) => row.localId === afterLocalId);
  if (afterLocalId !== null && anchorIndex === -1) return false;
  const previous = anchorIndex >= 0 ? sorted[anchorIndex] : undefined;
  const next = sorted[anchorIndex + 1];
  const gapStartMs = previous?.endMs ?? Number.NEGATIVE_INFINITY;
  const gapEndMs = next?.startMs ?? Number.POSITIVE_INFINITY;

  return frames.some(
    (frame) =>
      frame.deletedAt === null &&
      frame.imageUrl !== null &&
      frame.captureEpochMs >= gapStartMs &&
      frame.captureEpochMs < gapEndMs &&
      !sorted.some((row) => isEpochInActivitySpan(frame.captureEpochMs, row)),
  );
};

/** Pick up to maxCount items spread evenly across the list (endpoints kept). */
export const sampleEvenly = <T>(items: T[], maxCount: number): T[] => {
  if (items.length <= maxCount) return items;
  const sampled: T[] = [];
  for (let slot = 0; slot < maxCount; slot += 1) {
    const index = Math.round((slot * (items.length - 1)) / (maxCount - 1));
    sampled.push(items[index]);
  }
  return sampled;
};

export interface RowIssue {
  localId: string;
  message: string;
}

/**
 * True once every work/break activity has its experience rating. A missing
 * rating blocks submit like any other issue, but gets no row message — the
 * rating scale itself turns red, which is signal enough.
 */
export const hasAllExperienceRatings = (rows: EditableActivity[]): boolean =>
  rows.every((row) => {
    if (row.categoryLabel === "work") return row.workloadRating !== null;
    if (row.categoryLabel === "break") return row.recoveryRating !== null;
    return true;
  });

/**
 * Validation shared by autosave display and submit. Self rows must have
 * complete, strictly ordered, non-overlapping times; assisted rows get their
 * times from frames so only label/category can be missing. Every row needs a
 * non-empty label and a category before submit; missing experience ratings
 * are checked separately (hasAllExperienceRatings) because they highlight
 * in place instead of adding a message here. The server enforces all of it
 * again on submit.
 */
export const computeRowIssues = (
  rows: EditableActivity[],
  requireStrictOrder: boolean,
): RowIssue[] => {
  const sorted = sortActivities(rows);
  const issues: RowIssue[] = [];
  sorted.forEach((row, index) => {
    const messages: string[] = [];
    if (row.startMs === null || row.endMs === null) {
      messages.push("Set a start and end time.");
    } else {
      if (requireStrictOrder && row.endMs <= row.startMs) {
        messages.push("The end time must be after the start time.");
      }
      if (!requireStrictOrder && row.endMs < row.startMs) {
        messages.push("The end time must not be before the start time.");
      }
      const previous = index > 0 ? sorted[index - 1] : null;
      if (
        previous !== null &&
        previous.endMs !== null &&
        row.startMs < previous.endMs
      ) {
        messages.push("This activity overlaps the previous one.");
      }
    }
    if (row.rawLabel === null) {
      messages.push("Choose an activity.");
    }
    if (row.categoryLabel === null) {
      messages.push("Choose a category.");
    }
    if (messages.length > 0) {
      issues.push({ localId: row.localId, message: messages.join(" ") });
    }
  });
  return issues;
};
