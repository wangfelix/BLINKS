// ===========================================================================
// Initial VLM-assisted day segmentation (DRM subproject) — CHUNK-BASED
//
// Pure function: turns one day's ordered, clock-aligned 5-minute chunks into
// the initial activity list that the participant edits on the reconstruction
// website.
//
// Rules:
//   1. Every activity starts/ends on the chunk's clock-aligned boundaries.
//   2. Successive available, successfully labelled chunks merge only when
//      both their normalized activity enum and category match.
//   3. Capture gaps receive no special treatment. Equal labelled chunks before
//      and after a period with no chunks merge into one activity.
//   4. Failed/unlabelled chunks each remain a separate null/null activity for
//      participant correction. They are never assigned a neighbor's label.
//
// There is no minimum-duration smoothing: one chunk is a real 5-minute
// classification unit.
// ===========================================================================

export interface SegmentationChunk {
  chunkStartMs: number;
  chunkEndMs: number;
  vlmLabel: string | null;
  vlmCategory: string | null;
  // Model-reported argmax probabilities and full normalized distributions.
  // Legacy/failed chunks may have neither even when imported labels exist.
  vlmActivityConfidence: number | null;
  vlmActivityConfidences: Record<string, number> | null;
  vlmCategoryConfidence: number | null;
  vlmCategoryConfidences: Record<string, number> | null;
}

export interface SegmentedActivity {
  startMs: number;
  endMs: number;
  rawLabel: string | null;
  categoryLabel: string | null;
  vlmMeanActivityConfidence: number | null;
  vlmMeanActivityConfidences: Record<string, number> | null;
  vlmMeanCategoryConfidence: number | null;
  vlmMeanCategoryConfidences: Record<string, number> | null;
}

interface WorkingSegmentedActivity extends SegmentedActivity {
  activityConfidenceSum: number;
  activityConfidenceCount: number;
  activityConfidenceScoreSums: Record<string, number> | null;
  activityConfidenceScoreCount: number;
  categoryConfidenceSum: number;
  categoryConfidenceCount: number;
  categoryConfidenceScoreSums: Record<string, number> | null;
  categoryConfidenceScoreCount: number;
}

// Defensive normalization for legacy/imported strings. Valid closed-enum
// outputs are already byte-identical.
export function normalizeLabel(label: string | null): string | null {
  if (label === null) return null;
  const normalized = label.toLowerCase().trim().replace(/\s+/g, " ");
  return normalized.length > 0 ? normalized : null;
}

const storedLabel = (label: string | null): string | null => {
  if (label === null) return null;
  const cleaned = label.trim().replace(/\s+/g, " ");
  return cleaned.length > 0 ? cleaned : null;
};

