// ===========================================================================
// Initial VLM-assisted day segmentation (DRM subproject).
//
// Pure function: turns one day's face-anonymized frames (ordered by capture
// time, carrying the VLM's per-frame category + raw activity label) into an
// initial activity list the participant then edits on the reconstruction
// website. Rules (frozen contract):
//
//   1. Group consecutive frames sharing (vlm_category, normalized vlm_label).
//      normalize = lowercase + trim + collapse whitespace.
//   2. Split at capture gaps > 10 minutes (camera off / paused); segments
//      never merge across such a gap.
//   3. Smoothing: any segment shorter than 2 minutes is merged into its
//      neighbor (prefer previous); the merged segment's label/category come
//      from the longer constituent. Unlabeled runs (VLM failed / no output)
//      merge into neighbors the same way, with one refinement: when exactly
//      one constituent is labeled, the labeled one wins regardless of length
//      (an unlabeled constituent has no label to contribute).
//
// Activity startMs/endMs = first/last frame capture_epoch_ms of the group.
// ===========================================================================

export const GAP_SPLIT_MS = 10 * 60 * 1000;
export const MIN_SEGMENT_MS = 2 * 60 * 1000;

// Input frame: label/category are null unless the VLM pass finished for the
// frame (vlm_status='done'); 'failed' frames are passed in as null/null.
export interface SegmentationFrame {
  captureEpochMs: number;
  vlmLabel: string | null;
  vlmCategory: string | null;
}

export interface SegmentedActivity {
  startMs: number;
  endMs: number;
  rawLabel: string | null;
  categoryLabel: string | null;
}

interface Segment extends SegmentedActivity {
  unlabeled: boolean;
}

// lowercase + trim + collapse whitespace; empty becomes null (= no label).
export function normalizeLabel(label: string | null): string | null {
  if (label === null) return null;
  const normalized = label.toLowerCase().trim().replace(/\s+/g, " ");
  return normalized.length > 0 ? normalized : null;
}

// Display form of a label: whitespace cleaned up but original casing kept.
function displayLabel(label: string | null): string | null {
  if (label === null) return null;
  const cleaned = label.trim().replace(/\s+/g, " ");
  return cleaned.length > 0 ? cleaned : null;
}

const durationOf = (segment: Segment): number => segment.endMs - segment.startMs;

// Merges two adjacent segments; the winner donates label + category. A labeled
// constituent always beats an unlabeled one; otherwise the longer constituent
// wins, with ties going to the earlier segment ("prefer previous").
function mergeAdjacent(earlier: Segment, later: Segment): Segment {
  let winner: Segment;
  if (earlier.unlabeled !== later.unlabeled) {
    winner = earlier.unlabeled ? later : earlier;
  } else {
    winner = durationOf(later) > durationOf(earlier) ? later : earlier;
  }
  return {
    startMs: earlier.startMs,
    endMs: later.endMs,
    rawLabel: winner.rawLabel,
    categoryLabel: winner.categoryLabel,
    unlabeled: earlier.unlabeled && later.unlabeled,
  };
}

// Repeatedly merges away segments that are unlabeled or shorter than 2 min,
// each into its previous neighbor when one exists (else the next). A block
// that shrinks to a single segment keeps it, even if short or unlabeled.
function smoothBlock(segments: Segment[]): Segment[] {
  const result = [...segments];
  while (result.length > 1) {
    const index = result.findIndex(
      (segment) => segment.unlabeled || durationOf(segment) < MIN_SEGMENT_MS,
    );
    if (index === -1) break;
    const mergeAt = index > 0 ? index - 1 : 0;
    const merged = mergeAdjacent(result[mergeAt], result[mergeAt + 1]);
    result.splice(mergeAt, 2, merged);
  }
  return result;
}

// Groups one gap-free run of frames into segments by (category, normalized
// label); consecutive frames with the same key extend the current segment.
function groupBlock(frames: SegmentationFrame[]): Segment[] {
  const segments: Segment[] = [];
  let currentKey: string | null = null;
  for (const frame of frames) {
    const normalized = normalizeLabel(frame.vlmLabel);
    const key = `${frame.vlmCategory ?? ""}\u0000${normalized ?? ""}`;
    const current = segments[segments.length - 1];
    if (current !== undefined && key === currentKey) {
      current.endMs = frame.captureEpochMs;
    } else {
      segments.push({
        startMs: frame.captureEpochMs,
        endMs: frame.captureEpochMs,
        rawLabel: displayLabel(frame.vlmLabel),
        categoryLabel: frame.vlmCategory,
        unlabeled: normalized === null && frame.vlmCategory === null,
      });
      currentKey = key;
    }
  }
  return segments;
}

// The generator: frames must be ordered by captureEpochMs ascending.
export function segmentDay(frames: SegmentationFrame[]): SegmentedActivity[] {
  if (frames.length === 0) return [];

  // Split into blocks at capture gaps > 10 minutes.
  const blocks: SegmentationFrame[][] = [];
  let block: SegmentationFrame[] = [frames[0]];
  for (let i = 1; i < frames.length; i++) {
    if (frames[i].captureEpochMs - frames[i - 1].captureEpochMs > GAP_SPLIT_MS) {
      blocks.push(block);
      block = [];
    }
    block.push(frames[i]);
  }
  blocks.push(block);

  return blocks
    .flatMap((blockFrames) => smoothBlock(groupBlock(blockFrames)))
    .map(({ startMs, endMs, rawLabel, categoryLabel }) => ({
      startMs,
      endMs,
      rawLabel,
      categoryLabel,
    }));
}
