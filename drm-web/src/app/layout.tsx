import type { Metadata } from "next";
import "./globals.css";

import { DevNavigator } from "@/components/dev/dev-navigator";
import { Providers } from "@/components/providers";

export const metadata: Metadata = {
  title: "BLINKS — Day Reconstruction Study",
  description:
    "Evening day reconstruction for the BLINKS study (KIT, KD2School / KD2Lab).",
};

const RootLayout = ({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) => {
  const devMode = process.env.DRM_DEV_MODE === "1";

  return (
    <html lang="en" className="h-full antialiased">
      <body className="flex min-h-full flex-col bg-background text-foreground">
        <Providers>
          {children}
          {devMode && <DevNavigator />}
        </Providers>
      </body>
    </html>
  );
};

export default RootLayout;
