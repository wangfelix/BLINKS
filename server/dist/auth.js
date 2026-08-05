"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.verifyPassword = exports.hashPassword = void 0;
exports.issueToken = issueToken;
exports.authenticateToken = authenticateToken;
exports.participantFromAuthHeader = participantFromAuthHeader;
exports.requireAuth = requireAuth;
exports.requireAdmin = requireAdmin;
exports.requireCompletedOnboarding = requireCompletedOnboarding;
exports.requireActiveStudy = requireActiveStudy;
exports.requireAuthWithCookieFallback = requireAuthWithCookieFallback;
exports.requireAdminWithCookieFallback = requireAdminWithCookieFallback;
exports.verifyUserPassword = verifyUserPassword;
const argon2_1 = __importDefault(require("argon2"));
const crypto_1 = __importDefault(require("crypto"));
const auth_db_1 = require("./auth-db");
// argon2id is the OWASP-recommended password hash; library defaults are sane
// (argon2id, 64 MiB memory, 3 iterations).
const hashPassword = (password) => argon2_1.default.hash(password);
exports.hashPassword = hashPassword;
const verifyPassword = (passwordHash, password) => argon2_1.default.verify(passwordHash, password).catch(() => false);
exports.verifyPassword = verifyPassword;
const sha256 = (value) => crypto_1.default.createHash("sha256").update(value).digest("hex");
// Issues a fresh opaque bearer token for a user and persists only its hash.
function issueToken(username) {
    const token = crypto_1.default.randomBytes(32).toString("hex");
    (0, auth_db_1.insertToken)(sha256(token), username);
    return token;
}
// Resolves a bearer token to its participant (= username), or null.
function authenticateToken(token) {
    if (!token)
        return null;
    return (0, auth_db_1.getUsernameForTokenHash)(sha256(token)) ?? null;
}
const bearerFromHeader = (headerValue) => {
    if (!headerValue?.startsWith("Bearer "))
        return undefined;
    return headerValue.slice("Bearer ".length).trim();
};
const usernameFromAuthHeader = (headerValue) => authenticateToken(bearerFromHeader(headerValue));
const participantFromToken = (token) => {
    const username = authenticateToken(token);
    return username !== null && (0, auth_db_1.getUser)(username)?.role === "participant"
        ? username
        : null;
};
// Resolves the Authorization header of any incoming request (HTTP route or
// WebSocket upgrade) to a participant, or null.
function participantFromAuthHeader(headerValue) {
    return participantFromToken(bearerFromHeader(headerValue));
}
function requireAuth(req, res, next) {
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
function requireAdmin(req, res, next) {
    const username = usernameFromAuthHeader(req.headers.authorization);
    if (!username) {
        res.status(401).json({ error: "unauthorized" });
        return;
    }
    if ((0, auth_db_1.getUser)(username)?.role !== "admin") {
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
function requireCompletedOnboarding(req, res, next) {
    const participant = req.participant;
    if (!participant || !(0, auth_db_1.isOnboardingComplete)(participant)) {
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
function requireActiveStudy(req, res, next) {
    const participant = req.participant;
    if (participant && (0, auth_db_1.isStudyComplete)(participant)) {
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
const tokenFromCookieHeader = (cookieHeader, cookieName = "blinks_token") => {
    if (!cookieHeader)
        return undefined;
    for (const part of cookieHeader.split(";")) {
        const separatorIndex = part.indexOf("=");
        if (separatorIndex === -1)
            continue;
        const name = part.slice(0, separatorIndex).trim();
        if (name !== cookieName)
            continue;
        const rawValue = part.slice(separatorIndex + 1).trim();
        try {
            return decodeURIComponent(rawValue);
        }
        catch {
            return rawValue;
        }
    }
    return undefined;
};
// Like requireAuth, but additionally accepts the token from a blinks_token
// cookie. ONLY for GET /frames/* image serving: the DRM website renders the
// frames via <img> tags, which cannot send an Authorization header. JSON APIs
// stay header-only (CSRF hygiene: a cookie must never authorize a mutation).
function requireAuthWithCookieFallback(req, res, next) {
    const participant = participantFromAuthHeader(req.headers.authorization) ??
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
function requireAdminWithCookieFallback(req, res, next) {
    const username = usernameFromAuthHeader(req.headers.authorization) ??
        authenticateToken(tokenFromCookieHeader(req.headers.cookie, "blinks_admin_token"));
    if (!username) {
        res.status(401).json({ error: "unauthorized" });
        return;
    }
    if ((0, auth_db_1.getUser)(username)?.role !== "admin") {
        res.status(403).json({ error: "administrator access required" });
        return;
    }
    req.participant = username;
    next();
}
async function verifyUserPassword(username, password) {
    const user = (0, auth_db_1.getUser)(username);
    if (!user) {
        // Burn comparable time so a missing user is not distinguishable from a
        // wrong password by response latency.
        await argon2_1.default
            .verify("$argon2id$v=19$m=65536,t=3,p=4$AAAAAAAAAAAAAAAAAAAAAA$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA", password)
            .catch(() => false);
        return false;
    }
    return (0, exports.verifyPassword)(user.password_hash, password);
}
