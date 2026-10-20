import type {
  Activity,
  ActivityLabel,
  ActivityInput,
  ActivitySource,
  CategoryLabel,
  ExperienceRatings,
  Frame,
} from "@/lib/api-types";
import { isActivityLabel } from "@/lib/activity-vocabulary";
import {
  emptyRatings,
  experienceItems,
  isCategoryLabel,
} from "@/lib/study-config-store";

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
  // Experience-item answers keyed by item (every configured key present).
  // Answers are kept for every item, including items that do not apply to the
  // current category; only the items that apply to the final category count,
  // and the required ones must be answered to submit.
  ratings: ExperienceRatings;
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
  categoryLabel: isCategoryLabel(activity.categoryLabel)
    ? activity.categoryLabel
    : null,
  source: activity.source,
  proposalActivityId: activity.proposalActivityId,
  isIncorrectAnnotationInjected:
    activity.isIncorrectAnnotationInjected === true,
  ratings: { ...emptyRatings(), ...activity.ratings },
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
      ratings: { ...row.ratings },
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

/**
 * True when two neighbouring activities now carry the same activity AND the
 * same category, so keeping them apart records a distinction the participant
 * no longer makes. Segmentation already joins matching chunks, so this can
 * only become true through an edit — which is exactly when the merge control
 * should draw attention to itself. Merging stays a deliberate click: the
 * participant may still be part-way through relabelling the pair.
 */
export const activitiesInviteMerge = (
  first: EditableActivity,
  second: EditableActivity,
): boolean =>
  first.rawLabel !== null &&
  first.rawLabel === second.rawLabel &&
  first.categoryLabel !== null &&
  first.categoryLabel === second.categoryLabel;

export interface MergeResolution {
  rows: EditableActivity[];
  /** Answers dropped because the two activities disagreed; drives the notice. */
  clearedLabel: boolean;
  clearedCategory: boolean;
  clearedRating: boolean;
}

/** Keep an answer only when both merged activities already agreed on it. */
const agreedValue = <T>(first: T, second: T): T | null =>
  first === second ? first : null;

/**
 * Merge one activity with the activity that follows it into a single span
 * [first.start, second.end). The per-window segmentation splits a continuous
 * stretch of work whenever the VLM's argmax wobbles, so rejoining those rows
 * is the most common assisted-round correction.
 *
 * The merged row IS the first row extended: it keeps that row's identity,
 * source, and immutable-proposal link, the same way a split row keeps its
 * provenance, so the assisted list stays a queryable edit history against the
 * untouched proposal. Participant answers follow a different rule — activity
 * and category survive only where the two rows already agreed, and are
 * otherwise cleared so the participant re-answers for the merged span rather
 * than inheriting an arbitrary half of it.
 *
 * The experience rating is subordinate to the category: only the rating that
 * matches the SURVIVING category can survive, and only if the two rows gave it
 * the same answer. A cleared category therefore clears both ratings, and the
 * rating belonging to the other category is dropped rather than carried along.
 * Analysis only ever reads the rating matching the final category, and the
 * server stores both fields as sent, so a row can hold a stale answer in the
 * field its category does not use; without this rule two such rows could merge
 * into a rating the participant never gave for the merged span.
 *
 * Returns the input rows unchanged when there is nothing to merge (unknown
 * row, no following row, or either span incomplete).
 */
