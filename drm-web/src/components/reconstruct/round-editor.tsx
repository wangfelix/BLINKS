"use client";

import { Fragment, useEffect, useRef, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { CircleCheckIcon, PlusIcon, Trash2Icon, XIcon } from "lucide-react";

import type {
  Activity,
  ActivityLabel,
  ActivityInput,
  CategoryLabel,
  ExperienceRating,
  Frame,
} from "@/lib/api-types";
import { ApiError, saveRoundDraft, submitRound } from "@/lib/api-client";
import {
  formatDayLabel,
  formatTimeSpan,
  resolveTypedTimeOfDay,
} from "@/lib/time";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Column, Row } from "@/components/layout/flex";
import { Text } from "@/components/layout/text";
import { AssistedActivityRow } from "@/components/reconstruct/assisted-activity-row";
import { SelfActivityRow } from "@/components/reconstruct/self-activity-row";
import {
  computeRowIssues,
  claimActivitySpan,
  fromServerActivity,
  gapHasUnassignedImages,
  hasAllExperienceRatings,
  makeLocalId,
  selfTimeAnchor,
  sortActivities,
  toActivityInputs,
  type EditableActivity,
  type SpanAdjustmentEffect,
} from "@/components/reconstruct/editor-types";
import { FramePickerDialog } from "@/components/reconstruct/frame-picker-dialog";
import type { StudyDayBounds } from "@/components/reconstruct/time-slots";
import type { RatedCategory } from "@/components/reconstruct/experience-rating-scale";
import { PhotoManagementDialog } from "@/components/photos/photo-management-dialog";
import { frameIdentityKey } from "@/components/photos/use-photo-deletion";

const AUTOSAVE_DEBOUNCE_MS = 1500;

type SaveState = "idle" | "saving" | "saved" | "error";

type BoundaryDialogState =
  | { mode: "adjust"; localId: string }
  | { mode: "insert"; afterLocalId: string | null }; // null = before the first activity

interface PhotoDialogState {
  localId: string;
  initialFrameKey?: string;
}

/** Everything the FramePickerDialog needs for one adjust/insert interaction. */
interface FramePickerConfig {
  title: string;
  description: string;
  currentActivityId?: string;
  initialStartMs?: number;
  initialEndMs?: number;
  initialFocusMs?: number;
  confirmLabel: string;
}

interface EditorNotice {
  id: number;
  title: string;
  description: string;
}

interface PendingEditorNotice {
  notice: Omit<EditorNotice, "id">;
  spanFingerprint: string;
}

// No idle text: the indicator only appears once a save is actually happening.
const SAVE_INDICATOR_TEXT: Record<Exclude<SaveState, "idle">, string> = {
  saving: "Saving…",
  saved: "Draft saved",
  error: "Saving failed — your next change will retry",
};

/**
 * A row the participant has started filling in. Only these rows show their
 * validation issues — a freshly added, still-empty row stays quiet, but any
 * partially complete row explains why Submit is disabled.
 */
const hasStartedFillingIn = (row: EditableActivity): boolean =>
  row.startMs !== null ||
  row.endMs !== null ||
  row.rawLabel !== null ||
  row.categoryLabel !== null;

const InsertBetweenButton = ({
  onClick,
  hasUnassignedImages,
}: {
  onClick: () => void;
  hasUnassignedImages: boolean;
}) => (
  <Row justify="center">
    <Button
      variant={hasUnassignedImages ? "destructive" : "ghost"}
      size="xs"
      className={
        hasUnassignedImages
          ? "h-9 border border-destructive/30 bg-destructive/10 px-3 text-destructive hover:bg-destructive/20"
          : "h-9 px-3 text-muted-foreground"
      }
      onClick={onClick}
      aria-label={
        hasUnassignedImages
          ? "Insert activity — unassigned images in this gap"
          : "Insert activity"
      }
    >
      <PlusIcon />
      Insert activity
      {hasUnassignedImages && (
        <span className="ml-1 rounded-full bg-destructive px-2 py-0.5 text-[10px] font-semibold text-white">
          Unassigned images
        </span>
      )}
    </Button>
  </Row>
);

