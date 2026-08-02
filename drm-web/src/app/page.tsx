"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { useMutation, useQueryClient } from "@tanstack/react-query";

import {
  getStoredOnboardingRoutingState,
  getStoredToken,
  login,
  storeOnboardingRoutingState,
  storeToken,
} from "@/lib/api-client";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Column } from "@/components/layout/flex";
import { Text } from "@/components/layout/text";
import { StudyTeamContactLink } from "@/components/study-team-contact-link";
import { StudyFlowShell } from "@/components/study-flow-shell";

const LandingPage = () => {
  const router = useRouter();
  const queryClient = useQueryClient();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");

  // Already signed in (e.g. returning the same evening): skip the login form.
  useEffect(() => {
    if (getStoredToken() === null) return;
    router.replace(
      getStoredOnboardingRoutingState() === "complete"
        ? "/reconstruct"
        : "/onboarding",
    );
  }, [router]);

  const loginMutation = useMutation({
    mutationFn: () => login(username.trim(), password),
    onSuccess: (response) => {
      // Drop every cached response from a previous session BEFORE entering:
      // stale data from another account must never render (anti-leak — a
      // another participant's assisted round in a shared browser).
      queryClient.clear();
      // Token in localStorage for API calls (Authorization header) AND in the
      // blinks_token cookie so <img> requests to /frames/* are authenticated.
      storeToken(response.token);
      storeOnboardingRoutingState(response.onboarding.completed);
      router.push(
        response.onboarding.completed ? "/reconstruct" : "/onboarding",
      );
    },
  });

  const hasCompleteCredentials = username.trim() !== "" && password !== "";
  const isSignInDisabled = loginMutation.isPending || !hasCompleteCredentials;

  const handleSubmit = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!hasCompleteCredentials) return;
    loginMutation.mutate();
  };

  return (
    <StudyFlowShell
      headerTrailing={
        <span className="rounded-full border border-border/70 bg-background/70 px-3 py-1.5 text-xs font-medium text-muted-foreground shadow-sm backdrop-blur">
          Participant portal
        </span>
      }
      contentClassName="flex items-center justify-center"
    >
      <Column
        gap="xl"
        className="onboarding-step-enter onboarding-stagger w-full max-w-md"
      >
        <Column gap="sm" className="text-center">
          <Text variant="eyebrow" className="uppercase">
            Karlsruhe Institute of Technology
          </Text>
          <h1 className="text-2xl tracking-tight">
            BLINKS — Day Reconstruction Study
          </h1>
          <Text variant="secondary" className="leading-relaxed">
            Sign in with the participant credentials you received from the study
            team. On your first visit, you will choose your own password and
            complete the short pre-study questionnaire. On the evening of your
            recording day, return here to reconstruct your day.
          </Text>
        </Column>

        <Card className="border-white/60 bg-background/75 shadow-lg backdrop-blur-xl dark:border-white/10">
          <CardHeader>
            <CardTitle>Participant sign-in</CardTitle>
            <CardDescription>
              Use the same credentials as in the BLINKS phone app.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <form onSubmit={handleSubmit} className="space-y-4">
              <Column gap="sm">
                <Label htmlFor="username">Participant ID</Label>
                <Input
                  id="username"
                  name="username"
                  autoComplete="username"
                  autoFocus
                  value={username}
                  onChange={(event) => setUsername(event.target.value)}
                />
              </Column>
              <Column gap="sm">
                <Label htmlFor="password">Password</Label>
                <Input
                  id="password"
                  name="password"
                  type="password"
                  autoComplete="current-password"
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                />
              </Column>

              {loginMutation.isError && (
                <Alert variant="destructive">
                  <AlertTitle>Sign-in failed</AlertTitle>
                  <AlertDescription>
                    {loginMutation.error instanceof Error
                      ? loginMutation.error.message
                      : "Please try again."}
                  </AlertDescription>
                </Alert>
              )}

              <Button
                type="submit"
                className="w-full"
                disabled={isSignInDisabled}
              >
                {loginMutation.isPending ? "Signing in…" : "Sign in"}
              </Button>
            </form>
          </CardContent>
        </Card>

        <Text variant="nudge" className="text-center">
          Questions or trouble signing in? <StudyTeamContactLink /> the study
          team.
        </Text>
      </Column>
    </StudyFlowShell>
  );
};

export default LandingPage;
