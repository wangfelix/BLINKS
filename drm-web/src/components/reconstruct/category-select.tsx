"use client";

import type { CategoryLabel } from "@/lib/api-types";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

const CATEGORY_ITEMS: { label: string; value: CategoryLabel }[] = [
  { label: "Work", value: "work" },
  { label: "Break", value: "break" },
  { label: "Other", value: "other" },
];

/**
 * Category semantics (study definition):
 * work  = the participant's own occupational work
 * break = an intentional, restorative pause (coffee, resting, a deliberate
 *         walk, socializing to recover)
 * other = neither work nor restorative (chores, errands, answering the door)
 */
export const CategorySelect = ({
  value,
  onChange,
  invalid = false,
}: {
  value: CategoryLabel | null;
  onChange: (value: CategoryLabel) => void;
  invalid?: boolean;
}) => (
  <Select
    items={CATEGORY_ITEMS}
    value={value}
    onValueChange={(newValue) => {
      if (newValue !== null) onChange(newValue as CategoryLabel);
    }}
  >
    <SelectTrigger
      className="w-full sm:w-32"
      aria-label="Category"
      aria-invalid={invalid || undefined}
    >
      <SelectValue placeholder="Category…" />
    </SelectTrigger>
    <SelectContent>
      {CATEGORY_ITEMS.map((item) => (
        <SelectItem key={item.value} value={item.value}>
          {item.label}
        </SelectItem>
      ))}
    </SelectContent>
  </Select>
);
