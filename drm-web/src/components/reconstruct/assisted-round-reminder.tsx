import { TriangleAlertIcon } from "lucide-react";

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
        <p>{texts.assistedReminderBody}</p>
        {texts.assistedReminderIncorrectLabelsNotice !== null && (
          <p>{texts.assistedReminderIncorrectLabelsNotice}</p>
        )}
      </AlertDescription>
    </Alert>
  );
};
