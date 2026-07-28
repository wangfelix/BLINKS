"use client";

import { CheckCircle2Icon } from "lucide-react";

import { useRequireAuth } from "@/lib/use-require-auth";
import {
  Card,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { StudyNavbar } from "@/components/study-navbar";

const DoneContent = () => {
  return (
    <main className="flex w-full flex-1 flex-col">
      <StudyNavbar />
      <section className="flex flex-1 items-center justify-center px-4 py-12">
        <Card className="w-full max-w-md text-center">
          <CardHeader className="items-center">
            <CheckCircle2Icon
              className="mx-auto size-10 text-primary"
              aria-hidden
            />
            <CardTitle>All done</CardTitle>
            <CardDescription>
              Thank you for taking part in the study. You can close this tab
              now. Please bring the glasses and the study phone back to the lab
              as arranged.
            </CardDescription>
          </CardHeader>
        </Card>
      </section>
    </main>
  );
};

const DonePage = () => {
  const ready = useRequireAuth();
  if (!ready) return null;
  return <DoneContent />;
};

export default DonePage;
