import type {
  Activity,
  ActivityLabel,
  ActivityInput,
  ActivitySource,
  CategoryLabel,
  ExperienceRating,
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
  // Original VLM proposal (null for user-added rows); carried through every
  // edit and echoed back on save so provenance survives span changes.
  vlmRawLabel: ActivityLabel | null;
  vlmCategory: CategoryLabel | null;
  // Experience ratings (7-point Likert). Both are kept independently so an
  // answer survives the participant flipping the category back and forth;
  // only the one matching the final category is required to submit.
  workloadRating: ExperienceRating | null;
  recoveryRating: ExperienceRating | null;
}

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
  vlmRawLabel: isActivityLabel(activity.vlmRawLabel)
    ? activity.vlmRawLabel
    : null,
  vlmCategory:
    activity.vlmCategory === "work" ||
    activity.vlmCategory === "break" ||
    activity.vlmCategory === "other"
      ? activity.vlmCategory
      : null,
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
      vlmRawLabel: row.vlmRawLabel,
      vlmCategory: row.vlmCategory,
      workloadRating: row.workloadRating,
      recoveryRating: row.recoveryRating,
    }));

/**
 * Apply a new time span to the row `localId` and resolve every overlap it
 * creates. The frame picker offers the whole day, so the new span may reach
 * far beyond the immediate neighbors: rows fully inside it are removed; a row
 * overlapped from the left keeps its head (its end clamps to just before the
 * new start); one overlapped from the right keeps its tail (its start clamps
 * to just after the new end). A row that surrounds the whole new span keeps
 * its head. Rows without complete times are kept as-is.
 */
export const resolveSpanOverlaps = (
  rows: EditableActivity[],
  localId: string,
  newStartMs: number,
  newEndMs: number,
): EditableActivity[] => {
  if (!rows.some((row) => row.localId === localId)) return rows;
  const resolved: EditableActivity[] = [];
  for (const row of rows) {
    if (row.localId === localId) {
      resolved.push({ ...row, startMs: newStartMs, endMs: newEndMs });
      continue;
    }
    if (row.startMs === null || row.endMs === null) {
      resolved.push(row);
      continue;
    }
    const isFullyCovered = row.startMs >= newStartMs && row.endMs <= newEndMs;
    if (isFullyCovered) continue;
    const overlapsNewStart =
      row.startMs < newStartMs && row.endMs >= newStartMs;
    if (overlapsNewStart) {
      resolved.push({ ...row, endMs: newStartMs - 1 });
      continue;
    }
    const overlapsNewEnd = row.endMs > newEndMs && row.startMs <= newEndMs;
    if (overlapsNewEnd) {
      resolved.push({ ...row, startMs: newEndMs + 1 });
      continue;
    }
    resolved.push(row);
  }
  return sortActivities(resolved);
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
