"use client";

import { useRouter } from "next/navigation";
import { CheckCircle2Icon } from "lucide-react";

import { clearStoredToken } from "@/lib/api-client";
import { useRequireAuth } from "@/lib/use-require-auth";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";

const DoneContent = () => {
  const router = useRouter();

  const handleSignOut = () => {
    clearStoredToken();
    router.replace("/");
  };

  return (
    <main className="flex flex-1 items-center justify-center px-4 py-12">
      <Card className="w-full max-w-md text-center">
        <CardHeader className="items-center">
          <CheckCircle2Icon
            className="mx-auto size-10 text-primary"
            aria-hidden
          />
          <CardTitle>All done for today</CardTitle>
          <CardDescription>
            Thank you for taking part in the study. You can close this tab now
            — see you tomorrow evening.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Button variant="link" onClick={handleSignOut}>
            Sign out
          </Button>
        </CardContent>
      </Card>
    </main>
  );
};

const DonePage = () => {
  const ready = useRequireAuth();
  if (!ready) return null;
  return <DoneContent />;
};

export default DonePage;
