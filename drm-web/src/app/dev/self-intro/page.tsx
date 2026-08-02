import { notFound } from "next/navigation";

import { DevIntroPage } from "@/components/dev/dev-intro-page";

const DevSelfIntroPage = () => {
  if (process.env.DRM_DEV_MODE !== "1") notFound();
  return <DevIntroPage round={1} />;
};

export default DevSelfIntroPage;
