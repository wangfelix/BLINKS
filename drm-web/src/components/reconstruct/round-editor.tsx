"use client";

import { Fragment, useEffect, useRef, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { PlusIcon } from "lucide-react";

import type {
  Activity,
  ActivityInput,
  CategoryLabel,
  Frame,
  RoundMode,
} from "@/lib/api-types";
import { ApiError, saveRoundDraft, submitRound } from "@/lib/api-client";
import { dayTimeToEpochMs, formatDayLabel } from "@/lib/time";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { AssistedActivityRow } from "@/components/reconstruct/assisted-activity-row";
import { SelfActivityRow } from "@/components/reconstruct/self-activity-row";
import {
  computeRowIssues,
  fromServerActivity,
  makeLocalId,
  sortActivities,
  toActivityInputs,
  type EditableActivity,
} from "@/components/reconstruct/editor-types";
import { FramePickerDialog } from "@/components/reconstruct/frame-picker-dialog";

const AUTOSAVE_DEBOUNCE_MS = 1500;

type SaveState = "idle" | "saving" | "saved" | "error";

type BoundaryDialogState =
  | { mode: "adjust"; localId: string }
  | { mode: "insert"; afterLocalId: string | null }; // null = before the first activity

const SAVE_INDICATOR_TEXT: Record<SaveState, string> = {
  idle: "Changes save automatically",
  saving: "Saving…",
  saved: "Draft saved",
  error: "Saving failed — your next change will retry",
};

const InsertBetweenButton = ({ onClick }: { onClick: () => void }) => (
  <div className="flex justify-center">
    <Button
      variant="ghost"
      size="xs"
      className="text-muted-foreground"
      onClick={onClick}
    >
      <PlusIcon />
      Insert activity
    </Button>
  </div>
);

/**
 * Editable reconstruction for one (non-submitted) round. Self rounds start
 * from memory (manual time entry, no frames — round 1 for everyone, round 2
 * in the control arm); the assisted round shows the VLM-proposed segmentation
 * with frame thumbnails. Drafts autosave (debounced); Submit locks the round
 * permanently (and, for round 1, unlocks round 2).
 */
export const RoundEditor = ({
  round,
  mode,
  day,
  initialActivities,
  frames,
  onSubmitted,
}: {
  round: 1 | 2;
  mode: RoundMode;
  day: string;
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
  const [showValidation, setShowValidation] = useState(false);
  const [boundaryDialog, setBoundaryDialog] =
    useState<BoundaryDialogState | null>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);

  const rowsRef = useRef(rows);
  rowsRef.current = rows;
  const pendingSaveRef = useRef(false);
  const autosaveTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(
    null,
  );

  const markEdited = () => setEditVersion((version) => version + 1);

  const saveMutation = useMutation({
    mutationFn: (activities: ActivityInput[]) =>
      saveRoundDraft(round, activities),
    onMutate: () => setSaveState("saving"),
    onSuccess: () => {
      setSaveState("saved");
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
    onSuccess: () => {
      cancelPendingAutosave(); // a late draft PUT would 409 against the lock
      void queryClient.invalidateQueries({ queryKey: ["study-state"] });
      void queryClient.invalidateQueries({ queryKey: ["round", round] });
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

  const addSelfRow = () => {
    setRows((previous) => [
      ...previous,
      {
        localId: makeLocalId(),
        startMs: null,
        endMs: null,
        rawLabel: "",
        categoryLabel: null,
        source: "user",
        vlmRawLabel: null,
        vlmCategory: null,
      },
    ]);
    markEdited();
  };

  const insertActivity = (startMs: number, endMs: number) => {
    setRows((previous) =>
      sortActivities([
        ...previous,
        {
          localId: makeLocalId(),
          startMs,
          endMs,
          rawLabel: "",
          categoryLabel: null,
          source: "user",
          vlmRawLabel: null,
          vlmCategory: null,
        },
      ]),
    );
    markEdited();
  };

  /**
   * Boundary adjustment with the neighbor rule: the previous activity's end
   * clamps to just before the new start, the next activity's start clamps to
   * just after the new end; a neighbor whose span becomes empty is removed.
   * The picker window is limited to [previous.start, next.end], so only the
   * immediate neighbors can be affected.
   */
  const applyBoundaryChange = (
    localId: string,
    newStartMs: number,
    newEndMs: number,
  ) => {
    setRows((previous) => {
      const updated = [...previous];
      const index = updated.findIndex((row) => row.localId === localId);
      if (index === -1) return previous;
      updated[index] = { ...updated[index], startMs: newStartMs, endMs: newEndMs };

      const removals = new Set<string>();
      const previousRow = index > 0 ? updated[index - 1] : null;
      if (
        previousRow !== null &&
        previousRow.endMs !== null &&
        previousRow.endMs >= newStartMs
      ) {
        const clampedEndMs = newStartMs - 1;
        if (previousRow.startMs !== null && clampedEndMs < previousRow.startMs) {
          removals.add(previousRow.localId);
        } else {
          updated[index - 1] = { ...previousRow, endMs: clampedEndMs };
        }
      }
      const nextRow = index < updated.length - 1 ? updated[index + 1] : null;
      if (
        nextRow !== null &&
        nextRow.startMs !== null &&
        nextRow.startMs <= newEndMs
      ) {
        const clampedStartMs = newEndMs + 1;
        if (nextRow.endMs !== null && nextRow.endMs < clampedStartMs) {
          removals.add(nextRow.localId);
        } else {
          updated[index + 1] = { ...nextRow, startMs: clampedStartMs };
        }
      }
      return sortActivities(
        updated.filter((row) => !removals.has(row.localId)),
      );
    });
    markEdited();
  };

  const handleSelfTimeChange = (
    localId: string,
    field: "startMs" | "endMs",
    timeOfDay: string,
  ) => {
    const epochMs = timeOfDay === "" ? null : dayTimeToEpochMs(day, timeOfDay);
    updateRow(localId, { [field]: epochMs }, field === "startMs");
  };

  // --- Validation + submit ---------------------------------------------------

  const issues = computeRowIssues(rows, mode === "self");
  const issueByLocalId = new Map(
    issues.map((issue) => [issue.localId, issue.message]),
  );

  const handleSubmitClick = () => {
    setShowValidation(true);
    if (rows.length === 0 || issues.length > 0) return;
    setConfirmOpen(true);
  };

  const handleConfirmSubmit = () => {
    cancelPendingAutosave();
    submitMutation.mutate();
  };

  // --- Frame picker dialog (assisted only) -----------------------------------

  let framePicker: {
    title: string;
    description: string;
    frames: Frame[];
    initialStartMs?: number;
    initialEndMs?: number;
    confirmLabel: string;
    onConfirm: (startMs: number, endMs: number) => void;
  } | null = null;

  if (boundaryDialog !== null && frames !== null && frames.length > 0) {
    if (boundaryDialog.mode === "adjust") {
      const index = rows.findIndex(
        (row) => row.localId === boundaryDialog.localId,
      );
      if (index !== -1) {
        const row = rows[index];
        const windowStartMs =
          index > 0
            ? (rows[index - 1].startMs ?? frames[0].captureEpochMs)
            : frames[0].captureEpochMs;
        const windowEndMs =
          index < rows.length - 1
            ? (rows[index + 1].endMs ??
              frames[frames.length - 1].captureEpochMs)
            : frames[frames.length - 1].captureEpochMs;
        framePicker = {
          title: "Adjust the activity's time span",
          description:
            "Pick the first and the last frame of this activity. Neighboring activities shrink to make room — a neighbor that ends up with no time left is removed.",
          frames: frames.filter(
            (frame) =>
              frame.captureEpochMs >= windowStartMs &&
              frame.captureEpochMs <= windowEndMs,
          ),
          initialStartMs: row.startMs ?? undefined,
          initialEndMs: row.endMs ?? undefined,
          confirmLabel: "Apply time span",
          onConfirm: (startMs, endMs) => {
            applyBoundaryChange(row.localId, startMs, endMs);
            setBoundaryDialog(null);
          },
        };
      }
    } else {
      const anchorIndex =
        boundaryDialog.afterLocalId === null
          ? -1
          : rows.findIndex(
              (row) => row.localId === boundaryDialog.afterLocalId,
            );
      const gapStartMs =
        anchorIndex === -1
          ? Number.NEGATIVE_INFINITY
          : (rows[anchorIndex].endMs ?? Number.NEGATIVE_INFINITY);
      const nextRow: EditableActivity | undefined = rows[anchorIndex + 1];
      const gapEndMs = nextRow?.startMs ?? Number.POSITIVE_INFINITY;
      framePicker = {
        title: "Insert an activity",
        description:
          "Pick the first and the last frame of the new activity from the frames not yet assigned to any activity, then describe it in the new row.",
        frames: frames.filter(
          (frame) =>
            frame.captureEpochMs > gapStartMs &&
            frame.captureEpochMs < gapEndMs,
        ),
        confirmLabel: "Insert activity",
        onConfirm: (startMs, endMs) => {
          insertActivity(startMs, endMs);
          setBoundaryDialog(null);
        },
      };
    }
  }

  // --- Render ------------------------------------------------------------------

  const editorHint =
    mode === "assisted"
      ? "Review the proposed activities, correct the labels and time spans until they match your day."
      : round === 2
        ? "Go through your day once more from memory — add every activity you can remember now."
        : "Reconstruct your day from memory, one activity at a time.";

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h2 className="text-lg font-semibold">{formatDayLabel(day)}</h2>
          <p className="text-sm text-muted-foreground">{editorHint}</p>
        </div>
        <div className="flex items-center gap-3">
          <span className="text-xs text-muted-foreground" aria-live="polite">
            {SAVE_INDICATOR_TEXT[saveState]}
          </span>
          <Button onClick={handleSubmitClick}>Submit step {round}</Button>
        </div>
      </div>

      <p className="text-xs leading-relaxed text-muted-foreground">
        <span className="font-medium text-foreground">Work</span> = your own
        occupational work.{" "}
        <span className="font-medium text-foreground">Break</span> = an
        intentional, restorative pause (coffee, resting, a deliberate walk,
        socializing to recover).{" "}
        <span className="font-medium text-foreground">Other</span> = neither
        work nor restorative (chores, errands, answering the door).
      </p>

      {showValidation && (rows.length === 0 || issues.length > 0) && (
        <Alert variant="destructive">
          <AlertTitle>Not ready to submit</AlertTitle>
          <AlertDescription>
            {rows.length === 0
              ? "Add at least one activity before submitting."
              : "Please complete the highlighted fields: every activity needs a time span, a description and a category."}
          </AlertDescription>
        </Alert>
      )}

      {mode === "assisted" ? (
        <div className="space-y-1">
          <InsertBetweenButton
            onClick={() =>
              setBoundaryDialog({ mode: "insert", afterLocalId: null })
            }
          />
          {rows.length === 0 && (
            <p className="py-4 text-center text-sm text-muted-foreground">
              No activities yet — use “Insert activity” to add the first one.
            </p>
          )}
          {rows.map((row) => (
            <Fragment key={row.localId}>
              <AssistedActivityRow
                activity={row}
                dayFrames={frames ?? []}
                issue={issueByLocalId.get(row.localId) ?? null}
                showValidation={showValidation}
                onChangeLabel={(rawLabel) =>
                  updateRow(row.localId, { rawLabel })
                }
                onChangeCategory={(categoryLabel: CategoryLabel) =>
                  updateRow(row.localId, { categoryLabel })
                }
                onDelete={() => deleteRow(row.localId)}
                onAdjustBoundaries={() =>
                  setBoundaryDialog({ mode: "adjust", localId: row.localId })
                }
              />
              <InsertBetweenButton
                onClick={() =>
                  setBoundaryDialog({
                    mode: "insert",
                    afterLocalId: row.localId,
                  })
                }
              />
            </Fragment>
          ))}
        </div>
      ) : (
        <div className="space-y-3">
          {rows.length === 0 && (
            <p className="py-4 text-center text-sm text-muted-foreground">
              Start with your first activity of the day — what did you do, and
              roughly from when to when?
            </p>
          )}
          {rows.map((row) => (
            <SelfActivityRow
              key={row.localId}
              activity={row}
              issue={issueByLocalId.get(row.localId) ?? null}
              showValidation={showValidation}
              onChangeStartTime={(timeOfDay) =>
                handleSelfTimeChange(row.localId, "startMs", timeOfDay)
              }
              onChangeEndTime={(timeOfDay) =>
                handleSelfTimeChange(row.localId, "endMs", timeOfDay)
              }
              onChangeLabel={(rawLabel) => updateRow(row.localId, { rawLabel })}
              onChangeCategory={(categoryLabel: CategoryLabel) =>
                updateRow(row.localId, { categoryLabel })
              }
              onDelete={() => deleteRow(row.localId)}
            />
          ))}
          <div className="flex justify-center">
            <Button variant="outline" onClick={addSelfRow}>
              <PlusIcon />
              Add activity
            </Button>
          </div>
        </div>
      )}

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
            <p className="text-sm text-destructive">
              {submitMutation.error instanceof ApiError
                ? submitMutation.error.message
                : "Submitting failed. Please try again."}
            </p>
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
              {submitMutation.isPending ? "Submitting…" : `Submit step ${round}`}
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
          frames={framePicker.frames}
          initialStartMs={framePicker.initialStartMs}
          initialEndMs={framePicker.initialEndMs}
          confirmLabel={framePicker.confirmLabel}
          onConfirm={framePicker.onConfirm}
        />
      )}
    </div>
  );
};
