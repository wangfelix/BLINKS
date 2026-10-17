"use client";

import { useRouter } from "next/navigation";
import { StudyConfigGate } from "@/components/study-config-gate";

import { ReconstructionIntro } from "@/components/reconstruct/reconstruction-intro";

export const DevIntroPage = ({ round }: { round: 1 | 2 }) => {
  const router = useRouter();

  return (
    <StudyConfigGate>
      <ReconstructionIntro
        round={round}
        preview
        onContinue={() =>
          router.push(round === 1 ? "/dev/self" : "/dev/assisted")
        }
      />
    </StudyConfigGate>
  );
};