const spanFingerprint = (activities: ActivityInput[]): string =>
  JSON.stringify(
    activities.map((activity) => [
      activity.startMs,
      activity.endMs,
      activity.source,
      activity.proposalActivityId,
    ]),
  );

const adjustmentNotice = (
  effects: SpanAdjustmentEffect[],
  target: "new" | "current",
): Omit<EditorNotice, "id"> | null => {
  if (effects.length === 0) return null;
  const describe = (effect: SpanAdjustmentEffect): string => {
    const subject =
      effect.side === "preceding"
        ? "The preceding activity"
        : effect.side === "following"
          ? "The following activity"
          : "An overlapping activity";
    if (effect.kind === "split") return `${subject} was split`;
    return `${subject} was ${effect.kind}`;
  };
  const summaries = effects.map(describe);
  const changeSummary =
    summaries.length <= 2
      ? summaries.join(" and ")
      : `${effects.length} overlapping activities were adjusted`;
  const targetLabel = target === "new" ? "new activity" : "current activity";
  return {
    title:
      effects.length === 1 ? "Activity time updated" : "Activity times updated",
    description: `${changeSummary} to make room. Images in the affected time are now assigned to your ${targetLabel}.`,
  };
};

/**
 * Editable reconstruction for one (non-submitted) round. Round 1 starts from
 * memory with manual time entry and no frames. Round 2 shows the VLM-proposed
 * segmentation with frame thumbnails. Drafts autosave (debounced); Submit
 * locks the round permanently (and, for round 1, unlocks round 2).
 */
