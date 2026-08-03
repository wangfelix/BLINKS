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
                final questionnaire in a separate tab, then return here.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-5 pt-6">
              <div className="flex justify-center">
                <a
                  href={surveyUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className={buttonVariants({ size: "lg" })}
                  onClick={() => setQuestionnaireOpened(true)}
                >
                  Open final questionnaire
                  <ExternalLinkIcon />
                </a>
              </div>

              {questionnaireOpened && (
                <div className="animate-in space-y-3 border-t pt-5 duration-300 fade-in slide-in-from-bottom-2 motion-reduce:animate-none">
                  <p
                    className="text-sm text-muted-foreground"
                    aria-live="polite"
                  >
                    The questionnaire opened in a new tab. Return here after its
                    confirmation page.
                  </p>
                  <div className="flex justify-end">
                    <Button
                      variant="secondary"
                      disabled={completeStudyMutation.isPending}
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
                          I have completed the questionnaire
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
