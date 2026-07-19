"use client";

import { useRouter } from "next/navigation";
import { useQuery, useQueryClient } from "@tanstack/react-query";

import { clearStoredToken, getProfile } from "@/lib/api-client";
import { Row } from "@/components/layout/flex";
import { Text } from "@/components/layout/text";
import { Button } from "@/components/ui/button";

export const StudyNavbar = () => {
  const router = useRouter();
  const queryClient = useQueryClient();
  const profileQuery = useQuery({
    queryKey: ["profile"],
    queryFn: getProfile,
  });

  const handleSignOut = () => {
    clearStoredToken();
    // Anti-leak on a shared browser: no cached participant data may survive
    // into the next account's session.
    queryClient.clear();
    router.replace("/");
  };

  return (
    <nav className="border-b bg-white" aria-label="Study navigation">
      <div className="mx-auto flex min-h-14 w-full max-w-6xl items-center justify-between gap-4 px-4 py-2">
        <span className="text-sm font-medium sm:text-base">
          BLINKS Day Reconstruction Study
        </span>
        <Row gap="sm" align="center" className="shrink-0">
          <Text variant="secondary" className="text-xs sm:text-sm">
            Participant: {profileQuery.data?.username ?? "…"}
          </Text>
          <Button variant="ghost" size="sm" onClick={handleSignOut}>
            Sign out
          </Button>
        </Row>
      </div>
    </nav>
  );
};
