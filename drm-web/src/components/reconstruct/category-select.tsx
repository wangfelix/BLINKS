"use client";

import type { CategoryLabel } from "@/lib/api-types";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  BriefcaseIcon,
  EllipsisIcon,
  PauseIcon,
  type LucideIcon,
} from "lucide-react";
import { mergeClassNames } from "@/lib/utils";

const CATEGORY_ITEMS: {
  icon: LucideIcon;
  label: string;
  value: CategoryLabel;
}[] = [
  { icon: BriefcaseIcon, label: "Work", value: "work" },
  { icon: PauseIcon, label: "Break", value: "break" },
  { icon: EllipsisIcon, label: "Other", value: "other" },
];

/**
 * Category semantics (study definition):
 * work  = the participant's own occupational work
 * break = an intentional, restorative pause (coffee, resting, a deliberate
 *         walk, socializing to recover)
 * other = neither work nor restorative (chores, errands, answering the door)
 */
export const CategorySelect = ({
  id,
  value,
  onChange,
  invalid = false,
  triggerClassName,
}: {
  /** Trigger element id, so a visible <Label htmlFor> can point at it. */
  id?: string;
  value: CategoryLabel | null;
  onChange: (value: CategoryLabel) => void;
  invalid?: boolean;
  triggerClassName?: string;
}) => {
  const SelectedIcon = CATEGORY_ITEMS.find(
    (item) => item.value === value,
  )?.icon;

  return (
    <Select
      items={CATEGORY_ITEMS}
      value={value}
      onValueChange={(newValue) => {
        if (newValue !== null) onChange(newValue as CategoryLabel);
      }}
    >
      <SelectTrigger
        id={id}
        className={mergeClassNames("w-full sm:w-32", triggerClassName)}
        aria-label="Activity type"
        aria-invalid={invalid || undefined}
      >
        {SelectedIcon && <SelectedIcon aria-hidden="true" />}
        <SelectValue placeholder="Category…" />
      </SelectTrigger>
      <SelectContent
        align="start"
        alignItemWithTrigger={false}
        sideOffset={6}
        className="p-1"
      >
        {CATEGORY_ITEMS.map((item) => {
          const Icon = item.icon;

          return (
            <SelectItem
              key={item.value}
              value={item.value}
              className="py-1.5 pr-8 pl-2"
            >
              <Icon aria-hidden="true" />
              {item.label}
            </SelectItem>
          );
        })}
      </SelectContent>
    </Select>
  );
};
