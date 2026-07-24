"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useQuery } from "@tanstack/react-query";
import { ExternalLinkIcon, LoaderCircleIcon } from "lucide-react";

import { useRequireAuth } from "@/lib/use-require-auth";
import { getProfile } from "@/lib/api-client";
import { StudyNavbar } from "@/components/study-navbar";
import { StudyProgress } from "@/components/study-progress";
import { Button, buttonVariants } from "@/components/ui/button";
import { mergeClassNames } from "@/lib/utils";

const SURVEY_URL =
  "https://survey.win.kit.edu/index.php/628794?lang=en";

const surveyUrlForParticipant = (participantId: string): string => {
  const url = new URL(SURVEY_URL);
  url.searchParams.set("participantId", participantId);
  return url.toString();
};

const SurveyContent = () => {
  const router = useRouter();
  const [questionnaireStarted, setQuestionnaireStarted] = useState(false);
  const profileQuery = useQuery({
    queryKey: ["profile"],
    queryFn: getProfile,
  });
  const surveyUrl =
    profileQuery.data === undefined
      ? null
      : surveyUrlForParticipant(profileQuery.data.username);

  return (
    <main className="flex w-full flex-1 flex-col">
      <StudyNavbar />
      <StudyProgress currentPage="surveys" />

      <section className="mx-auto flex w-full max-w-6xl flex-1 flex-col px-4 py-6">
        <div className="mb-4">
          <h1 className="text-xl font-semibold tracking-tight">
            Final questionnaire
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Thank you! Both steps of your reconstruction are submitted. Please
            complete the questionnaire below. When you reach its confirmation
            page, return here and continue.
          </p>
        </div>

        {surveyUrl === null ? (
          <div className="flex min-h-[640px] flex-1 items-center justify-center rounded-xl border bg-muted/40">
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <LoaderCircleIcon className="animate-spin" aria-hidden />
              Loading questionnaire…
            </div>
          </div>
        ) : (
          <div className="relative min-h-[640px] flex-1 overflow-hidden rounded-xl border bg-white shadow-sm">
            {!questionnaireStarted && (
              <div className="absolute inset-0 z-10 flex items-center justify-center bg-white">
                <div className="flex items-center gap-2 text-sm text-muted-foreground">
                  <LoaderCircleIcon className="animate-spin" aria-hidden />
                  Loading questionnaire…
                </div>
              </div>
            )}
            <iframe
              src={surveyUrl}
              title="BLINKS final questionnaire"
              className="block h-[75dvh] min-h-[640px] w-full border-0"
              loading="eager"
              referrerPolicy="strict-origin-when-cross-origin"
              onLoad={() => setQuestionnaireStarted(true)}
            />
          </div>
        )}

        {surveyUrl !== null && (
          <div className="mt-4 flex flex-col gap-3 border-t pt-4 sm:flex-row sm:items-center sm:justify-between">
            <p className="text-sm text-muted-foreground">
              Having trouble with the embedded questionnaire?{" "}
              <a
                href={surveyUrl}
                target="_blank"
                rel="noopener noreferrer"
                className={mergeClassNames(
                  buttonVariants({ variant: "link", size: "sm" }),
                  "h-auto p-0 align-baseline",
                )}
                onClick={() => setQuestionnaireStarted(true)}
              >
                Open it in a new tab
                <ExternalLinkIcon />
              </a>
            </p>
            {questionnaireStarted && (
              <Button
                className="w-full sm:w-auto"
                onClick={() => router.push("/done")}
              >
                Continue
              </Button>
            )}
          </div>
        )}
      </section>
    </main>
  );
};

const SurveyPage = () => {
  const ready = useRequireAuth();
  if (!ready) return null;
  return <SurveyContent />;
};

export default SurveyPage;
