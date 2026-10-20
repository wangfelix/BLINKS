import { notFound } from "next/navigation";

import { OnboardingWizard } from "@/components/onboarding/onboarding-wizard";
import { StudyConfigGate } from "@/components/study-config-gate";

const DevOnboardingPage = () => {
  if (process.env.DRM_DEV_MODE !== "1") notFound();
  return (
    <StudyConfigGate>
      <OnboardingWizard preview />
    </StudyConfigGate>
  );
};

export default DevOnboardingPage;
