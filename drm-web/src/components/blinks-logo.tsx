import Image from "next/image";

import { mergeClassNames } from "@/lib/utils";

interface BlinksLogoProps {
  className?: string;
  priority?: boolean;
  sizes?: string;
}

export const BlinksLogo = ({
  className,
  priority = false,
  sizes = "140px",
}: BlinksLogoProps) => (
  <span
    className={mergeClassNames(
      "relative block shrink-0 overflow-hidden",
      className,
    )}
  >
    <Image
      src="/blinks-logo.png"
      alt="BLINKS"
      fill
      priority={priority}
      sizes={sizes}
      className="object-cover object-[center_46%]"
    />
  </span>
);
