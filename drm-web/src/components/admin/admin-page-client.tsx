"use client";

import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { LoaderCircleIcon } from "lucide-react";

import {
  clearStoredAdminToken,
  getAdminStatus,
  getStoredAdminToken,
} from "@/lib/admin-api";
import { AdminDashboard } from "@/components/admin/admin-dashboard";
import { AdminLogin } from "@/components/admin/admin-login";
import { StudyFlowBackground } from "@/components/study-flow-shell";

type AuthState = "checking" | "signed-out" | "signed-in";

export const AdminPageClient = () => {
  const queryClient = useQueryClient();
  const [authState, setAuthState] = useState<AuthState>("checking");

  useEffect(() => {
    const timeout = window.setTimeout(() => {
      setAuthState(getStoredAdminToken() === null ? "signed-out" : "signed-in");
    }, 0);
    return () => window.clearTimeout(timeout);
  }, []);

  const statusQuery = useQuery({
    queryKey: ["admin", "status"],
    queryFn: getAdminStatus,
    enabled: authState === "signed-in",
    retry: false,
  });

  useEffect(() => {
    if (authState !== "signed-in" || !statusQuery.isError) return;
    clearStoredAdminToken();
  }, [authState, statusQuery.isError]);

  if (
    authState === "checking" ||
    (authState === "signed-in" && statusQuery.isPending)
  ) {
    return (
      <main className="relative grid min-h-dvh place-items-center overflow-hidden px-4">
        <StudyFlowBackground />
        <div className="relative flex items-center gap-2 rounded-full border bg-background/80 px-5 py-3 text-sm text-muted-foreground shadow-lg backdrop-blur-xl">
          <LoaderCircleIcon className="animate-spin" aria-hidden />
          Verifying administrator session…
        </div>
      </main>
    );
  }

  if (authState === "signed-out" || statusQuery.data === undefined) {
    return (
      <AdminLogin
        onSuccess={(response) => {
          queryClient.setQueryData(["admin", "status"], {
            username: response.username,
            role: response.role,
          });
          setAuthState("signed-in");
        }}
      />
    );
  }

  return (
    <AdminDashboard
      username={statusQuery.data.username}
      onSignOut={() => setAuthState("signed-out")}
    />
  );
};
