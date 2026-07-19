"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useQuery } from "@tanstack/react-query";
import { ExternalLinkIcon } from "lucide-react";

import { useRequireAuth } from "@/lib/use-require-auth";
import { getProfile } from "@/lib/api-client";
import { StudyNavbar } from "@/components/study-navbar";
import { StudyProgress } from "@/components/study-progress";
import { Button, buttonVariants } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { mergeClassNames } from "@/lib/utils";

const SURVEY_URL =
  "https://felixwang.limesurvey.net/628794?lang=en&newtest=Y";

const surveyUrlForParticipant = (participantId: string): string => {
  const url = new URL(SURVEY_URL);
  url.searchParams.set("participantId", participantId);
  return url.toString();
};

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
      : surveyUrlForParticipant(profileQuery.data.username);

  return (
    <main className="flex w-full flex-1 flex-col">
      <StudyNavbar />
      <StudyProgress currentPage="surveys" />

      <section className="flex flex-1 items-center justify-center px-4 py-12">
        <Card className="w-full max-w-md">
          <CardHeader>
            <CardTitle>Final questionnaire</CardTitle>
            <CardDescription>
              Thank you! Both steps of your reconstruction are submitted. To
              finish the evening, please complete the questionnaire. It opens in
              a new tab; come back here afterwards.
            </CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-3">
            {surveyUrl === null ? (
              <Button className="w-full" disabled>
                Loading questionnaire…
              </Button>
            ) : (
              <a
                href={surveyUrl}
                target="_blank"
                rel="noopener noreferrer"
                className={mergeClassNames(
                  buttonVariants({ variant: "default" }),
                  "w-full",
                )}
                onClick={() => setQuestionnaireOpened(true)}
              >
                Open the questionnaire
                <ExternalLinkIcon />
              </a>
            )}
            {questionnaireOpened && (
              <Button
                variant="outline"
                className="w-full"
                onClick={() => router.push("/done")}
              >
                Continue
              </Button>
            )}
          </CardContent>
        </Card>
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
