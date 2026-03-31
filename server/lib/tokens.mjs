import crypto from "node:crypto";

const TOKEN_DAYS = 14;

export function getAuthSecret() {
  const s = process.env.AUTH_SECRET?.trim();
  if (!s || s.length < 16) return null;
  return s;
}

export function hashPassword(password, saltB64) {
  const salt = Buffer.from(saltB64, "base64");
  return crypto.scryptSync(password, salt, 64).toString("base64");
}

function base64url(str) {
  return Buffer.from(str)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

export function signToken(payload, secret) {
  const body = base64url(JSON.stringify(payload));
  const sig = crypto.createHmac("sha256", secret).update(body).digest("base64url");
  return `${body}.${sig}`;
}

export function verifyToken(token, secret) {
  if (!token || typeof token !== "string") return null;
  const i = token.lastIndexOf(".");
  if (i <= 0) return null;
  const body = token.slice(0, i);
  const sig = token.slice(i + 1);
  const expected = crypto.createHmac("sha256", secret).update(body).digest("base64url");
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  let payload;
  try {
    payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
  } catch {
    return null;
  }
  if (payload.exp && Date.now() > payload.exp) return null;
  return payload;
}

export function newTokenPayload(userId, email, name) {
  const exp = Date.now() + TOKEN_DAYS * 24 * 60 * 60 * 1000;
  return { sub: userId, email, name: name || "", exp };
}
