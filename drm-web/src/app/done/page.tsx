"use client";

import { CheckCircle2Icon, ImagesIcon } from "lucide-react";

import { useRequireAuth } from "@/lib/use-require-auth";
import { StudyWorkspaceShell } from "@/components/study-workspace-shell";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";

const DoneContent = () => {
  return (
    <StudyWorkspaceShell
      maxWidthClassName="max-w-2xl"
      contentClassName="flex min-h-[420px] items-center justify-center"
    >
      <div className="flex w-full max-w-lg flex-col items-center gap-3 text-center">
        <CheckCircle2Icon className="size-12 text-primary" aria-hidden />
        <h1 className="text-2xl font-semibold tracking-tight">All done</h1>
        <p className="text-base leading-relaxed text-muted-foreground sm:text-lg">
          Thank you for taking part in the study. You can close this tab now.
          Please bring the glasses and the study phone back to the lab as
          arranged.
        </p>
        <Alert className="mt-5 border-sky-300/70 bg-sky-500/5 text-left dark:border-sky-400/30">
          <ImagesIcon aria-hidden />
          <AlertTitle>Your study photos remain available</AlertTitle>
          <AlertDescription>
            You can return to this page at any time to view and delete the
            photos that were taken during the study. Use “Manage Photos” in the
            navigation bar.
          </AlertDescription>
        </Alert>
      </div>
    </StudyWorkspaceShell>
  );
};

const DonePage = () => {
  const ready = useRequireAuth("completed");
  if (!ready) return null;
  return <DoneContent />;
};

export default DonePage;
