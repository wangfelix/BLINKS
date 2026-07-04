import type { NextConfig } from "next";

// Where the BLINKS Express server lives, for the dev proxy below.
const apiProxyTarget = process.env.API_PROXY_TARGET ?? "http://127.0.0.1:3000";

const nextConfig: NextConfig = {
  // Deployed on the KIT VM behind Apache as a self-contained Node server
  // (.next/standalone) under the `blinks-web` systemd unit — see README.md.
  output: "standalone",
  // Dev (and fallback) proxy: the app calls the API same-origin ("" base), so
  // in development Next forwards /api, /frames, and /health to the Express
  // server. No CORS anywhere; the blinks_token cookie for <img> frames just
  // works. In production Apache routes these paths to Express before Next
  // ever sees them, so the rewrite is inert there.
  async rewrites() {
    return [
      { source: "/api/:path*", destination: `${apiProxyTarget}/api/:path*` },
      { source: "/frames/:path*", destination: `${apiProxyTarget}/frames/:path*` },
      { source: "/health", destination: `${apiProxyTarget}/health` },
    ];
  },
};

export default nextConfig;
