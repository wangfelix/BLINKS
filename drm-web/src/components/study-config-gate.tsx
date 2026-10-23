"use client";

import { useEffect, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { RefreshCwIcon } from "lucide-react";

import { fetchStudyConfig } from "@/lib/api-client";
import { installStudyConfig } from "@/lib/study-config-store";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Container } from "@/components/layout/container";

export const STUDY_CONFIG_QUERY_KEY = ["study-config"] as const;

/** `ui.locale` "en-GB" -> document language "en". */
const documentLanguage = (locale: string): string =>
  locale.split("-")[0] || "en";

/**
 * Loads GET /api/study-config once per sign-in (sign-in/out clears the query
 * cache) and installs it before rendering the study page. While loading,
 * nothing renders; a failed load shows a retry.
 */
export const StudyConfigGate = ({ children }: { children: ReactNode }) => {
  const configQuery = useQuery({
    queryKey: STUDY_CONFIG_QUERY_KEY,
    queryFn: fetchStudyConfig,
    staleTime: Number.POSITIVE_INFINITY,
    gcTime: Number.POSITIVE_INFINITY,
  });
  const config = configQuery.data;
  // Installed during render so children read the config synchronously.
  if (config !== undefined) installStudyConfig(config);

  useEffect(() => {
    if (config === undefined) return;
    document.documentElement.lang = documentLanguage(config.ui.locale);
  }, [config]);

  if (config !== undefined) return <>{children}</>;
  if (configQuery.isError) {
    return (
      <Container size="lg" className="p-6">
        <Alert variant="destructive">
          <AlertTitle>The study could not be loaded</AlertTitle>
          <AlertDescription>
            <p>Please check your connection and try again.</p>
            <Button
              variant="outline"
              size="sm"
              className="mt-3"
              disabled={configQuery.isFetching}
              onClick={() => void configQuery.refetch()}
            >
              <RefreshCwIcon aria-hidden />
              Try again
            </Button>
          </AlertDescription>
        </Alert>
      </Container>
    );
  }
  return null;
};
