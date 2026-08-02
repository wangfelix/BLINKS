"use client";

import {
  Fragment,
  type FormEvent,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useRouter } from "next/navigation";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  CheckIcon,
  EyeIcon,
  EyeOffIcon,
  ExternalLinkIcon,
  KeyRoundIcon,
  LoaderCircleIcon,
  LockKeyholeIcon,
  LogOutIcon,
  RotateCcwIcon,
  ShieldCheckIcon,
  SparklesIcon,
} from "lucide-react";

import {
  changeInitialPassword,
  clearStoredToken,
  completeOnboarding,
  getOnboardingStatus,
  storeOnboardingRoutingState,
} from "@/lib/api-client";
import { surveyUrlForParticipant } from "@/lib/study-config";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import {
  StudyFlowBackground,
  StudyFlowShell,
} from "@/components/study-flow-shell";
import { Button, buttonVariants } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { mergeClassNames } from "@/lib/utils";

type WizardStep = 1 | 2 | "complete";

interface OnboardingWizardProps {
  preview?: boolean;
}

const transitionDelayMs = 460;

const PasswordVisibilityButton = ({
  visible,
  onToggle,
}: {
  visible: boolean;
  onToggle: () => void;
}) => (
  <button
    type="button"
    onClick={onToggle}
    className="absolute top-1/2 right-2 inline-flex size-8 -translate-y-1/2 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
    aria-label={visible ? "Hide password" : "Show password"}
  >
    {visible ? <EyeOffIcon aria-hidden /> : <EyeIcon aria-hidden />}
  </button>
);

const StepCheck = () => (
  <svg viewBox="0 0 24 24" className="size-4" aria-hidden>
    <path
      className="onboarding-check-path"
      d="m5 12.5 4.2 4.2L19 7"
      pathLength={1}
      fill="none"
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth="2.5"
    />
  </svg>
);

const WizardProgress = ({ step }: { step: WizardStep }) => {
  const numericStep = step === "complete" ? 3 : step;
  const steps = [
    { number: 1, label: "Secure account" },
    { number: 2, label: "Pre-study survey" },
  ];

  return (
    <ol
      className="grid grid-cols-[1fr_auto_1fr] items-start gap-3"
      aria-label="Onboarding progress"
    >
      {steps.map((item, index) => {
        const complete = numericStep > item.number;
        const active = numericStep === item.number;
        return (
          <Fragment key={item.number}>
            <li
              className={mergeClassNames(
                "flex min-w-0 flex-col items-center gap-2 text-center transition-colors duration-300",
                active || complete
                  ? "text-foreground"
                  : "text-muted-foreground",
              )}
              aria-current={active ? "step" : undefined}
            >
              <span
                className={mergeClassNames(
                  "grid size-9 place-items-center rounded-full border text-sm font-semibold shadow-sm transition-all duration-300",
                  complete &&
                    "border-primary bg-primary text-primary-foreground",
                  active &&
                    "border-primary bg-background text-primary ring-4 ring-primary/10",
                  !complete && !active && "border-border bg-muted/60",
                )}
              >
                {complete ? <StepCheck /> : item.number}
              </span>
              <span className="text-xs font-medium sm:text-sm">
                {item.label}
              </span>
            </li>
            {index === 0 && (
              <li
                className="mt-4 h-0.5 w-16 overflow-hidden rounded-full bg-border sm:w-28"
                aria-hidden
              >
                <span
                  className={mergeClassNames(
                    "block h-full origin-left rounded-full bg-primary transition-transform duration-500 ease-out motion-reduce:transition-none",
                    numericStep > 1 ? "scale-x-100" : "scale-x-0",
                  )}
                />
              </li>
            )}
          </Fragment>
        );
      })}
    </ol>
  );
};

const Requirement = ({ met, children }: { met: boolean; children: string }) => (
  <li
    className={mergeClassNames(
      "flex items-center gap-2 text-sm transition-colors duration-200",
      met ? "text-foreground" : "text-muted-foreground",
    )}
  >
    <span
      className={mergeClassNames(
        "grid size-5 place-items-center rounded-full border transition-all duration-200",
        met
          ? "border-emerald-500 bg-emerald-500 text-white"
          : "border-border bg-background",
      )}
      aria-hidden
    >
      {met && <CheckIcon className="size-3.5" />}
    </span>
    {children}
  </li>
);