export const mergeWithNextActivity = (
  rows: EditableActivity[],
  localId: string,
): MergeResolution => {
  const unchanged: MergeResolution = {
    rows,
    clearedLabel: false,
    clearedCategory: false,
    clearedRating: false,
  };
  const sorted = sortActivities(rows);
  const index = sorted.findIndex((row) => row.localId === localId);
  if (index < 0 || index + 1 >= sorted.length) return unchanged;

  const first = sorted[index];
  const second = sorted[index + 1];
  if (
    first.startMs === null ||
    first.endMs === null ||
    second.startMs === null ||
    second.endMs === null
  ) {
    return unchanged;
  }

  const rawLabel = agreedValue(first.rawLabel, second.rawLabel);
  const categoryLabel = agreedValue(first.categoryLabel, second.categoryLabel);
  // Per item: kept only when it applies to the surviving category and both
  // rows gave the same answer.
  const ratings: ExperienceRatings = {};
  for (const item of experienceItems()) {
    ratings[item.key] =
      categoryLabel !== null && item.appliesTo.includes(categoryLabel)
        ? agreedValue(
            first.ratings[item.key] ?? null,
            second.ratings[item.key] ?? null,
          )
        : null;
  }
  const merged: EditableActivity = {
    ...first,
    // A gap between the two (left by an earlier deletion) is absorbed, so the
    // merged span stays contiguous and its images stay assigned.
    endMs: second.endMs,
    rawLabel,
    categoryLabel,
    ratings,
  };

  // "Cleared" means an answer existed on one of the two rows and did not
  // survive the merge. Two already-blank rows (an unlabelled chunk the VLM
  // failed on) lose nothing and need no extra explanation.
  const wasCleared = <T>(mergedValue: T | null, a: T | null, b: T | null) =>
    mergedValue === null && (a !== null || b !== null);

  // Only report a rating the participant now has to answer again. A rating
  // dropped from the field the surviving category does not use is not one of
  // them: nothing reads it, and naming it would send the participant looking
  // for a scale that is not on screen. An `other` activity is never rated.
  const items = experienceItems();
  const hadAnyRating = items.some(
    (item) =>
      (first.ratings[item.key] ?? null) !== null ||
      (second.ratings[item.key] ?? null) !== null,
  );
  const clearedRating =
    categoryLabel === null
      ? hadAnyRating
      : items
          .filter((item) => item.appliesTo.includes(categoryLabel))
          .some((item) =>
            wasCleared(
              ratings[item.key],
              first.ratings[item.key] ?? null,
              second.ratings[item.key] ?? null,
            ),
          );

  return {
    rows: sorted
      .map((row) => (row.localId === localId ? merged : row))
      .filter((row) => row.localId !== second.localId),
    clearedLabel: wasCleared(rawLabel, first.rawLabel, second.rawLabel),
    clearedCategory: wasCleared(
      categoryLabel,
      first.categoryLabel,
      second.categoryLabel,
    ),
    clearedRating,
  };
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
 * red; it remains selectable in the window picker.
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
 * True once every activity has answered each required experience item of its
 * category. A missing rating blocks submit and marks the rating scale red; it
 * adds no row message.
 */
export const hasAllExperienceRatings = (rows: EditableActivity[]): boolean => {
  const items = experienceItems();
  return rows.every((row) => {
    const category = row.categoryLabel;
    if (category === null) return true;
    return items.every(
      (item) =>
        !item.requiredOnSubmit ||
        !item.appliesTo.includes(category) ||
        (row.ratings[item.key] ?? null) !== null,
    );
  });
};

/**
 * The chronology anchor for a wall-clock time typed into row `index`: the
 * latest boundary the participant has already committed *before* it. A typed
 * time that falls before this anchor belongs to the next calendar date (see
 * resolveTypedTimeOfDay). An end time anchors on its own row's start, so
 * "23:00 to 00:30" rolls without depending on neighbouring rows. Returns null
 * when nothing precedes the row, which leaves the typed time on the study day
 * itself — a day that genuinely begins at 00:30 must not roll.
 */
export const selfTimeAnchor = (
  rows: EditableActivity[],
  index: number,
  field: "startMs" | "endMs",
): number | null => {
  if (index < 0 || index >= rows.length) return null;
  if (field === "endMs" && rows[index].startMs !== null) {
    return rows[index].startMs;
  }
  let anchor: number | null = null;
  for (const row of rows.slice(0, index)) {
    for (const boundary of [row.startMs, row.endMs]) {
      if (boundary !== null && (anchor === null || boundary > anchor)) {
        anchor = boundary;
      }
    }
  }
  return anchor;
};

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
