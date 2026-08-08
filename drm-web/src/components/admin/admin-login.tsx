"use client";

import { type FormEvent, useState } from "react";
import { useMutation } from "@tanstack/react-query";
import {
  ArrowRightIcon,
  EyeIcon,
  EyeOffIcon,
  LoaderCircleIcon,
  LockKeyholeIcon,
  ShieldCheckIcon,
  UserRoundCogIcon,
} from "lucide-react";

import {
  adminLogin,
  storeAdminToken,
  type AdminLoginResponse,
} from "@/lib/admin-api";
import { Column } from "@/components/layout/flex";
import { Text } from "@/components/layout/text";
import { StudyFlowShell } from "@/components/study-flow-shell";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

export const AdminLogin = ({
  onSuccess,
}: {
  onSuccess: (response: AdminLoginResponse) => void;
}) => {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);

  const mutation = useMutation({
    mutationFn: () => adminLogin(username.trim(), password),
    onSuccess: (response) => {
      storeAdminToken(response.token);
      onSuccess(response);
    },
  });

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!username.trim() || !password || mutation.isPending) return;
    mutation.mutate();
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
          <Text variant="eyebrow">BLINKS study operations</Text>
          <h1 className="text-2xl font-semibold tracking-tight sm:text-3xl">
            Research dashboard
          </h1>
          <Text variant="secondary" className="leading-relaxed">
            Review research tables, export structured data, inspect anonymized
            study photos, and provision participant accounts.
          </Text>
        </Column>

        <div className="mx-auto w-full max-w-sm border-t border-border/60 pt-7">
          <div className="text-center">
            <h2 className="text-lg font-semibold tracking-tight">
              Administrator sign-in
            </h2>
            <p className="mt-1 text-sm text-muted-foreground">
              Participant accounts cannot access this area.
            </p>
          </div>

          <form onSubmit={handleSubmit} className="mt-6 space-y-5">
            <Column gap="sm">
              <Label htmlFor="admin-username">Admin profile</Label>
              <div className="relative">
                <UserRoundCogIcon
                  className="pointer-events-none absolute top-1/2 left-4 size-4 -translate-y-1/2 text-muted-foreground"
                  aria-hidden
                />
                <Input
                  id="admin-username"
                  name="username"
                  autoComplete="username"
                  autoFocus
                  value={username}
                  onChange={(event) => setUsername(event.target.value)}
                  className="h-12 rounded-xl border-border/70 bg-background/60 pr-4 pl-11 text-base backdrop-blur-sm hover:bg-background/80 focus-visible:bg-background"
                />
              </div>
            </Column>

            <Column gap="sm">
              <Label htmlFor="admin-password">Password</Label>
              <div className="relative">
                <LockKeyholeIcon
                  className="pointer-events-none absolute top-1/2 left-4 size-4 -translate-y-1/2 text-muted-foreground"
                  aria-hidden
                />
                <Input
                  id="admin-password"
                  name="password"
                  type={showPassword ? "text" : "password"}
                  autoComplete="current-password"
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                  className="h-12 rounded-xl border-border/70 bg-background/60 pr-12 pl-11 text-base backdrop-blur-sm hover:bg-background/80 focus-visible:bg-background"
                />
                <button
                  type="button"
                  onClick={() => setShowPassword((visible) => !visible)}
                  className="absolute top-1/2 right-2 grid size-8 -translate-y-1/2 place-items-center rounded-lg text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
                  aria-label={showPassword ? "Hide password" : "Show password"}
                >
                  {showPassword ? (
                    <EyeOffIcon className="size-4" aria-hidden />
                  ) : (
                    <EyeIcon className="size-4" aria-hidden />
                  )}
                </button>
              </div>
            </Column>

            {mutation.isError && (
              <Alert variant="destructive" aria-live="polite">
                <AlertTitle>Sign-in failed</AlertTitle>
                <AlertDescription>
                  {mutation.error instanceof Error
                    ? mutation.error.message
                    : "Please try again."}
                </AlertDescription>
              </Alert>
            )}

            <Button
              type="submit"
              className="relative h-12 w-full rounded-xl text-base shadow-md"
              disabled={!username.trim() || !password || mutation.isPending}
            >
              {mutation.isPending ? (
                <>
                  <LoaderCircleIcon className="animate-spin" aria-hidden />
                  Signing in…
                </>
              ) : (
                <>
                  Open dashboard
                  <ArrowRightIcon className="absolute right-4" aria-hidden />
                </>
              )}
            </Button>
          </form>
        </div>
      </Column>
    </StudyFlowShell>
  );
};