export const OnboardingWizard = ({
  preview = false,
}: OnboardingWizardProps) => {
  const router = useRouter();
  const queryClient = useQueryClient();
  const headingRef = useRef<HTMLHeadingElement>(null);
  const [step, setStep] = useState<WizardStep | null>(preview ? 1 : null);
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [passwordVisible, setPasswordVisible] = useState(false);
  const [validationError, setValidationError] = useState<string | null>(null);
  const [passwordSaved, setPasswordSaved] = useState(false);
  const [questionnaireOpened, setQuestionnaireOpened] = useState(false);

  const statusQuery = useQuery({
    queryKey: ["onboarding"],
    queryFn: getOnboardingStatus,
    enabled: !preview,
    retry: false,
  });

  const username = preview
    ? "demo-preview"
    : (statusQuery.data?.username ?? "participant");
  const surveyUrl = surveyUrlForParticipant("onboarding", username);

  useEffect(() => {
    if (preview || statusQuery.data === undefined) return;
    storeOnboardingRoutingState(statusQuery.data.completed);
  }, [preview, statusQuery.data]);

  const activeStep =
    step ??
    (statusQuery.data === undefined
      ? null
      : statusQuery.data.completed
        ? "complete"
        : statusQuery.data.mustChangePassword
          ? 1
          : 2);

  useEffect(() => {
    if (activeStep === null || passwordSaved) return;
    const frame = window.requestAnimationFrame(() => {
      headingRef.current?.focus({ preventScroll: true });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [activeStep, passwordSaved]);

  const passwordHasMinimumLength = newPassword.length >= 8;
  const passwordsMatch =
    confirmPassword.length > 0 && newPassword === confirmPassword;
  const passwordValid = passwordHasMinimumLength && passwordsMatch;

  const strength = useMemo(() => {
    if (newPassword.length === 0) return 0;
    let score = newPassword.length >= 8 ? 1 : 0;
    if (newPassword.length >= 12) score += 1;
    if (/[A-Za-z]/.test(newPassword) && /\d/.test(newPassword)) score += 1;
    if (/[^A-Za-z0-9]/.test(newPassword)) score += 1;
    return Math.max(1, score);
  }, [newPassword]);
  const strengthLabel = ["", "Developing", "Good", "Strong", "Very strong"][
    strength
  ];

  const advanceAfterPassword = (alreadyCompleted: boolean) => {
    setPasswordSaved(true);
    window.setTimeout(() => {
      setPasswordSaved(false);
      setStep(alreadyCompleted ? "complete" : 2);
    }, transitionDelayMs);
  };

  const passwordMutation = useMutation({
    mutationFn: () => changeInitialPassword(newPassword),
    onSuccess: (response) => {
      storeOnboardingRoutingState(response.completed);
      queryClient.setQueryData(["onboarding"], response);
      advanceAfterPassword(response.completed);
    },
  });

  const completionMutation = useMutation({
    mutationFn: completeOnboarding,
    onSuccess: (response) => {
      storeOnboardingRoutingState(true);
      queryClient.setQueryData(["onboarding"], response);
      setStep("complete");
    },
  });

  const handlePasswordSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    passwordMutation.reset();
    if (!passwordHasMinimumLength) {
      setValidationError("Use at least 8 characters.");
      return;
    }
    if (!passwordsMatch) {
      setValidationError("The two passwords do not match.");
      return;
    }
    setValidationError(null);
    if (preview) {
      advanceAfterPassword(false);
    } else {
      passwordMutation.mutate();
    }
  };

  const handleComplete = () => {
    if (!questionnaireOpened) return;
    if (preview) {
      setStep("complete");
    } else {
      completionMutation.mutate();
    }
  };

  const handleRestartPreview = () => {
    setNewPassword("");
    setConfirmPassword("");
    setPasswordVisible(false);
    setValidationError(null);
    setPasswordSaved(false);
    setQuestionnaireOpened(false);
    setStep(1);
  };

  const handleSignOut = () => {
    clearStoredToken();
    queryClient.clear();
    router.replace("/");
  };

  const passwordError =
    validationError ??
    (passwordMutation.isError
      ? passwordMutation.error instanceof Error
        ? passwordMutation.error.message
        : "The password could not be saved."
      : null);

  if (!preview && (statusQuery.isPending || activeStep === null)) {
    return (
      <main className="relative grid min-h-dvh place-items-center overflow-hidden px-4 py-10">
        <StudyFlowBackground />
        <div className="relative flex items-center gap-2 rounded-full border bg-background/80 px-5 py-3 text-sm text-muted-foreground shadow-lg backdrop-blur-xl">
          <LoaderCircleIcon className="animate-spin" aria-hidden />
          Preparing your account…
        </div>
      </main>
    );
  }

  if (!preview && statusQuery.isError) {
    return (
      <main className="relative grid min-h-dvh place-items-center overflow-hidden px-4 py-10">
        <StudyFlowBackground />
        <Alert
          variant="destructive"
          className="relative max-w-md bg-background/90 backdrop-blur-xl"
        >
          <AlertTitle>Onboarding unavailable</AlertTitle>
          <AlertDescription>
            Your account status could not be loaded. Please refresh the page or
            contact the study team.
          </AlertDescription>
        </Alert>
      </main>
    );
  }

  return (
    <StudyFlowShell
      progress={<WizardProgress step={activeStep!} />}
      headerTrailing={
        preview ? (
          <span className="rounded-full border border-amber-300 bg-amber-100 px-3 py-1 text-xs font-semibold text-amber-900">
            Developer preview
          </span>
        ) : (
          <Button variant="ghost" size="sm" onClick={handleSignOut}>
            Sign out
          </Button>
        )
      }
    >
      {passwordSaved ? (
        <div
          className="onboarding-success-enter flex min-h-[350px] flex-col items-center justify-center text-center"
          aria-live="polite"
        >
          <span className="onboarding-success-ring grid size-20 place-items-center rounded-full bg-emerald-500 text-white shadow-lg shadow-emerald-500/25">
            <CheckIcon className="size-9" strokeWidth={2.5} aria-hidden />
          </span>
          <h2 className="mt-6 text-2xl font-semibold tracking-tight">
            Password saved
          </h2>
          <p className="mt-2 text-sm text-muted-foreground">
            Your participant account is now secured.
          </p>
        </div>
      ) : activeStep === 1 ? (
        <div
          key="password"
          className="onboarding-step-enter onboarding-stagger mx-auto max-w-xl"
        >
          <div className="mb-7 flex items-start gap-4">
            <span className="grid size-12 shrink-0 place-items-center rounded-2xl bg-primary/10 text-primary ring-1 ring-primary/10">
              <LockKeyholeIcon className="size-5" aria-hidden />
            </span>
            <div>
              <h1
                ref={headingRef}
                tabIndex={-1}
                className="text-2xl font-semibold tracking-tight outline-none sm:text-3xl"
              >
                Choose your own password
              </h1>
              <p className="mt-2 text-sm leading-relaxed text-muted-foreground sm:text-base">
                Replace the temporary password from the study team with a
                private password only you know.
              </p>
            </div>
          </div>

          <form onSubmit={handlePasswordSubmit} className="space-y-5">
            <div className="space-y-2">
              <Label htmlFor="new-password">New password</Label>
              <div className="relative">
                <Input
                  id="new-password"
                  name="new-password"
                  type={passwordVisible ? "text" : "password"}
                  autoComplete="new-password"
                  autoFocus
                  value={newPassword}
                  onChange={(event) => {
                    setNewPassword(event.target.value);
                    setValidationError(null);
                    passwordMutation.reset();
                  }}
                  className="h-11 pr-11"
                  aria-invalid={passwordError !== null}
                />
                <PasswordVisibilityButton
                  visible={passwordVisible}
                  onToggle={() => setPasswordVisible((value) => !value)}
                />
              </div>
            </div>

            <div className="space-y-2">
              <Label htmlFor="confirm-password">Confirm password</Label>
              <div className="relative">
                <Input
                  id="confirm-password"
                  name="confirm-password"
                  type={passwordVisible ? "text" : "password"}
                  autoComplete="new-password"
                  value={confirmPassword}
                  onChange={(event) => {
                    setConfirmPassword(event.target.value);
                    setValidationError(null);
                    passwordMutation.reset();
                  }}
                  className="h-11 pr-11"
                  aria-invalid={passwordError !== null}
                />
                <PasswordVisibilityButton
                  visible={passwordVisible}
                  onToggle={() => setPasswordVisible((value) => !value)}
                />
              </div>
            </div>

            <div className="rounded-2xl border bg-muted/25 p-4">
              <div className="flex items-center justify-between gap-3 text-xs">
                <span className="font-medium">Password strength</span>
                <span className="text-muted-foreground">
                  {strengthLabel || "Start typing"}
                </span>
              </div>
              <div className="mt-2 grid grid-cols-4 gap-1.5" aria-hidden>
                {[1, 2, 3, 4].map((level) => (
                  <span
                    key={level}
                    className={mergeClassNames(
                      "h-1.5 rounded-full transition-colors duration-300",
                      strength >= level ? "bg-primary" : "bg-border",
                    )}
                  />
                ))}
              </div>
              <ul className="mt-4 grid gap-2 sm:grid-cols-2">
                <Requirement met={passwordHasMinimumLength}>
                  At least 8 characters
                </Requirement>
                <Requirement met={passwordsMatch}>
                  Both entries match
                </Requirement>
              </ul>
            </div>

            <div className="min-h-5" aria-live="polite" aria-atomic="true">
              {passwordError && (
                <p className="text-sm text-destructive">{passwordError}</p>
              )}
            </div>

            <div className="flex justify-end">
              <Button
                type="submit"
                size="lg"
                className="w-full sm:w-auto"
                disabled={!passwordValid || passwordMutation.isPending}
              >
                {passwordMutation.isPending ? (
                  <>
                    <LoaderCircleIcon className="animate-spin" aria-hidden />
                    Saving password…
                  </>
                ) : (
                  <>
                    Save and continue
                    <KeyRoundIcon aria-hidden />
                  </>
                )}
              </Button>
            </div>
          </form>
        </div>
      ) : activeStep === 2 ? (
        <div
          key="survey"
          className="onboarding-step-enter onboarding-stagger mx-auto max-w-xl"
        >
          <div className="mb-8 flex items-start gap-4">
            <span className="grid size-12 shrink-0 place-items-center rounded-2xl bg-violet-500/10 text-violet-700 ring-1 ring-violet-500/10 dark:text-violet-300">
              <ShieldCheckIcon className="size-5" aria-hidden />
            </span>
            <div>
              <h1
                ref={headingRef}
                tabIndex={-1}
                className="text-2xl font-semibold tracking-tight outline-none sm:text-3xl"
              >
                Complete the pre-study questionnaire
              </h1>
              <p className="mt-2 text-sm leading-relaxed text-muted-foreground sm:text-base">
                This questionnaire records the information needed before your
                field day. It opens in a separate tab. Please come back to this
                page after you finish the survey.
              </p>
            </div>
          </div>

          {surveyUrl === null ? (
            <Alert variant="destructive">
              <AlertTitle>Questionnaire not configured</AlertTitle>
              <AlertDescription>
                The pre-study questionnaire URL is missing or invalid. Please
                contact the study team.
              </AlertDescription>
            </Alert>
          ) : (
            <div className="flex items-center justify-between gap-4 rounded-2xl border bg-gradient-to-br from-primary/[0.06] to-violet-500/[0.06] p-5 sm:p-6">
              <div className="shrink-0">
                <p className="text-sm font-medium">Participant ID</p>
                <p className="mt-1 font-mono text-sm text-muted-foreground">
                  {username}
                </p>
              </div>
              <a
                href={surveyUrl}
                target="_blank"
                rel="noopener noreferrer"
                className={mergeClassNames(
                  buttonVariants({ size: "lg" }),
                  "shrink-0 shadow-md",
                )}
                onClick={() => setQuestionnaireOpened(true)}
                aria-label="Open pre-study questionnaire"
              >
                <span className="sm:hidden">Open survey</span>
                <span className="hidden sm:inline">
                  Open pre-study questionnaire
                </span>
                <ExternalLinkIcon aria-hidden />
              </a>
            </div>
          )}

          <div className="mt-6 min-h-24" aria-live="polite">
            {questionnaireOpened && (
              <div className="onboarding-confirm-enter space-y-3 border-t pt-5">
                <p className="text-sm text-muted-foreground">
                  Return here once you reach the questionnaire&apos;s
                  confirmation page.
                </p>
                <div className="flex justify-end">
                  <Button
                    variant="secondary"
                    size="lg"
                    className="w-full sm:w-auto"
                    onClick={handleComplete}
                    disabled={completionMutation.isPending}
                  >
                    {completionMutation.isPending ? (
                      <>
                        <LoaderCircleIcon
                          className="animate-spin"
                          aria-hidden
                        />
                        Completing setup…
                      </>
                    ) : (
                      "I have completed the questionnaire"
                    )}
                  </Button>
                </div>
                {completionMutation.isError && (
                  <p className="text-sm text-destructive" role="alert">
                    {completionMutation.error instanceof Error
                      ? completionMutation.error.message
                      : "Onboarding could not be completed."}
                  </p>
                )}
              </div>
            )}
          </div>
        </div>
      ) : (
        <div
          key="complete"
          className="onboarding-success-enter flex min-h-[350px] flex-col items-center justify-center text-center"
          aria-live="polite"
        >
          <span className="onboarding-success-ring grid size-20 place-items-center rounded-full bg-primary text-primary-foreground shadow-xl shadow-primary/20">
            <SparklesIcon className="size-9" aria-hidden />
          </span>
          <h1
            ref={headingRef}
            tabIndex={-1}
            className="mt-6 text-3xl font-semibold tracking-tight outline-none"
          >
            You&apos;re ready
          </h1>
          <p className="mt-3 max-w-sm text-sm leading-relaxed text-muted-foreground sm:text-base">
            Your setup is complete. You can now log out and start your recording
            day tomorrow. Log into this web application tomorrow evening to
            complete the study.
          </p>
          <div className="mt-7 flex flex-wrap justify-center gap-3">
            {preview && (
              <Button variant="secondary" onClick={handleRestartPreview}>
                <RotateCcwIcon aria-hidden />
                Restart preview
              </Button>
            )}
            <Button size="lg" onClick={handleSignOut}>
              <LogOutIcon aria-hidden />
              Log out
            </Button>
          </div>
        </div>
      )}
    </StudyFlowShell>
  );
};
