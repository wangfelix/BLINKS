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
// Resolves the Authorization header of any incoming request (HTTP route or
// WebSocket upgrade) to a participant, or null.
function participantFromAuthHeader(headerValue) {
    return authenticateToken(bearerFromHeader(headerValue));
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
