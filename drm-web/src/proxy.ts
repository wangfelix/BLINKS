import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

const TOKEN_COOKIE_NAME = "blinks_token";
const ONBOARDING_COOKIE_NAME = "blinks_onboarding";
const STUDY_COOKIE_NAME = "blinks_study";

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
  const studyComplete =
    request.cookies.get(STUDY_COOKIE_NAME)?.value === "complete";

  if (pathname === "/") {
    if (!hasToken) return NextResponse.next();
    if (!onboardingComplete) return redirect(request, "/onboarding");
    return redirect(request, studyComplete ? "/done" : "/reconstruct");
  }

  if (!hasToken) return redirect(request, "/");

  if (pathname === "/onboarding") {
    if (!onboardingComplete) return NextResponse.next();
    return redirect(request, studyComplete ? "/done" : "/reconstruct");
  }

  if (!onboardingComplete) return redirect(request, "/onboarding");
  if (studyComplete && pathname !== "/done") {
    return redirect(request, "/done");
  }
  if (!studyComplete && pathname === "/done") {
    return redirect(request, "/reconstruct");
  }
  return NextResponse.next();
}

export const config = {
  matcher: ["/", "/onboarding", "/reconstruct/:path*", "/survey", "/done"],
};
