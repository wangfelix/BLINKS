"use client";

import type { CategoryIcon, CategoryLabel } from "@/lib/api-types";
import { categoryItems } from "@/lib/category-vocabulary";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  BookOpenIcon,
  BriefcaseIcon,
  CircleIcon,
  CoffeeIcon,
  EllipsisIcon,
  HeartIcon,
  HouseIcon,
  PauseIcon,
  UsersIcon,
  type LucideIcon,
} from "lucide-react";
import { mergeClassNames } from "@/lib/utils";

/** lucide-react component for each icon name of the config allowlist. */
const CATEGORY_ICONS: Record<CategoryIcon, LucideIcon> = {
  briefcase: BriefcaseIcon,
  pause: PauseIcon,
  ellipsis: EllipsisIcon,
  coffee: CoffeeIcon,
  users: UsersIcon,
  house: HouseIcon,
  "book-open": BookOpenIcon,
  heart: HeartIcon,
  circle: CircleIcon,
};

/**
 * Activity-type dropdown. Labels, icons and order come from the study config
 * (`categories[]`); the definitions are shown in CategoryLegendCard.
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
  const items = categoryItems().map((item) => ({
    ...item,
    icon: CATEGORY_ICONS[item.icon] ?? CircleIcon,
  }));
  const SelectedIcon = items.find((item) => item.value === value)?.icon;

  return (
    <Select
      items={items}
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
        {items.map((item) => {
          const Icon = item.icon;

          return (
            <SelectItem
              key={item.value}
              value={item.value}
              className="py-1.5 pl-2"
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
