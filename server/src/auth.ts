import argon2 from "argon2";
import crypto from "crypto";
import { NextFunction, Request, Response } from "express";

import {
  getUser,
  getUsernameForTokenHash,
  insertToken,
  isOnboardingComplete,
  isStudyComplete,
} from "./auth-db";

// argon2id is the OWASP-recommended password hash; library defaults are sane
// (argon2id, 64 MiB memory, 3 iterations).
export const hashPassword = (password: string): Promise<string> =>
  argon2.hash(password);

export const verifyPassword = (
  passwordHash: string,
  password: string,
): Promise<boolean> => argon2.verify(passwordHash, password).catch(() => false);

const sha256 = (value: string): string =>
  crypto.createHash("sha256").update(value).digest("hex");

// Issues a fresh opaque bearer token for a user and persists only its hash.
export function issueToken(username: string): string {
  const token = crypto.randomBytes(32).toString("hex");
  insertToken(sha256(token), username);
  return token;
}

// Resolves a bearer token to its participant (= username), or null.
export function authenticateToken(token: string | undefined): string | null {
  if (!token) return null;
  return getUsernameForTokenHash(sha256(token)) ?? null;
}

const bearerFromHeader = (
  headerValue: string | undefined,
): string | undefined => {
  if (!headerValue?.startsWith("Bearer ")) return undefined;
  return headerValue.slice("Bearer ".length).trim();
};

const usernameFromAuthHeader = (
  headerValue: string | undefined,
): string | null => authenticateToken(bearerFromHeader(headerValue));

const participantFromToken = (token: string | undefined): string | null => {
  const username = authenticateToken(token);
  return username !== null && getUser(username)?.role === "participant"
    ? username
    : null;
};

// Resolves the Authorization header of any incoming request (HTTP route or
// WebSocket upgrade) to a participant, or null.
export function participantFromAuthHeader(
  headerValue: string | undefined,
): string | null {
  return participantFromToken(bearerFromHeader(headerValue));
}

// Express middleware: requires a valid bearer token and attaches the
// participant to the request.
export interface AuthenticatedRequest extends Request {
  participant?: string;
}

export function requireAuth(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
): void {
  const participant = participantFromAuthHeader(req.headers.authorization);
  if (!participant) {
    res.status(401).json({ error: "unauthorized" });
    return;
  }
  req.participant = participant;
  next();
}

// Research administration uses the same opaque token store, but a persisted
// role check keeps admin APIs and participant APIs mutually exclusive.
export function requireAdmin(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
): void {
  const username = usernameFromAuthHeader(req.headers.authorization);
  if (!username) {
    res.status(401).json({ error: "unauthorized" });
    return;
  }
  if (getUser(username)?.role !== "admin") {
    res.status(403).json({ error: "administrator access required" });
    return;
  }
  req.participant = username;
  next();
}

// Secure authorization gate for the DRM web workflow. The Next.js proxy also
// performs an optimistic redirect for a smooth first-run experience, but this
// database-backed check is the authoritative protection against bypassing the
// onboarding wizard.
export function requireCompletedOnboarding(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
): void {
  const participant = req.participant;
  if (!participant || !isOnboardingComplete(participant)) {
    res.status(403).json({
      error: "onboarding required",
      code: "onboarding_required",
    });
    return;
  }
  next();
}

// Completed participants retain authenticated access to their profile and
// photo-management APIs, but the reconstruction workflow is permanently
// closed after they confirm the final questionnaire.
export function requireActiveStudy(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
): void {
  const participant = req.participant;
  if (participant && isStudyComplete(participant)) {
    res.status(403).json({
      error: "the study is already complete",
      code: "study_completed",
    });
    return;
  }
  next();
}

// Extracts the blinks_token cookie value from a raw Cookie header. Parsed by
// hand (no cookie-parser dependency): split on ';', first '=' separates name
// from value.
const tokenFromCookieHeader = (
  cookieHeader: string | undefined,
  cookieName = "blinks_token",
): string | undefined => {
  if (!cookieHeader) return undefined;
  for (const part of cookieHeader.split(";")) {
    const separatorIndex = part.indexOf("=");
    if (separatorIndex === -1) continue;
    const name = part.slice(0, separatorIndex).trim();
    if (name !== cookieName) continue;
    const rawValue = part.slice(separatorIndex + 1).trim();
    try {
      return decodeURIComponent(rawValue);
    } catch {
      return rawValue;
    }
  }
  return undefined;
};

// Like requireAuth, but additionally accepts the token from a blinks_token
// cookie. ONLY for GET /frames/* image serving: the DRM website renders the
// frames via <img> tags, which cannot send an Authorization header. JSON APIs
// stay header-only (CSRF hygiene: a cookie must never authorize a mutation).
export function requireAuthWithCookieFallback(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
): void {
  const participant =
    participantFromAuthHeader(req.headers.authorization) ??
    participantFromToken(tokenFromCookieHeader(req.headers.cookie));
  if (!participant) {
    res.status(401).json({ error: "unauthorized" });
    return;
  }
  req.participant = participant;
  next();
}

// Browser image elements cannot set Authorization. This cookie fallback is
// restricted to the read-only admin JPEG route; admin JSON remains header-only.
export function requireAdminWithCookieFallback(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
): void {
  const username =
    usernameFromAuthHeader(req.headers.authorization) ??
    authenticateToken(
      tokenFromCookieHeader(req.headers.cookie, "blinks_admin_token"),
    );
  if (!username) {
    res.status(401).json({ error: "unauthorized" });
    return;
  }
  if (getUser(username)?.role !== "admin") {
    res.status(403).json({ error: "administrator access required" });
    return;
  }
  req.participant = username;
  next();
}

export async function verifyUserPassword(
  username: string,
  password: string,
): Promise<boolean> {
  const user = getUser(username);
  if (!user) {
    // Burn comparable time so a missing user is not distinguishable from a
    // wrong password by response latency.
    await argon2
      .verify(
        "$argon2id$v=19$m=65536,t=3,p=4$AAAAAAAAAAAAAAAAAAAAAA$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
        password,
      )
      .catch(() => false);
    return false;
  }
  return verifyPassword(user.password_hash, password);
}
