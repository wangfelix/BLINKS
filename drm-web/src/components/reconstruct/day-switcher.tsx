"use client";

import { LockIcon } from "lucide-react";

import type { ReconstructionDay } from "@/lib/api-types";
import { formatDayLabel, formatHour } from "@/lib/time";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

export const DaySwitcher = ({
  days,
  selectedDay,
  onSelect,
}: {
  days: ReconstructionDay[];
  selectedDay: string | null;
  onSelect: (day: string) => void;
}) => (
  <div className="flex flex-wrap gap-2">
    {days.map((day) => {
      const isSelected = day.day === selectedDay;
      return (
        <button
          key={day.day}
          type="button"
          disabled={!day.available}
          onClick={() => onSelect(day.day)}
          className={cn(
            "rounded-xl border bg-card px-3 py-2 text-left text-sm transition-colors",
            isSelected
              ? "border-primary ring-2 ring-primary/25"
              : "border-border",
            day.available && !isSelected && "hover:bg-muted",
            !day.available && "cursor-not-allowed opacity-60",
          )}
        >
          <div className="flex items-center gap-2">
            <span className="font-medium">Day {day.dayNumber}</span>
            <span className="text-muted-foreground">
              {formatDayLabel(day.day)}
            </span>
            {day.status === "submitted" && (
              <Badge variant="secondary">Submitted</Badge>
            )}
            {day.status === "draft" && <Badge variant="outline">Draft</Badge>}
          </div>
          {!day.available && (
            <div className="mt-1 flex items-center gap-1 text-xs text-muted-foreground">
              <LockIcon className="size-3" aria-hidden />
              Available from {formatHour(day.availableFromHour)}
            </div>
          )}
        </button>
      );
    })}
  </div>
);