export const RoundEditor = ({
  round,
  day,
  dayBounds,
  initialActivities,
  frames,
  onSubmitted,
}: {
  round: 1 | 2;
  day: string;
  /** Server-authoritative epoch extent of the study day (never derived here). */
  dayBounds: StudyDayBounds;
  initialActivities: Activity[];
  frames: Frame[] | null; // present for the assisted round only
  onSubmitted: () => void;
}) => {
  const queryClient = useQueryClient();

  const [rows, setRows] = useState<EditableActivity[]>(() =>
    sortActivities(initialActivities.map(fromServerActivity)),
  );
  const [editVersion, setEditVersion] = useState(0);
  const [saveState, setSaveState] = useState<SaveState>("idle");
  const [boundaryDialog, setBoundaryDialog] =
    useState<BoundaryDialogState | null>(null);
  const [photoDialog, setPhotoDialog] = useState<PhotoDialogState | null>(null);
  const [deleteCandidateLocalId, setDeleteCandidateLocalId] = useState<
    string | null
  >(null);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [notice, setNotice] = useState<EditorNotice | null>(null);

  const deleteCandidate =
    deleteCandidateLocalId === null
      ? null
      : (rows.find((row) => row.localId === deleteCandidateLocalId) ?? null);
  const deleteCandidateTimeSpan =
    deleteCandidate?.startMs !== null &&
    deleteCandidate?.startMs !== undefined &&
    deleteCandidate.endMs !== null
      ? formatTimeSpan(deleteCandidate.startMs, deleteCandidate.endMs)
      : null;

  // Latest rows for the debounced/unmount saves, without retriggering their
  // effects on every keystroke.
  const rowsRef = useRef(rows);
  useEffect(() => {
    rowsRef.current = rows;
  }, [rows]);
  const pendingSaveRef = useRef(false);
  const autosaveTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingNoticeRef = useRef<PendingEditorNotice | null>(null);

  useEffect(() => {
    if (notice === null) return;
    const timeout = setTimeout(() => setNotice(null), 7000);
    return () => clearTimeout(timeout);
  }, [notice]);

  const markEdited = () => setEditVersion((version) => version + 1);

  const saveMutation = useMutation({
    mutationFn: (activities: ActivityInput[]) =>
      saveRoundDraft(round, activities),
    onMutate: () => setSaveState("saving"),
    onSuccess: (_result, savedActivities) => {
      setSaveState("saved");
      const pendingNotice = pendingNoticeRef.current;
      if (
        pendingNotice !== null &&
        pendingNotice.spanFingerprint === spanFingerprint(savedActivities)
      ) {
        setNotice({ ...pendingNotice.notice, id: Date.now() });
        pendingNoticeRef.current = null;
      }
      // Round status may move none -> draft.
      void queryClient.invalidateQueries({ queryKey: ["study-state"] });
    },
    onError: () => setSaveState("error"),
  });
  const { mutate: saveDraft } = saveMutation;

  // Debounced autosave: every edit bumps editVersion, the save fires once the
  // participant pauses for AUTOSAVE_DEBOUNCE_MS.
  useEffect(() => {
    if (editVersion === 0) return;
    pendingSaveRef.current = true;
    const timeout = setTimeout(() => {
      pendingSaveRef.current = false;
      autosaveTimeoutRef.current = null;
      saveDraft(toActivityInputs(rowsRef.current));
    }, AUTOSAVE_DEBOUNCE_MS);
    autosaveTimeoutRef.current = timeout;
    return () => clearTimeout(timeout);
  }, [editVersion, saveDraft]);

  // Flush a still-pending draft when the editor unmounts (navigation) so the
  // last edits are not lost.
  useEffect(() => {
    return () => {
      if (pendingSaveRef.current) {
        pendingSaveRef.current = false;
        void saveRoundDraft(round, toActivityInputs(rowsRef.current)).catch(
          () => {
            // Best-effort flush; the draft remains editable next time.
          },
        );
      }
    };
  }, [round]);

  const cancelPendingAutosave = () => {
    pendingSaveRef.current = false;
    if (autosaveTimeoutRef.current !== null) {
      clearTimeout(autosaveTimeoutRef.current);
      autosaveTimeoutRef.current = null;
    }
  };

  const submitMutation = useMutation({
    mutationFn: () => submitRound(round, toActivityInputs(rowsRef.current)),
    onSuccess: async () => {
      cancelPendingAutosave(); // a late draft PUT would 409 against the lock
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["study-state"] }),
        queryClient.invalidateQueries({ queryKey: ["round", round] }),
      ]);
      onSubmitted();
    },
  });

  // --- Row mutators ----------------------------------------------------------

  const updateRow = (
    localId: string,
    patch: Partial<EditableActivity>,
    resort = false,
  ) => {
    setRows((previous) => {
      const updated = previous.map((row) =>
        row.localId === localId ? { ...row, ...patch } : row,
      );
      return resort ? sortActivities(updated) : updated;
    });
    markEdited();
  };

  const deleteRow = (localId: string) => {
    setRows((previous) => previous.filter((row) => row.localId !== localId));
    markEdited();
  };

  const confirmDeleteRow = () => {
    if (deleteCandidateLocalId === null) return;
    deleteRow(deleteCandidateLocalId);
    setDeleteCandidateLocalId(null);
  };

  const addSelfRow = () => {
    setRows((previous) => [
      ...previous,
      {
        localId: makeLocalId(),
        startMs: null,
        endMs: null,
        rawLabel: null,
        categoryLabel: null,
        source: "user",
        proposalActivityId: null,
        isIncorrectAnnotationInjected: false,
        workloadRating: null,
        recoveryRating: null,
      },
    ]);
    markEdited();
  };

  const insertActivity = (startMs: number, endMs: number) => {
    pendingNoticeRef.current = null;
    const localId = makeLocalId();
    const inserted: EditableActivity = {
      localId,
      startMs,
      endMs,
      rawLabel: null,
      categoryLabel: null,
      source: "user",
      proposalActivityId: null,
      isIncorrectAnnotationInjected: false,
      workloadRating: null,
      recoveryRating: null,
    };
    const resolution = claimActivitySpan(
      [...rowsRef.current, inserted],
      localId,
      startMs,
      endMs,
    );
    const nextInputs = toActivityInputs(resolution.rows);
    const nextNotice = adjustmentNotice(resolution.effects, "new");
    if (nextNotice !== null) {
      pendingNoticeRef.current = {
        notice: nextNotice,
        spanFingerprint: spanFingerprint(nextInputs),
      };
    }
    rowsRef.current = resolution.rows;
    setRows(resolution.rows);
    markEdited();
  };

  /** Store a Likert answer under the field matching the rated category. */
  const setExperienceRating = (
    localId: string,
    category: RatedCategory,
    rating: ExperienceRating,
  ) => {
    updateRow(
      localId,
      category === "work"
        ? { workloadRating: rating }
        : { recoveryRating: rating },
    );
  };

  /** Set a new time span on one activity; see resolveSpanOverlaps. */
  const applyBoundaryChange = (
    localId: string,
    newStartMs: number,
    newEndMs: number,
  ) => {
    pendingNoticeRef.current = null;
    const resolution = claimActivitySpan(
      rowsRef.current,
      localId,
      newStartMs,
      newEndMs,
    );
    const nextInputs = toActivityInputs(resolution.rows);
    const nextNotice = adjustmentNotice(resolution.effects, "current");
    if (nextNotice !== null) {
      pendingNoticeRef.current = {
        notice: nextNotice,
        spanFingerprint: spanFingerprint(nextInputs),
      };
    }
    rowsRef.current = resolution.rows;
    setRows(resolution.rows);
    markEdited();
  };

  /**
   * Self rows carry a wall-clock time with no date. The study day runs past
   * midnight, so a time that falls before what the participant already
   * entered is dated to the next day (resolveTypedTimeOfDay); the date is
   * stored but never shown, because the chronological order already reads
   * correctly on screen.
   */
  const handleSelfTimeChange = (
    localId: string,
    field: "startMs" | "endMs",
    timeOfDay: string,
  ) => {
    if (timeOfDay === "") {
      updateRow(localId, { [field]: null }, field === "startMs");
      return;
    }
    const index = rowsRef.current.findIndex((row) => row.localId === localId);
    const epochMs = resolveTypedTimeOfDay(
      day,
      timeOfDay,
      selfTimeAnchor(rowsRef.current, index, field),
      dayBounds.endMs,
    );
    updateRow(localId, { [field]: epochMs }, field === "startMs");
  };

  // --- Validation + submit ---------------------------------------------------

  const isAssistedRound = round === 2;
  const issues = computeRowIssues(rows, round === 1);
  const issueByLocalId = new Map(
    issues.map((issue) => [issue.localId, issue.message]),
  );
  const hasNoActivities = rows.length === 0;
  // Drives the Submit button's disabled state: at least one activity, every
  // activity complete (time span, label, category) without overlaps, and
  // every work/break activity rated (the scale highlights itself, so a
  // missing rating disables submit without adding a row message).
  const isReadyToSubmit =
    !hasNoActivities && issues.length === 0 && hasAllExperienceRatings(rows);

  const handleConfirmSubmit = () => {
    cancelPendingAutosave();
    submitMutation.mutate();
  };

  // --- Frame picker dialog (assisted only) -----------------------------------

  /**
   * Picker for "Adjust times" on an existing activity. It offers the whole
   * day, so the span can be extended across any number of other activities;
   * applyBoundaryChange resolves the overlaps.
   */
  const buildAdjustTimesPicker = (
    localId: string,
  ): FramePickerConfig | null => {
    const row = rows.find((candidate) => candidate.localId === localId);
    if (row === undefined) return null;
    return {
      title: "Adjust the activity's time span",
      description:
        "Choose the start and end in five-minute intervals. You can extend this activity across other activities — they shorten, split, or are removed to make room.",
      currentActivityId: row.localId,
      initialStartMs: row.startMs ?? undefined,
      initialEndMs: row.endMs ?? undefined,
      initialFocusMs: row.startMs ?? undefined,
      confirmLabel: "Apply time span",
    };
  };

  /**
   * Picker for "Insert activity" between two existing activities (or before
   * the first / after the last one). The button location supplies the initial
   * scroll target, while the participant may choose any five-minute span.
   */
  const buildInsertActivityPicker = (
    afterLocalId: string | null,
    dayFrames: Frame[],
  ): FramePickerConfig => {
    const sortedRows = sortActivities(rows);
    const anchorIndex =
      afterLocalId === null
        ? -1
        : sortedRows.findIndex((row) => row.localId === afterLocalId);
    const gapStartMs =
      anchorIndex === -1
        ? Number.NEGATIVE_INFINITY
        : (sortedRows[anchorIndex].endMs ?? Number.NEGATIVE_INFINITY);
    const nextRow: EditableActivity | undefined = sortedRows[anchorIndex + 1];
    const gapEndMs = nextRow?.startMs ?? Number.POSITIVE_INFINITY;
    const firstUnassignedFrame = dayFrames.find(
      (frame) =>
        frame.deletedAt === null &&
        frame.imageUrl !== null &&
        frame.captureEpochMs >= gapStartMs &&
        frame.captureEpochMs < gapEndMs &&
        !sortedRows.some(
          (row) =>
            row.startMs !== null &&
            row.endMs !== null &&
            frame.captureEpochMs >= row.startMs &&
            frame.captureEpochMs < row.endMs,
        ),
    );
    return {
      title: "Insert an activity",
      description:
        "Choose any start and end in five-minute intervals, including times with no images. Overlapping activities will shorten, split, or be removed to make room.",
      initialFocusMs:
        firstUnassignedFrame?.captureEpochMs ??
        (Number.isFinite(gapStartMs)
          ? gapStartMs
          : Number.isFinite(gapEndMs)
            ? gapEndMs
            : undefined),
      confirmLabel: "Insert activity",
    };
  };

  const framePicker: FramePickerConfig | null =
    boundaryDialog === null || frames === null
      ? null
      : boundaryDialog.mode === "adjust"
        ? buildAdjustTimesPicker(boundaryDialog.localId)
        : buildInsertActivityPicker(boundaryDialog.afterLocalId, frames);

  const handleFramePickerConfirm = (startMs: number, endMs: number) => {
    if (boundaryDialog === null) return;
    if (boundaryDialog.mode === "adjust") {
      applyBoundaryChange(boundaryDialog.localId, startMs, endMs);
    } else {
      insertActivity(startMs, endMs);
    }
    setBoundaryDialog(null);
  };

  const photoDialogActivity =
    photoDialog === null
      ? undefined
      : rows.find((row) => row.localId === photoDialog.localId);
  const photoDialogFrames =
    photoDialogActivity === undefined || frames === null
      ? []
      : frames.filter(
          (frame) =>
            frame.captureEpochMs >= (photoDialogActivity.startMs ?? 0) &&
            frame.captureEpochMs < (photoDialogActivity.endMs ?? 0),
        );

  // --- Render ------------------------------------------------------------------

  const editorHint = isAssistedRound
    ? "Review the proposed activities, correct the labels and time spans until they match your day."
    : "Reconstruct your day from memory, one activity at a time.";
  const hasUnassignedImagesAfter = (afterLocalId: string | null): boolean =>
    frames !== null && gapHasUnassignedImages(rows, frames, afterLocalId);

  return (
    <Column gap="lg">
      <Row gap="sm" align="center" justify="between" wrap>
        <Column>
          <h2 className="text-lg font-semibold">{formatDayLabel(day)}</h2>
          <Text variant="secondary">{editorHint}</Text>
        </Column>
        <Row gap="md" align="center">
          {saveState !== "idle" && (
            <span className="text-xs text-muted-foreground" aria-live="polite">
              {SAVE_INDICATOR_TEXT[saveState]}
            </span>
          )}
          <Button
            disabled={!isReadyToSubmit}
            onClick={() => setConfirmOpen(true)}
          >
            Submit step {round}
          </Button>
        </Row>
      </Row>

      {isAssistedRound ? (
        <Column gap="xs">
          <InsertBetweenButton
            hasUnassignedImages={hasUnassignedImagesAfter(null)}
            onClick={() =>
              setBoundaryDialog({ mode: "insert", afterLocalId: null })
            }
          />
          {hasNoActivities && (
            <Text variant="secondary" className="py-4 text-center">
              No activities yet — use “Insert activity” to add the first one.
            </Text>
          )}
          {rows.map((row) => (
            <Fragment key={row.localId}>
              <AssistedActivityRow
                activity={row}
                dayFrames={frames ?? []}
                issue={issueByLocalId.get(row.localId) ?? null}
                highlightIssues={hasStartedFillingIn(row)}
                onChangeLabel={(rawLabel: ActivityLabel) =>
                  updateRow(row.localId, { rawLabel })
                }
                onChangeCategory={(categoryLabel: CategoryLabel) =>
                  updateRow(row.localId, { categoryLabel })
                }
                onChangeExperienceRating={(category, rating) =>
                  setExperienceRating(row.localId, category, rating)
                }
                onDelete={() => setDeleteCandidateLocalId(row.localId)}
                onAdjustBoundaries={() =>
                  setBoundaryDialog({ mode: "adjust", localId: row.localId })
                }
                onViewPhotos={(initialFrame) =>
                  setPhotoDialog({
                    localId: row.localId,
                    ...(initialFrame === undefined
                      ? {}
                      : { initialFrameKey: frameIdentityKey(initialFrame) }),
                  })
                }
              />
              <InsertBetweenButton
                hasUnassignedImages={hasUnassignedImagesAfter(row.localId)}
                onClick={() =>
                  setBoundaryDialog({
                    mode: "insert",
                    afterLocalId: row.localId,
                  })
                }
              />
            </Fragment>
          ))}
        </Column>
      ) : (
        <Column gap="md">
          {hasNoActivities && (
            <Text variant="secondary" className="py-4 text-center">
              Start with your first activity of the day — what did you do, and
              roughly from when to when?
            </Text>
          )}
          {rows.map((row) => (
            <SelfActivityRow
              key={row.localId}
              activity={row}
              issue={issueByLocalId.get(row.localId) ?? null}
              highlightIssues={hasStartedFillingIn(row)}
              onChangeStartTime={(timeOfDay) =>
                handleSelfTimeChange(row.localId, "startMs", timeOfDay)
              }
              onChangeEndTime={(timeOfDay) =>
                handleSelfTimeChange(row.localId, "endMs", timeOfDay)
              }
              onChangeLabel={(rawLabel: ActivityLabel) =>
                updateRow(row.localId, { rawLabel })
              }
              onChangeCategory={(categoryLabel: CategoryLabel) =>
                updateRow(row.localId, { categoryLabel })
              }
              onChangeExperienceRating={(category, rating) =>
                setExperienceRating(row.localId, category, rating)
              }
              onDelete={() => setDeleteCandidateLocalId(row.localId)}
            />
          ))}
          <Row justify="center">
            <Button variant="outline" onClick={addSelfRow}>
              <PlusIcon />
              Add activity
            </Button>
          </Row>
        </Column>
      )}

      <Dialog
        open={deleteCandidate !== null}
        onOpenChange={(open) => {
          if (!open) setDeleteCandidateLocalId(null);
        }}
      >
        <DialogContent className="gap-0 overflow-hidden rounded-2xl p-0 sm:max-w-md">
          <div className="px-5 py-6 pr-14 sm:px-6">
            <DialogHeader>
              <div className="mb-2 flex size-11 items-center justify-center rounded-2xl bg-destructive/10 text-destructive">
                <Trash2Icon className="size-5" aria-hidden />
              </div>
              <DialogTitle className="text-lg leading-tight font-semibold">
                Delete this activity?
              </DialogTitle>
              <DialogDescription className="leading-relaxed">
                {deleteCandidateTimeSpan === null
                  ? "This activity will be removed from your reconstruction."
                  : `The activity from ${deleteCandidateTimeSpan} will be removed from your reconstruction.`}{" "}
                You can create a new activity in its place, or assign the
                unassigned images to the preceding and following activities by
                adjusting their time spans.
              </DialogDescription>
            </DialogHeader>
          </div>
          <div className="flex flex-col-reverse gap-2 border-t bg-muted/30 p-4 sm:flex-row sm:justify-end">
            <Button
              variant="outline"
              className="bg-background"
              onClick={() => setDeleteCandidateLocalId(null)}
            >
              Cancel
            </Button>
            <Button variant="destructive" onClick={confirmDeleteRow}>
              <Trash2Icon aria-hidden />
              Delete activity
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      <Dialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Submit step {round} of 2?</DialogTitle>
            <DialogDescription>
              {round === 1
                ? "Submitting finalizes step 1 — you cannot change it afterwards, and step 2 opens."
                : `Submitting finalizes your reconstruction for ${formatDayLabel(day)}. You cannot edit it afterwards.`}
            </DialogDescription>
          </DialogHeader>
          {submitMutation.isError && (
            <Text variant="destructive">
              {submitMutation.error instanceof ApiError
                ? submitMutation.error.message
                : "Submitting failed. Please try again."}
            </Text>
          )}
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setConfirmOpen(false)}
              disabled={submitMutation.isPending}
            >
              Keep editing
            </Button>
            <Button
              onClick={handleConfirmSubmit}
              disabled={submitMutation.isPending}
            >
              {submitMutation.isPending
                ? "Submitting…"
                : `Submit step ${round}`}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {framePicker !== null && (
        <FramePickerDialog
          open
          onOpenChange={(open) => {
            if (!open) setBoundaryDialog(null);
          }}
          title={framePicker.title}
          description={framePicker.description}
          dayBounds={dayBounds}
          frames={frames ?? []}
          activities={rows}
          currentActivityId={framePicker.currentActivityId}
          initialStartMs={framePicker.initialStartMs}
          initialEndMs={framePicker.initialEndMs}
          initialFocusMs={framePicker.initialFocusMs}
          confirmLabel={framePicker.confirmLabel}
          onConfirm={handleFramePickerConfirm}
        />
      )}

      {photoDialog !== null && photoDialogActivity !== undefined && (
        <PhotoManagementDialog
          open
          onOpenChange={(open) => {
            if (!open) setPhotoDialog(null);
          }}
          title={`Photos from ${formatTimeSpan(
            photoDialogActivity.startMs ?? 0,
            photoDialogActivity.endMs ?? 0,
          )}`}
          description="Review every photo captured during this activity. Deleting a photo keeps its timestamp and does not change the activity's time span."
          frames={photoDialogFrames}
          initialFrameKey={photoDialog.initialFrameKey}
        />
      )}

      {notice !== null && (
        <div
          key={notice.id}
          role="status"
          aria-live="polite"
          className="fixed right-4 bottom-4 z-[80] flex w-[min(24rem,calc(100vw-2rem))] items-start gap-3 rounded-xl border bg-background p-4 shadow-lg"
        >
          <CircleCheckIcon
            className="mt-0.5 size-5 shrink-0 text-emerald-600"
            aria-hidden
          />
          <div className="min-w-0 flex-1">
            <p className="text-sm font-semibold">{notice.title}</p>
            <p className="mt-1 text-sm leading-relaxed text-muted-foreground">
              {notice.description}
            </p>
          </div>
          <button
            type="button"
            aria-label="Dismiss notification"
            onClick={() => setNotice(null)}
            className="rounded-md p-1 text-muted-foreground outline-none hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
          >
            <XIcon className="size-4" aria-hidden />
          </button>
        </div>
      )}
    </Column>
  );
};
