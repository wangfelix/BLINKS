import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Deployed on the KIT VM behind Apache as a self-contained Node server
  // (.next/standalone) under the `blinks-web` systemd unit — see README.md.
  output: "standalone",
};

export default nextConfig;
