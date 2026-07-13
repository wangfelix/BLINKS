import type {
  Activity,
  ActivityInput,
  ActivitySource,
  CategoryLabel,
} from "@/lib/api-types";

/**
 * Local editing model for one activity row. Self-round rows start with no
 * times (the participant types them from memory); assisted rows always carry
 * the frame times they were derived from.
 */
export interface EditableActivity {
  localId: string;
  startMs: number | null;
  endMs: number | null;
  rawLabel: string;
  categoryLabel: CategoryLabel | null;
  source: ActivitySource;
  // Original VLM proposal (null for user-added rows); carried through every
  // edit and echoed back on save so provenance survives span changes.
  vlmRawLabel: string | null;
  vlmCategory: CategoryLabel | null;
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
  rawLabel: activity.rawLabel ?? "",
  categoryLabel: activity.categoryLabel,
  source: activity.source,
  vlmRawLabel: activity.vlmRawLabel,
  vlmCategory:
    activity.vlmCategory === "work" ||
    activity.vlmCategory === "break" ||
    activity.vlmCategory === "other"
      ? activity.vlmCategory
      : null,
});

/** Sorted by start time; rows without a start time sink to the end. */
export const sortActivities = (
  rows: EditableActivity[],
): EditableActivity[] =>
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
      rawLabel: row.rawLabel.trim() === "" ? null : row.rawLabel.trim(),
      categoryLabel: row.categoryLabel,
      source: row.source,
      vlmRawLabel: row.vlmRawLabel,
      vlmCategory: row.vlmCategory,
    }));

/** Pick up to maxCount items spread evenly across the list (endpoints kept). */
export const sampleEvenly = <T,>(items: T[], maxCount: number): T[] => {
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
 * Validation shared by autosave display and submit. Self rows must have
 * complete, strictly ordered, non-overlapping times; assisted rows get their
 * times from frames so only label/category can be missing. Every row needs a
 * non-empty label and a category before submit (server enforces the same).
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
    if (row.rawLabel.trim() === "") {
      messages.push("Describe the activity.");
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
