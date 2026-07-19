"use client";

import { ActiveRoundView } from "@/app/reconstruct/page";
import { Column, Row } from "@/components/layout/flex";
import { CategoryLegendCard } from "@/components/reconstruct/category-legend-card";
import { StudyNavbar } from "@/components/study-navbar";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { useRequireAuth } from "@/lib/use-require-auth";

const DevRoundContent = ({ round }: { round: 1 | 2 }) => (
  <main className="flex w-full flex-1 flex-col">
    <StudyNavbar />
    <section className="border-b border-amber-300 bg-amber-50 px-4 py-3">
      <Alert className="mx-auto max-w-6xl border-amber-300 bg-amber-50">
        <AlertTitle>Developer preview: round {round}</AlertTitle>
        <AlertDescription>
          This page uses the signed-in participant&apos;s real data. Edits,
          autosaves, and submissions are permanent for this development
          account.
        </AlertDescription>
      </Alert>
    </section>

    <section className="mx-auto w-full max-w-4xl flex-1 px-4 py-8 lg:max-w-6xl">
      <Row gap="xl" align="start">
        <Column gap="xl" className="min-w-0 flex-1">
          <ActiveRoundView
            round={round}
            onSubmitted={() => window.scrollTo({ top: 0 })}
          />
          <CategoryLegendCard className="lg:hidden" />
        </Column>
        <aside className="sticky top-8 hidden w-64 shrink-0 lg:block">
          <CategoryLegendCard />
        </aside>
      </Row>
    </section>
  </main>
);

export const DevRoundPage = ({ round }: { round: 1 | 2 }) => {
  const ready = useRequireAuth();
  if (!ready) return null;
  return <DevRoundContent round={round} />;
};
