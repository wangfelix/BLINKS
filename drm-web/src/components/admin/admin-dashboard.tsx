"use client";

import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  DatabaseIcon,
  ImageIcon,
  ImagesIcon,
  LogOutIcon,
  ShieldCheckIcon,
  UserPlusIcon,
  UsersIcon,
} from "lucide-react";

import { clearStoredAdminToken, getAdminOverview } from "@/lib/admin-api";
import { mergeClassNames } from "@/lib/utils";
import { AdminPhotosView } from "@/components/admin/admin-photos-view";
import { AdminParticipantsView } from "@/components/admin/admin-participants-view";
import { AdminTablesView } from "@/components/admin/admin-tables-view";
import { BlinksLogo } from "@/components/blinks-logo";
import { StudyFlowBackground } from "@/components/study-flow-shell";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";

type AdminSection = "data" | "photos" | "participants";

const compactNumber = new Intl.NumberFormat("en", { notation: "compact" });

const Stat = ({
  icon: Icon,
  label,
  value,
}: {
  icon: typeof DatabaseIcon;
  label: string;
  value: number | undefined;
}) => (
  <div className="rounded-2xl border border-white/50 bg-background/75 p-4 shadow-sm ring-1 ring-foreground/5 backdrop-blur-xl dark:border-white/10">
    <div className="flex items-center gap-3">
      <span className="grid size-10 place-items-center rounded-xl bg-primary/8 text-primary ring-1 ring-primary/10">
        <Icon className="size-4.5" aria-hidden />
      </span>
      <div>
        <p className="text-xl font-semibold tracking-tight tabular-nums">
          {value === undefined ? "—" : compactNumber.format(value)}
        </p>
        <p className="text-xs text-muted-foreground">{label}</p>
      </div>
    </div>
  </div>
);

export const AdminDashboard = ({
  username,
  onSignOut,
}: {
  username: string;
  onSignOut: () => void;
}) => {
  const queryClient = useQueryClient();
  const [section, setSection] = useState<AdminSection>("data");
  const overviewQuery = useQuery({
    queryKey: ["admin", "overview"],
    queryFn: getAdminOverview,
  });

  const signOut = () => {
    clearStoredAdminToken();
    queryClient.removeQueries({ queryKey: ["admin"] });
    onSignOut();
  };

  const sections: {
    id: AdminSection;
    label: string;
    icon: typeof DatabaseIcon;
  }[] = [
    { id: "data", label: "Data tables", icon: DatabaseIcon },
    { id: "photos", label: "Photos", icon: ImagesIcon },
    { id: "participants", label: "Participants", icon: UserPlusIcon },
  ];

  return (
    <main className="relative min-h-dvh overflow-x-clip bg-background">
      <StudyFlowBackground />

      <header className="sticky top-0 z-40 border-b border-border/60 bg-background/70 backdrop-blur-xl">
        <div className="flex min-h-16 w-full flex-wrap items-center justify-between gap-3 px-4 py-2 sm:px-8">
          <div className="flex items-center gap-3">
            <BlinksLogo className="h-10 w-[140px]" sizes="140px" priority />
            <Badge variant="secondary" className="hidden sm:inline-flex">
              <ShieldCheckIcon aria-hidden />
              Research admin
            </Badge>
          </div>
          <div className="flex items-center gap-2">
            <span className="hidden text-sm text-muted-foreground sm:inline">
              {username}
            </span>
            <Button variant="ghost" size="sm" onClick={signOut}>
              <LogOutIcon aria-hidden />
              Sign out
            </Button>
          </div>
        </div>
      </header>

      <div className="relative z-10 mx-auto w-full max-w-[1600px] px-4 py-7 sm:px-6 sm:py-10 lg:px-8">
        <div className="flex flex-col gap-8">
          <section className="flex flex-col justify-between gap-4 lg:flex-row lg:items-end">
            <div>
              <p className="text-xs font-semibold tracking-[0.16em] text-muted-foreground uppercase">
                BLINKS study operations
              </p>
              <h1 className="mt-2 text-3xl font-semibold tracking-tight sm:text-4xl">
                Research dashboard
              </h1>
              <p className="mt-2 max-w-2xl text-sm leading-relaxed text-muted-foreground sm:text-base">
                A read-only view of study data and anonymized photos, plus
                controlled participant account provisioning.
              </p>
            </div>

            <nav
              className="flex w-full gap-1 rounded-2xl border border-border/70 bg-background/70 p-1.5 shadow-sm backdrop-blur-xl lg:w-auto"
              aria-label="Admin sections"
            >
              {sections.map(({ id, label, icon: Icon }) => (
                <button
                  key={id}
                  type="button"
                  onClick={() => setSection(id)}
                  className={mergeClassNames(
                    "flex min-h-10 flex-1 items-center justify-center gap-2 rounded-xl px-3 text-sm font-medium transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring lg:flex-none",
                    section === id
                      ? "bg-foreground text-background shadow-sm"
                      : "text-muted-foreground hover:bg-muted hover:text-foreground",
                  )}
                  aria-current={section === id ? "page" : undefined}
                >
                  <Icon className="size-4" aria-hidden />
                  {label}
                </button>
              ))}
            </nav>
          </section>

          <section
            className="grid grid-cols-2 gap-3 lg:grid-cols-4"
            aria-label="Study data summary"
          >
            <Stat
              icon={DatabaseIcon}
              label="Database rows"
              value={
                overviewQuery.data === undefined
                  ? undefined
                  : Object.values(overviewQuery.data.tableCounts).reduce(
                      (sum, count) => sum + count,
                      0,
                    )
              }
            />
            <Stat
              icon={UsersIcon}
              label="Participant profiles"
              value={overviewQuery.data?.participantCount}
            />
            <Stat
              icon={ImageIcon}
              label="Available photos"
              value={overviewQuery.data?.availablePhotoCount}
            />
            <Stat
              icon={ImagesIcon}
              label="Recording sessions"
              value={overviewQuery.data?.sessionCount}
            />
          </section>

          {section === "data" && <AdminTablesView />}
          {section === "photos" && <AdminPhotosView />}
          {section === "participants" && <AdminParticipantsView />}
        </div>
      </div>
    </main>
  );
};
