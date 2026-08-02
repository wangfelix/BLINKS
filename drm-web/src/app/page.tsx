"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { useMutation, useQueryClient } from "@tanstack/react-query";

import { getStoredToken, login, storeToken } from "@/lib/api-client";
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

const LandingPage = () => {
  const router = useRouter();
  const queryClient = useQueryClient();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");

  // Already signed in (e.g. returning the same evening): skip the login form.
  useEffect(() => {
    if (getStoredToken() !== null) router.replace("/reconstruct");
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
      router.push("/reconstruct");
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
    <main className="flex flex-1 items-center justify-center px-4 py-12">
      <Column gap="xl" className="w-full max-w-md">
        <Column gap="sm" className="text-center">
          <Text variant="eyebrow" className="uppercase">
            Karlsruhe Institute of Technology
          </Text>
          <h1 className="text-2xl tracking-tight">
            BLINKS — Day Reconstruction Study
          </h1>
          <Text variant="secondary" className="leading-relaxed">
            In the evening of your recording day, please reconstruct your day as
            a sequence of activities — in two steps, one after the other. It
            takes about 20 minutes. Sign in with the participant credentials you
            received from the study team, then follow the steps on the next
            pages.
          </Text>
        </Column>

        <Alert>
          <AlertTitle>Important for Step 2</AlertTitle>
          <AlertDescription>
            Some of the activity labels and activity types shown in Step 2 are
            deliberately incorrect. Review the activities and correct anything
            that does not match your day.
          </AlertDescription>
        </Alert>

        <Card>
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
    </main>
  );
};

export default LandingPage;
