import { TriangleAlertIcon } from "lucide-react";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { cn } from "@/lib/utils";

export const AssistedRoundReminder = ({
  className,
}: {
  className?: string;
}) => (
  <Alert
    className={cn(
      "border-amber-300/80 bg-amber-50/90 text-left text-amber-950 dark:border-amber-400/40 dark:bg-amber-950/30 dark:text-amber-100",
      className,
    )}
  >
    <TriangleAlertIcon aria-hidden />
    <AlertTitle>Reconstruct your whole day, not just the photos</AlertTitle>
    <AlertDescription className="text-amber-950/80 dark:text-amber-100/80">
      <p>
          Your task is to submit as accurate a reconstruction of your day as you can using this assistance. If you remember an activity that is missing from this list, use “Insert activity” to add it, e.g. if the camera was paused or no photos were captured at that time. You do not need to add activities you do not remember.
      </p>
      <p>
        Also note: Some activity labels and activity types are deliberately incorrect.
        Review and correct anything that does not match your day.
      </p>
    </AlertDescription>
  </Alert>
);
