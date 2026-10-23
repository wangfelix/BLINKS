import { Fragment } from "react";
import { InfoIcon } from "lucide-react";

import { categoryItems } from "@/lib/category-vocabulary";

import { Separator } from "@/components/ui/separator";
import { Column, Row } from "@/components/layout/flex";
import { Text } from "@/components/layout/text";
import { mergeClassNames } from "@/lib/utils";

/**
 * Side card explaining the activity categories (definitions from the config).
 * Shown next to the reconstruction editor on wide screens, stacked below it
 * on small ones.
 */
export const CategoryLegendCard = ({ className }: { className?: string }) => (
  <Column
    gap="lg"
    className={mergeClassNames(
      "rounded-xl border bg-card p-5 shadow-xs",
      className,
    )}
  >
    <Row gap="sm" align="center">
      <InfoIcon className="size-4 text-muted-foreground" aria-hidden />
      <h3 className="text-sm font-semibold">Categories</h3>
    </Row>

    {categoryItems().map((category, index) => (
      <Fragment key={category.value}>
        {index > 0 && <Separator />}
        <Column gap="xs">
          <Text weight="medium">{category.label}</Text>
          <Text tone="muted">{category.description}</Text>
        </Column>
      </Fragment>
    ))}
  </Column>
);
