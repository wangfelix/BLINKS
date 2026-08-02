"use client";

import { CheckCircle2Icon } from "lucide-react";

import { useRequireAuth } from "@/lib/use-require-auth";
import {
  Card,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { StudyWorkspaceShell } from "@/components/study-workspace-shell";

const DoneContent = () => {
  return (
    <StudyWorkspaceShell
      maxWidthClassName="max-w-2xl"
      contentClassName="flex min-h-[420px] items-center justify-center"
    >
      <Card className="w-full max-w-md border-white/60 bg-background/75 text-center shadow-lg backdrop-blur-xl dark:border-white/10">
        <CardHeader className="items-center">
          <CheckCircle2Icon
            className="mx-auto size-10 text-primary"
            aria-hidden
          />
          <CardTitle>All done</CardTitle>
          <CardDescription>
            Thank you for taking part in the study. You can close this tab now.
            Please bring the glasses and the study phone back to the lab as
            arranged.
          </CardDescription>
        </CardHeader>
      </Card>
    </StudyWorkspaceShell>
  );
};

const DonePage = () => {
  const ready = useRequireAuth();
  if (!ready) return null;
  return <DoneContent />;
};

export default DonePage;
