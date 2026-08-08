"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
  ArrowRightIcon,
  EyeIcon,
  EyeOffIcon,
  LoaderCircleIcon,
  LockKeyholeIcon,
  UserRoundIcon,
} from "lucide-react";

import {
  getStoredOnboardingRoutingState,
  getStoredStudyRoutingState,
  getStoredToken,
  login,
  storeOnboardingRoutingState,
  storeStudyRoutingState,
  storeToken,
} from "@/lib/api-client";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
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
  const [showPassword, setShowPassword] = useState(false);

  // Already signed in (e.g. returning the same evening): skip the login form.
  useEffect(() => {
    if (getStoredToken() === null) return;
    if (getStoredOnboardingRoutingState() !== "complete") {
      router.replace("/onboarding");
      return;
    }
    router.replace(
      getStoredStudyRoutingState() === "complete" ? "/done" : "/reconstruct",
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
      storeStudyRoutingState(response.study.completed);
      router.push(
        !response.onboarding.completed
          ? "/onboarding"
          : response.study.completed
            ? "/done"
            : "/reconstruct",
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
      contentClassName="flex items-center justify-center"
    >
      <Column
        gap="xl"
        className="onboarding-step-enter onboarding-stagger w-full max-w-md"
      >
        <Column gap="sm" className="text-center">
          <Text variant="eyebrow">Karlsruhe Institute of Technology</Text>
          <h1 className="text-2xl font-semibold tracking-tight outline-none sm:text-3xl">
            Day Reconstruction Study
          </h1>
          <Text variant="secondary" className="leading-relaxed">
            Sign in with the participant credentials you received from the study
            team. On your first visit, you will choose your own password and
            complete the short pre-study questionnaire. On the evening of your
            recording day, return here to reconstruct your day.
          </Text>
        </Column>

        <div className="mx-auto w-full max-w-sm border-t border-border/60 pt-7">
          <div className="text-center">
            <h2 className="text-lg font-semibold tracking-tight">
              Participant sign-in
            </h2>
            <p className="mt-1 text-sm text-muted-foreground">
              Use the same credentials as in the BLINKS phone app.
            </p>
          </div>

          <form onSubmit={handleSubmit} className="mt-6 space-y-5">
            <Column gap="sm">
              <Label htmlFor="username">Participant ID</Label>
              <div className="relative">
                <UserRoundIcon
                  className="pointer-events-none absolute top-1/2 left-4 z-10 size-4 -translate-y-1/2 text-muted-foreground"
                  aria-hidden
                />
                <Input
                  id="username"
                  name="username"
                  autoComplete="username"
                  autoFocus
                  value={username}
                  onChange={(event) => setUsername(event.target.value)}
                  className="h-12 rounded-xl border-border/70 bg-background/60 pr-4 pl-11 text-base backdrop-blur-sm transition-[border-color,box-shadow,background-color] hover:bg-background/80 focus-visible:bg-background"
                />
              </div>
            </Column>

            <Column gap="sm">
              <Label htmlFor="password">Password</Label>
              <div className="relative">
                <LockKeyholeIcon
                  className="pointer-events-none absolute top-1/2 left-4 z-10 size-4 -translate-y-1/2 text-muted-foreground"
                  aria-hidden
                />
                <Input
                  id="password"
                  name="password"
                  type={showPassword ? "text" : "password"}
                  autoComplete="current-password"
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                  className="h-12 rounded-xl border-border/70 bg-background/60 pr-12 pl-11 text-base backdrop-blur-sm transition-[border-color,box-shadow,background-color] hover:bg-background/80 focus-visible:bg-background"
                />
                <button
                  type="button"
                  className="absolute top-1/2 right-2 grid size-8 -translate-y-1/2 place-items-center rounded-lg text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
                  aria-label={showPassword ? "Hide password" : "Show password"}
                  aria-pressed={showPassword}
                  onClick={() => setShowPassword((visible) => !visible)}
                >
                  {showPassword ? (
                    <EyeOffIcon className="size-4" aria-hidden />
                  ) : (
                    <EyeIcon className="size-4" aria-hidden />
                  )}
                </button>
              </div>
            </Column>

            {loginMutation.isError && (
              <Alert variant="destructive" aria-live="polite">
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
              className="relative h-12 w-full rounded-xl px-5 text-base shadow-md transition-[transform,box-shadow,background-color] hover:shadow-lg"
              disabled={isSignInDisabled}
            >
              {loginMutation.isPending ? (
                <>
                  <LoaderCircleIcon className="animate-spin" aria-hidden />
                  Signing in…
                </>
              ) : (
                <>
                  Sign in
                  <ArrowRightIcon
                    className="absolute right-4 transition-transform group-hover/button:translate-x-0.5"
                    aria-hidden
                  />
                </>
              )}
            </Button>
          </form>
        </div>

        <Text variant="nudge" className="text-center">
          Questions or trouble signing in? <StudyTeamContactLink /> the study
          team.
        </Text>
      </Column>
    </StudyFlowShell>
  );
};

export default LandingPage;
