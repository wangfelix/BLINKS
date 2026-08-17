"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ArrowRightIcon,
  ExternalLinkIcon,
  LoaderCircleIcon,
} from "lucide-react";

import { useRequireAuth } from "@/lib/use-require-auth";
import {
  ApiError,
  completeStudy,
  getProfile,
  storeStudyRoutingState,
} from "@/lib/api-client";
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

const SurveyContent = () => {
  const router = useRouter();
  const queryClient = useQueryClient();
  const [questionnaireOpened, setQuestionnaireOpened] = useState(false);
  const [payoutLinkOpened, setPayoutLinkOpened] = useState(false);
  const profileQuery = useQuery({
    queryKey: ["profile"],
    queryFn: getProfile,
  });
  const surveyUrl =
    profileQuery.data === undefined
      ? null
      : surveyUrlForParticipant("final", profileQuery.data.username);
  const completeStudyMutation = useMutation({
    mutationFn: completeStudy,
    onSuccess: (response) => {
      storeStudyRoutingState(true);
      queryClient.setQueryData(["study-status"], response);
      router.replace("/done");
    },
  });

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
                final questionnaire in a separate tab, then open and complete
                the payout information form before proceeding.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-5 pt-6">
              <div className="flex flex-col items-center gap-3">
                <a
                  href={surveyUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className={buttonVariants({
                    size: "lg",
                    className: "w-full max-w-64",
                  })}
                  onClick={() => setQuestionnaireOpened(true)}
                >
                  1. Open final questionnaire
                  <ExternalLinkIcon />
                </a>
                {questionnaireOpened ? (
                  <a
                    href="/payout"
                    target="_blank"
                    rel="noopener noreferrer"
                    className={buttonVariants({
                      variant: "default",
                      size: "lg",
                      className: "w-full max-w-64",
                    })}
                    onClick={() => setPayoutLinkOpened(true)}
                  >
                    2. Payout Link
                    <ExternalLinkIcon />
                  </a>
                ) : (
                  <Button
                    variant="secondary"
                    size="lg"
                    className="w-full max-w-64"
                    disabled
                  >
                    2. Payout Link
                    <ExternalLinkIcon />
                  </Button>
                )}
              </div>

              <div className="space-y-3 border-t pt-5">
                <p className="text-sm text-muted-foreground" aria-live="polite">
                  {payoutLinkOpened
                    ? "The payout link opened in a new tab. Return here when you are ready to proceed."
                    : questionnaireOpened
                      ? "The questionnaire opened in a new tab. Complete it, then open the payout link."
                      : "Open and complete the final questionnaire first. The payout link will then become available."}
                </p>
                <div className="flex justify-end">
                  <Button
                    variant="secondary"
                    disabled={
                      !payoutLinkOpened || completeStudyMutation.isPending
                    }
                    onClick={() => completeStudyMutation.mutate()}
                  >
                    {completeStudyMutation.isPending ? (
                      <>
                        <LoaderCircleIcon
                          className="animate-spin"
                          aria-hidden
                        />
                        Finishing…
                      </>
                    ) : (
                      <>
                        Continue
                        <ArrowRightIcon aria-hidden />
                      </>
                    )}
                  </Button>
                </div>
                {completeStudyMutation.isError && (
                  <Alert variant="destructive" aria-live="polite">
                    <AlertTitle>Could not finish the study</AlertTitle>
                    <AlertDescription>
                      {completeStudyMutation.error instanceof ApiError
                        ? completeStudyMutation.error.message
                        : "Please try again or contact the study team."}
                    </AlertDescription>
                  </Alert>
                )}
              </div>
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
