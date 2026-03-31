import crypto from "node:crypto";
import { signToken, verifyToken } from "./tokens.mjs";

export function devAuthEnabled() {
  const raw = String(process.env.FUEL_ALLOW_DEV_AUTH ?? "")
    .trim()
    .replace(/^\uFEFF/, "");
  const v = raw.toLowerCase();
  return v === "1" || v === "true" || v === "yes" || v === "on";
}

/**
 * Secret used to sign Fuel dev JWTs (typ === "dev"). Not the Supabase JWT.
 * Supabase-only .env often has no AUTH_SECRET — derive a stable key from the service role
 * (server-only; never exposed) so dev bypass works without extra vars.
 */
export function getDevJwtSecret() {
  const d = process.env.FUEL_DEV_JWT_SECRET?.trim();
  if (d && d.length >= 16) return d;
  const auth = process.env.AUTH_SECRET?.trim();
  if (auth && auth.length >= 16) return auth;
  const srv = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
  const url = process.env.SUPABASE_URL?.trim();
  if (srv && srv.length >= 20 && url) {
    return crypto
      .createHash("sha256")
      .update("fuel-express-dev-jwt-v1:" + srv)
      .digest("hex");
  }
  return null;
}

export function getDevHandshakeSecret() {
  return process.env.FUEL_DEV_SECRET?.trim() || null;
}

export function timingSafeStringEq(a, b) {
  if (typeof a !== "string" || typeof b !== "string") return false;
  const x = Buffer.from(a, "utf8");
  const y = Buffer.from(b, "utf8");
  if (x.length !== y.length) return false;
  return crypto.timingSafeEqual(x, y);
}

/**
 * Validates a dev JWT (typ === "dev"). Does not check FUEL_ALLOW_DEV_AUTH — that flag only
 * gates issuing new sessions (POST /auth/dev-session). Otherwise a valid dev token would be
 * rejected on /auth/me whenever the env flag was off/misread, and Supabase would try to parse it → 401.
 */
export function tryVerifyDevSession(token) {
  if (!token) return null;
  const secret = getDevJwtSecret();
  if (!secret) return null;
  const p = verifyToken(token, secret);
  if (!p || p.typ !== "dev" || !p.sub) return null;
  return p;
}

function devDashboardFromPayload(p) {
  const d = p?.dashboard;
  if (d && typeof d === "object" && !Array.isArray(d)) return { ...d };
  return {};
}

export function devUserFromPayload(p) {
  return {
    id: String(p.sub),
    email: String(p.email || "dev@localhost"),
    name: String(p.name || "Developer").slice(0, 120),
    createdAt:
      typeof p.createdAt === "string"
        ? p.createdAt
        : new Date().toISOString(),
    isAdmin: true,
    dashboard: devDashboardFromPayload(p),
  };
}

export function issueDevSession() {
  const secret = getDevJwtSecret();
  if (!secret) return null;
  const createdAt = new Date().toISOString();
  const payload = {
    sub: "fuel-dev-local",
    email: "dev@localhost",
    name: "Developer",
    createdAt,
    isAdmin: true,
    typ: "dev",
    dashboard: {},
    exp: Date.now() + 30 * 24 * 60 * 60 * 1000,
  };
  return { token: signToken(payload, secret), payload };
}

export function patchDevSessionToken(token, body, jwtSecret) {
  const p = verifyToken(token, jwtSecret);
  if (!p || p.typ !== "dev") return null;
  const name =
    typeof body?.name === "string"
      ? body.name.trim().slice(0, 120)
      : String(p.name || "Developer").slice(0, 120);
  let dashboard = devDashboardFromPayload(p);
  if (body?.dashboard && typeof body.dashboard === "object" && !Array.isArray(body.dashboard)) {
    dashboard = { ...dashboard, ...body.dashboard };
  }
  if (typeof body?.companyName === "string") {
    dashboard = { ...dashboard, companyName: body.companyName.trim().slice(0, 120) };
  }
  if (dashboard.companyName != null && typeof dashboard.companyName === "string") {
    dashboard.companyName = dashboard.companyName.trim().slice(0, 120);
  }
  const nextPayload = {
    sub: p.sub,
    email: p.email || "dev@localhost",
    name,
    createdAt: typeof p.createdAt === "string" ? p.createdAt : new Date().toISOString(),
    isAdmin: true,
    typ: "dev",
    dashboard,
    exp: Date.now() + 30 * 24 * 60 * 60 * 1000,
  };
  return {
    token: signToken(nextPayload, jwtSecret),
    user: devUserFromPayload(nextPayload),
  };
}
