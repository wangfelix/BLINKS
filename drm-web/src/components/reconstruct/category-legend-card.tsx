import { InfoIcon } from "lucide-react";

import { Separator } from "@/components/ui/separator";
import { Column, Row } from "@/components/layout/flex";
import { Text } from "@/components/layout/text";
import { mergeClassNames } from "@/lib/utils";

/**
 * Side card explaining the three activity categories (study definitions).
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

    <Column gap="xs">
      <Text className="font-medium">Work</Text>
      <Text variant="secondary">Your own occupational work.</Text>
    </Column>

    <Separator />

    <Column gap="xs">
      <Text className="font-medium">Break</Text>
      <Text variant="secondary">
        An intentional, restorative pause: coffee, resting, a deliberate walk,
        socializing to recover.
      </Text>
    </Column>

    <Separator />

    <Column gap="xs">
      <Text className="font-medium">Other</Text>
      <Text variant="secondary">
        Neither work nor restorative: chores, errands, answering the door.
      </Text>
    </Column>
  </Column>
);
