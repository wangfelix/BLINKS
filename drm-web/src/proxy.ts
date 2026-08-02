import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

const TOKEN_COOKIE_NAME = "blinks_token";
const ONBOARDING_COOKIE_NAME = "blinks_onboarding";

const redirect = (request: NextRequest, pathname: string) =>
  NextResponse.redirect(new URL(pathname, request.url));

// Optimistic route gate. The cookie keeps navigation fast, while the Express
// reconstruction endpoints independently verify the persisted auth.db state
// before returning or mutating study data.
export function proxy(request: NextRequest) {
  const pathname = request.nextUrl.pathname;
  const hasToken = request.cookies.has(TOKEN_COOKIE_NAME);
  const onboardingState = request.cookies.get(ONBOARDING_COOKIE_NAME)?.value;
  const onboardingComplete = onboardingState === "complete";

  if (pathname === "/") {
    if (!hasToken) return NextResponse.next();
    return redirect(
      request,
      onboardingComplete ? "/reconstruct" : "/onboarding",
    );
  }

  if (!hasToken) return redirect(request, "/");

  if (pathname === "/onboarding") {
    return onboardingComplete
      ? redirect(request, "/reconstruct")
      : NextResponse.next();
  }

  if (!onboardingComplete) return redirect(request, "/onboarding");
  return NextResponse.next();
}

export const config = {
  matcher: ["/", "/onboarding", "/reconstruct/:path*", "/survey", "/done"],
};