export function segmentDay(chunks: SegmentationChunk[]): SegmentedActivity[] {
  const activities: WorkingSegmentedActivity[] = [];

  for (const chunk of chunks) {
    const label = storedLabel(chunk.vlmLabel);
    const normalized = normalizeLabel(label);
    const category = chunk.vlmCategory;
    const isLabelled = normalized !== null && category !== null;
    const previous = activities[activities.length - 1];
    const hasScalarConfidence =
      typeof chunk.vlmActivityConfidence === "number" &&
      Number.isFinite(chunk.vlmActivityConfidence) &&
      chunk.vlmActivityConfidence >= 0 &&
      chunk.vlmActivityConfidence <= 1;
    const confidenceScores =
      isLabelled && chunk.vlmActivityConfidences !== null
        ? chunk.vlmActivityConfidences
        : null;
    const hasCategoryScalarConfidence =
      typeof chunk.vlmCategoryConfidence === "number" &&
      Number.isFinite(chunk.vlmCategoryConfidence) &&
      chunk.vlmCategoryConfidence >= 0 &&
      chunk.vlmCategoryConfidence <= 1;
    const categoryConfidenceScores =
      isLabelled && chunk.vlmCategoryConfidences !== null
        ? chunk.vlmCategoryConfidences
        : null;

    if (
      isLabelled &&
      previous !== undefined &&
      previous.categoryLabel === category &&
      normalizeLabel(previous.rawLabel) === normalized
    ) {
      // Deliberately bridges periods with no chunks: capture gaps do not create
      // a boundary when the surrounding classifications match.
      previous.endMs = chunk.chunkEndMs;
      if (hasScalarConfidence) {
        previous.activityConfidenceSum += chunk.vlmActivityConfidence!;
        previous.activityConfidenceCount += 1;
      }
      if (confidenceScores !== null) {
        if (previous.activityConfidenceScoreSums === null) {
          previous.activityConfidenceScoreSums = {};
        }
        for (const [activityLabel, score] of Object.entries(confidenceScores)) {
          previous.activityConfidenceScoreSums[activityLabel] =
            (previous.activityConfidenceScoreSums[activityLabel] ?? 0) + score;
        }
        previous.activityConfidenceScoreCount += 1;
      }
      if (hasCategoryScalarConfidence) {
        previous.categoryConfidenceSum += chunk.vlmCategoryConfidence!;
        previous.categoryConfidenceCount += 1;
      }
      if (categoryConfidenceScores !== null) {
        if (previous.categoryConfidenceScoreSums === null) {
          previous.categoryConfidenceScoreSums = {};
        }
        for (const [categoryLabel, score] of Object.entries(
          categoryConfidenceScores,
        )) {
          previous.categoryConfidenceScoreSums[categoryLabel] =
            (previous.categoryConfidenceScoreSums[categoryLabel] ?? 0) + score;
        }
        previous.categoryConfidenceScoreCount += 1;
      }
      continue;
    }

    activities.push({
      startMs: chunk.chunkStartMs,
      endMs: chunk.chunkEndMs,
      rawLabel: isLabelled ? label : null,
      categoryLabel: isLabelled ? category : null,
      vlmMeanActivityConfidence:
        isLabelled && hasScalarConfidence
          ? chunk.vlmActivityConfidence
          : null,
      vlmMeanActivityConfidences: isLabelled ? confidenceScores : null,
      vlmMeanCategoryConfidence:
        isLabelled && hasCategoryScalarConfidence
          ? chunk.vlmCategoryConfidence
          : null,
      vlmMeanCategoryConfidences:
        isLabelled ? categoryConfidenceScores : null,
      activityConfidenceSum:
        isLabelled && hasScalarConfidence ? chunk.vlmActivityConfidence! : 0,
      activityConfidenceCount: isLabelled && hasScalarConfidence ? 1 : 0,
      activityConfidenceScoreSums:
        isLabelled && confidenceScores !== null
          ? { ...confidenceScores }
          : null,
      activityConfidenceScoreCount:
        isLabelled && confidenceScores !== null ? 1 : 0,
      categoryConfidenceSum:
        isLabelled && hasCategoryScalarConfidence
          ? chunk.vlmCategoryConfidence!
          : 0,
      categoryConfidenceCount:
        isLabelled && hasCategoryScalarConfidence ? 1 : 0,
      categoryConfidenceScoreSums:
        isLabelled && categoryConfidenceScores !== null
          ? { ...categoryConfidenceScores }
          : null,
      categoryConfidenceScoreCount:
        isLabelled && categoryConfidenceScores !== null ? 1 : 0,
    });
  }

  return activities.map(
    ({
      activityConfidenceSum,
      activityConfidenceCount,
      activityConfidenceScoreSums,
      activityConfidenceScoreCount,
      categoryConfidenceSum,
      categoryConfidenceCount,
      categoryConfidenceScoreSums,
      categoryConfidenceScoreCount,
      ...activity
    }) => ({
      ...activity,
      vlmMeanActivityConfidence:
        activityConfidenceCount > 0
          ? activityConfidenceSum / activityConfidenceCount
          : null,
      vlmMeanActivityConfidences:
        activityConfidenceScoreSums !== null &&
        activityConfidenceScoreCount > 0
          ? Object.fromEntries(
              Object.entries(activityConfidenceScoreSums).map(([label, sum]) => [
                label,
                sum / activityConfidenceScoreCount,
              ]),
            )
          : null,
      vlmMeanCategoryConfidence:
        categoryConfidenceCount > 0
          ? categoryConfidenceSum / categoryConfidenceCount
          : null,
      vlmMeanCategoryConfidences:
        categoryConfidenceScoreSums !== null &&
        categoryConfidenceScoreCount > 0
          ? Object.fromEntries(
              Object.entries(categoryConfidenceScoreSums).map(([label, sum]) => [
                label,
                sum / categoryConfidenceScoreCount,
              ]),
            )
          : null,
    }),
  );
}
