import { notFound } from "next/navigation";

import { OnboardingWizard } from "@/components/onboarding/onboarding-wizard";

const DevOnboardingPage = () => {
  if (process.env.DRM_DEV_MODE !== "1") notFound();
  return <OnboardingWizard preview />;
};

export default DevOnboardingPage;
