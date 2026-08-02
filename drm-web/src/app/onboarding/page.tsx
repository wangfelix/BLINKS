"use client";

import { OnboardingWizard } from "@/components/onboarding/onboarding-wizard";
import { useRequireAuth } from "@/lib/use-require-auth";

const OnboardingPage = () => {
  const ready = useRequireAuth();
  if (!ready) return null;
  return <OnboardingWizard />;
};

export default OnboardingPage;
