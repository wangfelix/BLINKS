import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

const payoutUrlFromEnvironment = (): URL | null => {
  const configuredUrl = process.env.PAYOUT_URL?.trim();
  if (!configuredUrl) return null;

  try {
    const payoutUrl = new URL(configuredUrl);
    return payoutUrl.protocol === "https:" ? payoutUrl : null;
  } catch {
    return null;
  }
};

export function GET() {
  const payoutUrl = payoutUrlFromEnvironment();
  if (payoutUrl === null) {
    return new NextResponse("Payout link is not configured.", {
      status: 503,
      headers: { "Cache-Control": "no-store" },
    });
  }

  const response = NextResponse.redirect(payoutUrl);
  response.headers.set("Cache-Control", "no-store");
  return response;
}
