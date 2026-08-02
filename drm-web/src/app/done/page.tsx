"use client";

import { CheckCircle2Icon } from "lucide-react";

import { useRequireAuth } from "@/lib/use-require-auth";
import { StudyWorkspaceShell } from "@/components/study-workspace-shell";

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
      </div>
    </StudyWorkspaceShell>
  );
};

const DonePage = () => {
  const ready = useRequireAuth();
  if (!ready) return null;
  return <DoneContent />;
};

export default DonePage;
