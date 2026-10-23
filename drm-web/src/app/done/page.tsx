"use client";

import { CheckCircle2Icon, ImagesIcon } from "lucide-react";
import { StudyConfigGate } from "@/components/study-config-gate";

import { useRequireAuth } from "@/lib/use-require-auth";
import { StudyWorkspaceShell } from "@/components/study-workspace-shell";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Column } from "@/components/layout/flex";

const DoneContent = () => {
  return (
    <StudyWorkspaceShell
      maxWidthClassName="max-w-2xl"
      contentClassName="flex min-h-[420px] items-center justify-center"
    >
      <Column gap="md" align="center" className="w-full max-w-lg text-center">
        <CheckCircle2Icon className="size-12 text-primary" aria-hidden />
        <h1 className="text-2xl font-semibold tracking-tight">All done</h1>
        <p className="text-base leading-relaxed text-muted-foreground sm:text-lg">
          Thank you for taking part in the study. You can close this tab now.
          Please bring the glasses and the study phone back to the lab as
          arranged.
        </p>
        <Alert className="mt-5 border-sky-300/70 bg-sky-500/5">
          <ImagesIcon aria-hidden />
          <AlertTitle>Your study photos remain available</AlertTitle>
          <AlertDescription>
            You can return to this page at any time to view and delete the
            photos that were taken during the study. Use “Manage Photos” in the
            navigation bar.
          </AlertDescription>
        </Alert>
      </Column>
    </StudyWorkspaceShell>
  );
};

const DonePage = () => {
  const ready = useRequireAuth("completed");
  if (!ready) return null;
  return (
    <StudyConfigGate>
      <DoneContent />
    </StudyConfigGate>
  );
};

export default DonePage;
