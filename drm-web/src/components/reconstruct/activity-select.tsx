"use client";

import type { ActivityLabel } from "@/lib/api-types";
import { ACTIVITY_ITEMS } from "@/lib/activity-vocabulary";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

export const ActivitySelect = ({
  id,
  value,
  onChange,
  invalid = false,
}: {
  id?: string;
  value: ActivityLabel | null;
  onChange: (value: ActivityLabel) => void;
  invalid?: boolean;
}) => (
  <Select
    items={ACTIVITY_ITEMS}
    value={value}
    onValueChange={(newValue) => {
      if (newValue !== null) onChange(newValue as ActivityLabel);
    }}
  >
    <SelectTrigger
      id={id}
      className="w-full min-w-64"
      aria-label="Activity"
      aria-invalid={invalid || undefined}
    >
      <SelectValue placeholder="Choose an activity…" />
    </SelectTrigger>
    <SelectContent
      align="start"
      alignItemWithTrigger={false}
      sideOffset={6}
      className="p-1"
    >
      {ACTIVITY_ITEMS.map((item) => (
        <SelectItem
          key={item.value}
          value={item.value}
          className="py-1.5 pr-8 pl-2"
        >
          {item.label}
        </SelectItem>
      ))}
    </SelectContent>
  </Select>
);
