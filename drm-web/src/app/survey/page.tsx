"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useQuery } from "@tanstack/react-query";
import { ExternalLinkIcon, LoaderCircleIcon } from "lucide-react";

import { useRequireAuth } from "@/lib/use-require-auth";
import { getProfile } from "@/lib/api-client";
import { surveyUrlForParticipant } from "@/lib/study-config";
import { StudyProgress } from "@/components/study-progress";
import { StudyWorkspaceShell } from "@/components/study-workspace-shell";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button, buttonVariants } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { mergeClassNames } from "@/lib/utils";

const SurveyContent = () => {
  const router = useRouter();
  const [questionnaireOpened, setQuestionnaireOpened] = useState(false);
  const profileQuery = useQuery({
    queryKey: ["profile"],
    queryFn: getProfile,
  });
  const surveyUrl =
    profileQuery.data === undefined
      ? null
      : surveyUrlForParticipant("final", profileQuery.data.username);

  return (
    <StudyWorkspaceShell
      progress={<StudyProgress currentPage="surveys" bare />}
      maxWidthClassName="max-w-3xl"
      contentClassName="flex min-h-[420px] items-center"
    >
      <div className="mx-auto w-full max-w-2xl">
        {profileQuery.isPending ? (
          <div className="flex w-full items-center justify-center gap-2 text-sm text-muted-foreground">
            <LoaderCircleIcon className="animate-spin" aria-hidden />
            Preparing your questionnaire…
          </div>
        ) : profileQuery.isError ? (
          <Alert variant="destructive">
            <AlertTitle>Questionnaire unavailable</AlertTitle>
            <AlertDescription>
              Your participant details could not be loaded. Please refresh the
              page or contact the study team.
            </AlertDescription>
          </Alert>
        ) : surveyUrl === null ? (
          <Alert variant="destructive">
            <AlertTitle>Questionnaire not configured</AlertTitle>
            <AlertDescription>
              The final questionnaire URL is missing or invalid. Please contact
              the study team.
            </AlertDescription>
          </Alert>
        ) : (
          <Card className="w-full overflow-hidden">
            <CardHeader className="border-b bg-muted/30">
              <CardTitle>Final questionnaire</CardTitle>
              <CardDescription>
                Thank you! Both reconstruction steps are submitted. Complete the
                final questionnaire in a separate tab, then return here.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-5 pt-6">
              <a
                href={surveyUrl}
                target="_blank"
                rel="noopener noreferrer"
                className={mergeClassNames(
                  buttonVariants({ size: "lg" }),
                  "w-full sm:w-auto",
                )}
                onClick={() => setQuestionnaireOpened(true)}
              >
                Open final questionnaire
                <ExternalLinkIcon />
              </a>

              {questionnaireOpened && (
                <div className="animate-in space-y-3 border-t pt-5 duration-300 fade-in slide-in-from-bottom-2 motion-reduce:animate-none">
                  <p
                    className="text-sm text-muted-foreground"
                    aria-live="polite"
                  >
                    The questionnaire opened in a new tab. Return here after its
                    confirmation page.
                  </p>
                  <Button
                    variant="secondary"
                    className="w-full sm:w-auto"
                    onClick={() => router.push("/done")}
                  >
                    I have completed the questionnaire
                  </Button>
                </div>
              )}
            </CardContent>
          </Card>
        )}
      </div>
    </StudyWorkspaceShell>
  );
};

const SurveyPage = () => {
  const ready = useRequireAuth();
  if (!ready) return null;
  return <SurveyContent />;
};

export default SurveyPage;
