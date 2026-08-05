"use client";

import { type FormEvent, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
  CheckCircle2Icon,
  EyeIcon,
  EyeOffIcon,
  KeyRoundIcon,
  LoaderCircleIcon,
  LockKeyholeIcon,
  UserPlusIcon,
  UserRoundIcon,
} from "lucide-react";

import { createAdminParticipant } from "@/lib/admin-api";
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

export const AdminParticipantsView = () => {
  const queryClient = useQueryClient();
  const [participantId, setParticipantId] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [validationError, setValidationError] = useState<string | null>(null);
  const [createdParticipant, setCreatedParticipant] = useState<string | null>(
    null,
  );

  const mutation = useMutation({
    mutationFn: () => createAdminParticipant(participantId.trim(), password),
    onSuccess: (response) => {
      setCreatedParticipant(response.username);
      setParticipantId("");
      setPassword("");
      setConfirmPassword("");
      setValidationError(null);
      void queryClient.invalidateQueries({ queryKey: ["admin", "overview"] });
    },
  });

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    mutation.reset();
    setCreatedParticipant(null);
    const normalizedId = participantId.trim();
    if (!/^[a-zA-Z0-9_-]+$/.test(normalizedId)) {
      setValidationError(
        "Use only letters, digits, hyphens, and underscores for the participant ID.",
      );
      return;
    }
    if (password.length < 8) {
      setValidationError(
        "Use at least 8 characters for the temporary password.",
      );
      return;
    }
    if (password !== confirmPassword) {
      setValidationError("The two password entries do not match.");
      return;
    }
    setValidationError(null);
    mutation.mutate();
  };

  const error =
    validationError ??
    (mutation.isError
      ? mutation.error instanceof Error
        ? mutation.error.message
        : "The participant could not be created."
      : null);

  return (
    <section className="space-y-4" aria-labelledby="participants-heading">
      <div>
        <p className="text-xs font-semibold tracking-[0.14em] text-muted-foreground uppercase">
          Account provisioning
        </p>
        <h2 id="participants-heading" className="mt-1 text-2xl font-semibold">
          Participants
        </h2>
        <p className="mt-1 text-sm text-muted-foreground">
          Create a participant login and its matching recordings profile in one
          controlled step.
        </p>
      </div>

      <div className="max-w-4xl">
        <Card className="rounded-2xl bg-background/82 shadow-lg backdrop-blur-xl">
          <CardHeader className="border-b border-border/70">
            <CardTitle className="flex items-center gap-2">
              <UserPlusIcon className="size-4.5" aria-hidden />
              Create participant
            </CardTitle>
            <CardDescription>
              Existing IDs are never overwritten. The temporary password must be
              replaced on first sign-in.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <form onSubmit={handleSubmit} className="space-y-5">
              <div className="space-y-2">
                <Label htmlFor="new-participant-id">Participant ID</Label>
                <div className="relative">
                  <UserRoundIcon
                    className="pointer-events-none absolute top-1/2 left-4 size-4 -translate-y-1/2 text-muted-foreground"
                    aria-hidden
                  />
                  <Input
                    id="new-participant-id"
                    name="participantId"
                    autoComplete="off"
                    value={participantId}
                    onChange={(event) => setParticipantId(event.target.value)}
                    placeholder="participant21"
                    className="h-11 rounded-xl bg-background pl-11"
                  />
                </div>
                <p className="text-xs text-muted-foreground">
                  Letters, digits, hyphens, and underscores only.
                </p>
              </div>

              <div className="grid gap-4 sm:grid-cols-2">
                <div className="space-y-2">
                  <Label htmlFor="new-participant-password">
                    Temporary password
                  </Label>
                  <div className="relative">
                    <LockKeyholeIcon
                      className="pointer-events-none absolute top-1/2 left-4 size-4 -translate-y-1/2 text-muted-foreground"
                      aria-hidden
                    />
                    <Input
                      id="new-participant-password"
                      name="password"
                      type={showPassword ? "text" : "password"}
                      autoComplete="new-password"
                      value={password}
                      onChange={(event) => setPassword(event.target.value)}
                      className="h-11 rounded-xl bg-background pr-11 pl-11"
                    />
                    <button
                      type="button"
                      onClick={() => setShowPassword((visible) => !visible)}
                      className="absolute top-1/2 right-2 grid size-8 -translate-y-1/2 place-items-center rounded-lg text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
                      aria-label={
                        showPassword
                          ? "Hide temporary password"
                          : "Show temporary password"
                      }
                    >
                      {showPassword ? (
                        <EyeOffIcon className="size-4" aria-hidden />
                      ) : (
                        <EyeIcon className="size-4" aria-hidden />
                      )}
                    </button>
                  </div>
                </div>

                <div className="space-y-2">
                  <Label htmlFor="confirm-participant-password">
                    Confirm password
                  </Label>
                  <div className="relative">
                    <KeyRoundIcon
                      className="pointer-events-none absolute top-1/2 left-4 size-4 -translate-y-1/2 text-muted-foreground"
                      aria-hidden
                    />
                    <Input
                      id="confirm-participant-password"
                      name="confirmPassword"
                      type={showPassword ? "text" : "password"}
                      autoComplete="new-password"
                      value={confirmPassword}
                      onChange={(event) =>
                        setConfirmPassword(event.target.value)
                      }
                      className="h-11 rounded-xl bg-background pl-11"
                    />
                  </div>
                </div>
              </div>

              {error !== null && (
                <Alert variant="destructive" aria-live="polite">
                  <AlertTitle>Participant not created</AlertTitle>
                  <AlertDescription>{error}</AlertDescription>
                </Alert>
              )}

              {createdParticipant !== null && (
                <Alert
                  className="border-emerald-500/25 bg-emerald-500/5 text-emerald-900 dark:text-emerald-200"
                  aria-live="polite"
                >
                  <CheckCircle2Icon aria-hidden />
                  <AlertTitle>Participant created</AlertTitle>
                  <AlertDescription>
                    <strong>{createdParticipant}</strong> can now sign in. They
                    will replace the temporary password and complete onboarding
                    before the study workflow opens.
                  </AlertDescription>
                </Alert>
              )}

              <div className="flex justify-end">
                <Button
                  type="submit"
                  className="min-w-44 rounded-xl"
                  disabled={mutation.isPending}
                >
                  {mutation.isPending ? (
                    <>
                      <LoaderCircleIcon className="animate-spin" aria-hidden />
                      Creating…
                    </>
                  ) : (
                    <>
                      <UserPlusIcon aria-hidden />
                      Create participant
                    </>
                  )}
                </Button>
              </div>
            </form>
          </CardContent>
        </Card>
      </div>
    </section>
  );
};
