"use client";

import { OnboardingWizard } from "@/components/onboarding/onboarding-wizard";
import { StudyConfigGate } from "@/components/study-config-gate";
import { useRequireAuth } from "@/lib/use-require-auth";

const OnboardingPage = () => {
  const ready = useRequireAuth();
  if (!ready) return null;
  return (
    <StudyConfigGate>
      <OnboardingWizard />
    </StudyConfigGate>
  );
};

export default OnboardingPage;
