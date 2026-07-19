import { notFound } from "next/navigation";

import { DevRoundPage } from "@/components/dev/dev-round-page";

const DevSelfPage = () => {
  if (process.env.DRM_DEV_MODE !== "1") notFound();
  return <DevRoundPage round={1} />;
};

export default DevSelfPage;
