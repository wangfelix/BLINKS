"use client";

import { useRouter } from "next/navigation";
import { ExternalLinkIcon } from "lucide-react";

import { useRequireAuth } from "@/lib/use-require-auth";
import { Button, buttonVariants } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { mergeClassNames } from "@/lib/utils";

// PLACEHOLDER: replace with the real oTree/LimeSurvey URL before the study
// starts. The questionnaire itself is external to this repo.
const PLACEHOLDER_SURVEY_URL = "https://survey-placeholder.kit.edu";

const SurveyContent = () => {
  const router = useRouter();

  return (
    <main className="flex flex-1 items-center justify-center px-4 py-12">
      <Card className="w-full max-w-md">
        <CardHeader>
          <CardTitle>Final questionnaire</CardTitle>
          <CardDescription>
            Thank you — both steps of your reconstruction are submitted. To
            finish the evening, please complete the questionnaire. It opens in a
            new tab; come back here afterwards.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          <a
            href={PLACEHOLDER_SURVEY_URL}
            target="_blank"
            rel="noopener noreferrer"
            className={mergeClassNames(
              buttonVariants({ variant: "default" }),
              "w-full",
            )}
          >
            Open the questionnaire
            <ExternalLinkIcon />
          </a>
          <Button
            variant="outline"
            className="w-full"
            onClick={() => router.push("/done")}
          >
            Continue
          </Button>
        </CardContent>
      </Card>
    </main>
  );
};

const SurveyPage = () => {
  const ready = useRequireAuth();
  if (!ready) return null;
  return <SurveyContent />;
};

export default SurveyPage;
