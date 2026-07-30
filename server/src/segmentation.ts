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
}

export interface SegmentedActivity {
  startMs: number;
  endMs: number;
  rawLabel: string | null;
  categoryLabel: string | null;
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
  const activities: SegmentedActivity[] = [];

  for (const chunk of chunks) {
    const label = storedLabel(chunk.vlmLabel);
    const normalized = normalizeLabel(label);
    const category = chunk.vlmCategory;
    const isLabelled = normalized !== null && category !== null;
    const previous = activities[activities.length - 1];

    if (
      isLabelled &&
      previous !== undefined &&
      previous.categoryLabel === category &&
      normalizeLabel(previous.rawLabel) === normalized
    ) {
      // Deliberately bridges periods with no chunks: capture gaps do not create
      // a boundary when the surrounding classifications match.
      previous.endMs = chunk.chunkEndMs;
      continue;
    }

    activities.push({
      startMs: chunk.chunkStartMs,
      endMs: chunk.chunkEndMs,
      rawLabel: isLabelled ? label : null,
      categoryLabel: isLabelled ? category : null,
    });
  }

  return activities;
}
