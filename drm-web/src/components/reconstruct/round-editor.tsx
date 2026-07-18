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
  fromServerActivity,
  makeLocalId,
  resolveSpanOverlaps,
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

/** Everything the FramePickerDialog needs for one adjust/insert interaction. */
interface FramePickerConfig {
  title: string;
  description: string;
  frames: Frame[];
  initialStartMs?: number;
  initialEndMs?: number;
  confirmLabel: string;
  onConfirm: (startMs: number, endMs: number) => void;
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
  row.rawLabel.trim() !== "" ||
  row.categoryLabel !== null;

const InsertBetweenButton = ({ onClick }: { onClick: () => void }) => (
  <Row justify="center">
    <Button
      variant="ghost"
      size="xs"
      className="text-muted-foreground"
      onClick={onClick}
    >
      <PlusIcon />
      Insert activity
    </Button>
  </Row>
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
  const [boundaryDialog, setBoundaryDialog] =
    useState<BoundaryDialogState | null>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);

  // Latest rows for the debounced/unmount saves, without retriggering their
  // effects on every keystroke.
  const rowsRef = useRef(rows);
  useEffect(() => {
    rowsRef.current = rows;
  }, [rows]);
  const pendingSaveRef = useRef(false);
  const autosaveTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

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

  /** Set a new time span on one activity; see resolveSpanOverlaps. */
  const applyBoundaryChange = (
    localId: string,
    newStartMs: number,
    newEndMs: number,
  ) => {
    setRows((previous) =>
      resolveSpanOverlaps(previous, localId, newStartMs, newEndMs),
    );
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

  const isAssistedRound = mode === "assisted";
  const issues = computeRowIssues(rows, mode === "self");
  const issueByLocalId = new Map(
    issues.map((issue) => [issue.localId, issue.message]),
  );
  const hasNoActivities = rows.length === 0;
  // Drives the Submit button's disabled state: at least one activity, and
  // every activity complete (time span, label, category) without overlaps.
  const isReadyToSubmit = !hasNoActivities && issues.length === 0;

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
    dayFrames: Frame[],
  ): FramePickerConfig | null => {
    const row = rows.find((candidate) => candidate.localId === localId);
    if (row === undefined) return null;
    return {
      title: "Adjust the activity's time span",
      description:
        "Pick the first and the last frame of this activity. You can extend it across other activities — they shrink to make room, and an activity left with no time is removed.",
      frames: dayFrames,
      initialStartMs: row.startMs ?? undefined,
      initialEndMs: row.endMs ?? undefined,
      confirmLabel: "Apply time span",
      onConfirm: (startMs, endMs) => {
        applyBoundaryChange(row.localId, startMs, endMs);
        setBoundaryDialog(null);
      },
    };
  };

  /**
   * Picker for "Insert activity" between two existing activities (or before
   * the first / after the last one). Only frames in the unassigned gap are
   * offered.
   */
  const buildInsertActivityPicker = (
    afterLocalId: string | null,
    dayFrames: Frame[],
  ): FramePickerConfig => {
    const anchorIndex =
      afterLocalId === null
        ? -1
        : rows.findIndex((row) => row.localId === afterLocalId);
    const gapStartMs =
      anchorIndex === -1
        ? Number.NEGATIVE_INFINITY
        : (rows[anchorIndex].endMs ?? Number.NEGATIVE_INFINITY);
    const nextRow: EditableActivity | undefined = rows[anchorIndex + 1];
    const gapEndMs = nextRow?.startMs ?? Number.POSITIVE_INFINITY;
    return {
      title: "Insert an activity",
      description:
        "Pick the first and the last frame of the new activity from the frames not yet assigned to any activity, then describe it in the new row.",
      frames: dayFrames.filter(
        (frame) =>
          frame.captureEpochMs > gapStartMs && frame.captureEpochMs < gapEndMs,
      ),
      confirmLabel: "Insert activity",
      onConfirm: (startMs, endMs) => {
        insertActivity(startMs, endMs);
        setBoundaryDialog(null);
      },
    };
  };

  const framePicker: FramePickerConfig | null =
    boundaryDialog === null || frames === null || frames.length === 0
      ? null
      : boundaryDialog.mode === "adjust"
        ? buildAdjustTimesPicker(boundaryDialog.localId, frames)
        : buildInsertActivityPicker(boundaryDialog.afterLocalId, frames);

  // --- Render ------------------------------------------------------------------

  const editorHint = isAssistedRound
    ? "Review the proposed activities, correct the labels and time spans until they match your day."
    : round === 2
      ? "Go through your day once more from memory — add every activity you can remember now."
      : "Reconstruct your day from memory, one activity at a time.";

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
              onChangeLabel={(rawLabel) => updateRow(row.localId, { rawLabel })}
              onChangeCategory={(categoryLabel: CategoryLabel) =>
                updateRow(row.localId, { categoryLabel })
              }
              onDelete={() => deleteRow(row.localId)}
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
          frames={framePicker.frames}
          initialStartMs={framePicker.initialStartMs}
          initialEndMs={framePicker.initialEndMs}
          confirmLabel={framePicker.confirmLabel}
          onConfirm={framePicker.onConfirm}
        />
      )}
    </Column>
  );
};
