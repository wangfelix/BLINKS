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

import { sectionBarVariants } from "@/components/layout/section-bar";
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
import { InputGroup } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Row } from "@/components/layout/flex";

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
        <p className="text-xs font-semibold tracking-label text-muted-foreground uppercase">
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
          <CardHeader className={sectionBarVariants({ inset: "none" })}>
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
                <InputGroup
                  icon={<UserRoundIcon />}
                  size="lg"
                  surface="solid"
                  className="rounded-xl"
                  id="new-participant-id"
                  name="participantId"
                  autoComplete="off"
                  value={participantId}
                  onChange={(event) => setParticipantId(event.target.value)}
                  placeholder="participant21"
                />
                <p className="text-xs text-muted-foreground">
                  Letters, digits, hyphens, and underscores only.
                </p>
              </div>

              <div className="grid gap-4 sm:grid-cols-2">
                <div className="space-y-2">
                  <Label htmlFor="new-participant-password">
                    Temporary password
                  </Label>
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
                          showPassword
                            ? "Hide temporary password"
                            : "Show temporary password"
                        }
                      >
                        {showPassword ? (
                          <EyeOffIcon aria-hidden />
                        ) : (
                          <EyeIcon aria-hidden />
                        )}
                      </Button>
                    }
                    size="lg"
                    surface="solid"
                    className="rounded-xl"
                    id="new-participant-password"
                    name="password"
                    type={showPassword ? "text" : "password"}
                    autoComplete="new-password"
                    value={password}
                    onChange={(event) => setPassword(event.target.value)}
                  />
                </div>

                <div className="space-y-2">
                  <Label htmlFor="confirm-participant-password">
                    Confirm password
                  </Label>
                  <InputGroup
                    icon={<KeyRoundIcon />}
                    size="lg"
                    surface="solid"
                    className="rounded-xl"
                    id="confirm-participant-password"
                    name="confirmPassword"
                    type={showPassword ? "text" : "password"}
                    autoComplete="new-password"
                    value={confirmPassword}
                    onChange={(event) => setConfirmPassword(event.target.value)}
                  />
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
                  className="border-emerald-500/25 bg-emerald-500/5 text-emerald-900"
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

              <Row justify="end">
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
              </Row>
            </form>
          </CardContent>
        </Card>
      </div>
    </section>
  );
};
