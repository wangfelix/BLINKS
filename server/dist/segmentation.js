"use strict";
// ===========================================================================
// Initial VLM-assisted day segmentation (DRM subproject) — CHUNK-BASED
// (reworked 2026-07-19 with the 5-minute-chunk pipeline).
//
// Pure function: turns one day's labeled 5-minute chunks (ordered by window
// start, each carrying the VLM's per-chunk category + raw activity label plus
// the REAL first/last frame times inside the window) into an initial activity
// list the participant then edits on the reconstruction website. Rules
// (frozen contract):
//
//   1. Split into blocks at real capture gaps > 10 minutes (camera off /
//      paused): a gap is measured from one chunk's last frame to the next
//      chunk's first frame, so a missing window with a short actual gap does
//      NOT split, and a long outage inside sparse windows does.
//   2. Group consecutive chunks sharing (vlm_category, normalized vlm_label).
//      normalize = lowercase + trim + collapse whitespace.
//   3. Unlabeled chunks (VLM failed / no output) merge into a labeled
//      neighbor (prefer previous); a block that is entirely unlabeled stays
//      one activity with null labels for the participant to fill in. When
//      such a merge leaves two adjacent segments with the same label +
//      category (a failed chunk in the middle of one activity), they are
//      coalesced into one.
//
// There is deliberately NO minimum-duration smoothing anymore: it existed to
// suppress per-frame label flicker, and chunk labels cannot flicker below the
// window size — a chunk with its own label is a real 5-minute observation.
//
// Activity startMs/endMs = first/last real frame time of the grouped chunks
// (never the window edges), so an activity never claims minutes where no
// frames exist.
// ===========================================================================
Object.defineProperty(exports, "__esModule", { value: true });
exports.GAP_SPLIT_MS = void 0;
exports.normalizeLabel = normalizeLabel;
exports.segmentDay = segmentDay;
exports.GAP_SPLIT_MS = 10 * 60 * 1000;
// lowercase + trim + collapse whitespace; empty becomes null (= no label).
function normalizeLabel(label) {
    if (label === null)
        return null;
    const normalized = label.toLowerCase().trim().replace(/\s+/g, " ");
    return normalized.length > 0 ? normalized : null;
}
// Display form of a label: whitespace cleaned up but original casing kept.
function displayLabel(label) {
    if (label === null)
        return null;
    const cleaned = label.trim().replace(/\s+/g, " ");
    return cleaned.length > 0 ? cleaned : null;
}
// Merges two adjacent segments; the labeled constituent donates label +
// category (only merges involving an unlabeled side ever happen, so there is
// no labeled-vs-labeled conflict to arbitrate).
function mergeAdjacent(earlier, later) {
    const winner = earlier.unlabeled ? later : earlier;
    return {
        startMs: earlier.startMs,
        endMs: later.endMs,
        rawLabel: winner.rawLabel,
        categoryLabel: winner.categoryLabel,
        unlabeled: earlier.unlabeled && later.unlabeled,
    };
}
// Repeatedly merges unlabeled segments into a neighbor (prefer previous). A
// block that shrinks to a single segment keeps it, even if unlabeled.
function mergeUnlabeled(segments) {
    const result = [...segments];
    while (result.length > 1) {
        const index = result.findIndex((segment) => segment.unlabeled);
        if (index === -1)
            break;
        const mergeAt = index > 0 ? index - 1 : 0;
        const merged = mergeAdjacent(result[mergeAt], result[mergeAt + 1]);
        result.splice(mergeAt, 2, merged);
    }
    return result;
}
// Joins adjacent segments that ended up with the same label + category after
// the unlabeled merges (a failed chunk in the middle of one activity must not
// split it into two identical rows).
function coalesceSameKey(segments) {
    const result = [];
    for (const segment of segments) {
        const previous = result[result.length - 1];
        if (previous !== undefined &&
            !previous.unlabeled &&
            !segment.unlabeled &&
            previous.categoryLabel === segment.categoryLabel &&
            normalizeLabel(previous.rawLabel) === normalizeLabel(segment.rawLabel)) {
            previous.endMs = segment.endMs;
        }
        else {
            result.push({ ...segment });
        }
    }
    return result;
}
// Groups one gap-free run of chunks into segments by (category, normalized
// label); consecutive chunks with the same key extend the current segment.
function groupBlock(chunks) {
    const segments = [];
    let currentKey = null;
    for (const chunk of chunks) {
        const normalized = normalizeLabel(chunk.vlmLabel);
        const key = `${chunk.vlmCategory ?? ""}\u0000${normalized ?? ""}`;
        const current = segments[segments.length - 1];
        if (current !== undefined && key === currentKey) {
            current.endMs = chunk.lastFrameMs;
        }
        else {
            segments.push({
                startMs: chunk.firstFrameMs,
                endMs: chunk.lastFrameMs,
                rawLabel: displayLabel(chunk.vlmLabel),
                categoryLabel: chunk.vlmCategory,
                unlabeled: normalized === null && chunk.vlmCategory === null,
            });
            currentKey = key;
        }
    }
    return segments;
}
// The generator: chunks must be ordered by window start, ascending.
function segmentDay(chunks) {
    if (chunks.length === 0)
        return [];
    // Split into blocks at real capture gaps > 10 minutes.
    const blocks = [];
    let block = [chunks[0]];
    for (let i = 1; i < chunks.length; i++) {
        if (chunks[i].firstFrameMs - chunks[i - 1].lastFrameMs > exports.GAP_SPLIT_MS) {
            blocks.push(block);
            block = [];
        }
        block.push(chunks[i]);
    }
    blocks.push(block);
    return blocks
        .flatMap((blockChunks) => coalesceSameKey(mergeUnlabeled(groupBlock(blockChunks))))
        .map(({ startMs, endMs, rawLabel, categoryLabel }) => ({
        startMs,
        endMs,
        rawLabel,
        categoryLabel,
    }));
}
