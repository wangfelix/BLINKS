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
import { Container } from "@/components/layout/container";
import { StudyFlowShell } from "@/components/study-flow-shell";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { InputGroup } from "@/components/ui/input";
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
    <StudyFlowShell contentClassName="flex items-center justify-center">
      <Column
        gap="xl"
        className="onboarding-step-enter onboarding-stagger w-full max-w-md"
      >
        <Column gap="sm" className="text-center">
          <Text variant="eyebrow">BLINKS study operations</Text>
          <Text as="h1" variant="title" className="sm:text-3xl">
            Research dashboard
          </Text>
          <Text tone="muted" className="leading-relaxed">
            Review research tables, export structured data, inspect anonymized
            study photos, and provision participant accounts.
          </Text>
        </Column>

        <Container size="sm" className="border-t border-border/60 pt-7">
          <header className="text-center">
            <Text as="h2" variant="heading" className="tracking-tight">
              Administrator sign-in
            </Text>
            <Text tone="muted" className="mt-1">
              Participant accounts cannot access this area.
            </Text>
          </header>

          <form onSubmit={handleSubmit} className="mt-6 space-y-5">
            <Column gap="sm">
              <Label htmlFor="admin-username">Admin profile</Label>
              <InputGroup
                icon={<UserRoundCogIcon />}
                size="xl"
                surface="frosted"
                id="admin-username"
                name="username"
                autoComplete="username"
                autoFocus
                value={username}
                onChange={(event) => setUsername(event.target.value)}
              />
            </Column>

            <Column gap="sm">
              <Label htmlFor="admin-password">Password</Label>
              <InputGroup
                icon={<LockKeyholeIcon />}
                action={
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    className="text-muted-foreground"
                    onClick={() => setShowPassword((visible) => !visible)}
                    aria-label={
                      showPassword ? "Hide password" : "Show password"
                    }
                  >
                    {showPassword ? (
                      <EyeOffIcon aria-hidden />
                    ) : (
                      <EyeIcon aria-hidden />
                    )}
                  </Button>
                }
                size="xl"
                surface="frosted"
                id="admin-password"
                name="password"
                type={showPassword ? "text" : "password"}
                autoComplete="current-password"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
              />
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
              size="xl"
              className="relative w-full shadow-md"
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
        </Container>
      </Column>
    </StudyFlowShell>
  );
};
