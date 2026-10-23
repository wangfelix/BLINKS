import { TriangleAlertIcon } from "lucide-react";

import { Text } from "@/components/layout/text";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { cn } from "@/lib/utils";
import { getStudyConfig } from "@/lib/study-config-store";

export const AssistedRoundReminder = ({
  className,
}: {
  className?: string;
}) => {
  const texts = getStudyConfig().texts.rounds;
  return (
    <Alert
      className={cn(
        "border-amber-300/80 bg-amber-50/90 text-amber-950",
        className,
      )}
    >
      <TriangleAlertIcon aria-hidden />
      <AlertTitle>{texts.assistedReminderTitle}</AlertTitle>
      <AlertDescription className="text-amber-950/80">
        <Text variant="inherit">{texts.assistedReminderBody}</Text>
        {texts.assistedReminderIncorrectLabelsNotice !== null && (
          <Text variant="inherit">
            {texts.assistedReminderIncorrectLabelsNotice}
          </Text>
        )}
      </AlertDescription>
    </Alert>
  );
};
