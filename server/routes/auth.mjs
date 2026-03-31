import express from "express";
import {
  getAuthSecret,
  signToken,
  verifyToken,
  newTokenPayload,
} from "../lib/tokens.mjs";
import {
  createUser,
  emailExists,
  findUserById,
  publicUser,
  updateUserProfile,
  verifyPassword,
  findUserByEmail,
} from "../lib/usersRepo.mjs";
import {
  isSupabaseAuthEnabled,
  registerSupabase,
  loginSupabase,
  meFromAccessToken,
  updateSupabaseProfile,
  refreshSupabaseSession,
} from "../lib/supabaseAuth.mjs";
import {
  getOrRefreshFuelSnapshot,
  refreshFuelSnapshot,
  getFuelSnapshotMeta,
} from "../lib/fuelSnapshots.mjs";
import { buildDashboardCohortPatch, refreshAllUserCohorts } from "../lib/fuelSync.mjs";
import { withRoleFlags } from "../lib/adminUsers.mjs";
import {
  devAuthEnabled,
  getDevHandshakeSecret,
  getDevJwtSecret,
  issueDevSession,
  timingSafeStringEq,
  tryVerifyDevSession,
  devUserFromPayload,
  patchDevSessionToken,
} from "../lib/devAuth.mjs";

export const authRouter = express.Router();

function bearer(req) {
  const auth = req.headers.authorization || "";
  const m = auth.match(/^Bearer\s+(.+)$/i);
  return m ? m[1].trim() : null;
}

/** Dev JWT omits localStations — recompute cohort for /me so the client sees stations after reload. */
async function devUserWithCohortFromPayload(devPayload) {
  const base = devUserFromPayload(devPayload);
  const dash =
    base.dashboard && typeof base.dashboard === "object" ? base.dashboard : {};
  const postcode = String(dash.operationPostcode || "").trim();
  const ls = dash.localStations;
  if (!postcode || (Array.isArray(ls) && ls.length > 0)) {
    return withRoleFlags(base);
  }
  try {
    const { snapshot } = await getOrRefreshFuelSnapshot();
    const cohortPatch = await buildDashboardCohortPatch(dash, snapshot);
    if (!cohortPatch) return withRoleFlags(base);
    return withRoleFlags({
      ...base,
      dashboard: { ...dash, ...cohortPatch },
    });
  } catch {
    return withRoleFlags(base);
  }
}

authRouter.post("/dev-session", async (req, res) => {
  if (!devAuthEnabled()) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  const expected = getDevHandshakeSecret();
  if (expected) {
    const got = String(req.body?.secret ?? req.body?.devSecret ?? "");
    if (!timingSafeStringEq(got, expected)) {
      res.status(401).json({ error: "Invalid dev secret" });
      return;
    }
  }
  const jwtSecret = getDevJwtSecret();
  if (!jwtSecret) {
    res.status(503).json({
      error: "Set FUEL_DEV_JWT_SECRET (16+ chars) or AUTH_SECRET to sign dev sessions",
    });
    return;
  }
  const issued = issueDevSession();
  if (!issued) {
    res.status(500).json({ error: "Could not issue dev session" });
    return;
  }
  res.json({
    token: issued.token,
    user: withRoleFlags(devUserFromPayload(issued.payload)),
  });
});

/**
 * Dev menu: refresh GOV snapshot with a dev JWT only (no ADMIN_EMAILS / isAdmin).
 * POST /admin/fuel-snapshot/refresh still requires admin for real accounts.
 */
authRouter.post("/dev-fuel-snapshot-refresh", async (req, res, next) => {
  try {
    if (!devAuthEnabled()) {
      res.status(404).json({ error: "Not found" });
      return;
    }
    const tok = bearer(req);
    if (!tok || !tryVerifyDevSession(tok)) {
      res.status(401).json({ error: "Valid dev session token required" });
      return;
    }
    const snapshot = await refreshFuelSnapshot();
    let cohorts = null;
    let cohortsError = null;
    try {
      cohorts = await refreshAllUserCohorts(snapshot);
    } catch (e) {
      cohortsError = e && e.message ? String(e.message) : "Cohort refresh failed";
    }
    res.json({
      snapshot: getFuelSnapshotMeta(),
      cohorts,
      ...(cohortsError ? { cohortsError } : {}),
    });
  } catch (e) {
    next(e);
  }
});

authRouter.post("/register", async (req, res, next) => {
  try {
    const email = String(req.body?.email || "").trim().toLowerCase();
    const password = String(req.body?.password || "");
    const name = String(req.body?.name || "").trim().slice(0, 120);
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      res.status(400).json({ error: "Valid email required" });
      return;
    }
    if (password.length < 8) {
      res.status(400).json({ error: "Password must be at least 8 characters" });
      return;
    }

    if (isSupabaseAuthEnabled()) {
      const out = await registerSupabase({ email, password, name });
      res.status(201).json({
        token: out.token,
        refresh_token: out.refresh_token,
        user: withRoleFlags(out.user),
      });
      return;
    }

    const secret = getAuthSecret();
    if (!secret) {
      res.status(503).json({ error: "Set AUTH_SECRET in server/.env (min 16 chars)" });
      return;
    }
    if (emailExists(email)) {
      res.status(409).json({ error: "An account with this email already exists" });
      return;
    }
    const user = createUser({ email, name, password });
    const token = signToken(newTokenPayload(user.id, user.email, user.name), secret);
    res.status(201).json({ token, user: withRoleFlags(publicUser(user)) });
  } catch (e) {
    const status = Number(e.status);
    if (status >= 400 && status < 600) {
      res.status(status).json({ error: e.message });
      return;
    }
    next(e);
  }
});

authRouter.post("/login", async (req, res, next) => {
  try {
    const email = String(req.body?.email || "").trim().toLowerCase();
    const password = String(req.body?.password || "");

    if (isSupabaseAuthEnabled()) {
      const out = await loginSupabase({ email, password });
      res.json({
        token: out.token,
        refresh_token: out.refresh_token,
        user: withRoleFlags(out.user),
      });
      return;
    }

    const secret = getAuthSecret();
    if (!secret) {
      res.status(503).json({ error: "Set AUTH_SECRET in server/.env (min 16 chars)" });
      return;
    }
    const user = findUserByEmail(email);
    if (!user || !verifyPassword(user, password)) {
      res.status(401).json({ error: "Invalid email or password" });
      return;
    }
    const token = signToken(newTokenPayload(user.id, user.email, user.name), secret);
    res.json({ token, user: withRoleFlags(publicUser(user)) });
  } catch (e) {
    const status = Number(e.status);
    if (status >= 400 && status < 600) {
      res.status(status).json({ error: e.message });
      return;
    }
    next(e);
  }
});

authRouter.post("/refresh", async (req, res) => {
  if (!isSupabaseAuthEnabled()) {
    res.status(400).json({ error: "Refresh is only available when Supabase auth is configured" });
    return;
  }
  const rt = String(req.body?.refresh_token || "").trim();
  if (!rt) {
    res.status(400).json({ error: "refresh_token required" });
    return;
  }
  const out = await refreshSupabaseSession(rt);
  if (!out) {
    res.status(401).json({ error: "Invalid or expired refresh token" });
    return;
  }
  res.json({ token: out.token, refresh_token: out.refresh_token });
});

authRouter.get("/me", async (req, res, next) => {
  try {
    const tok = bearer(req);
    if (!tok) {
      res.status(401).json({ error: "Missing token" });
      return;
    }

    const devPayload = tryVerifyDevSession(tok);
    if (devPayload) {
      const user = await devUserWithCohortFromPayload(devPayload);
      res.json({ user });
      return;
    }

    if (isSupabaseAuthEnabled()) {
      let user;
      try {
        user = await meFromAccessToken(tok);
      } catch (e) {
        console.warn("[auth/me] Supabase getUser failed:", e && e.message ? e.message : e);
        user = null;
      }
      if (!user) {
        res.status(401).json({ error: "Invalid or expired token" });
        return;
      }
      res.json({ user: withRoleFlags(user) });
      return;
    }

    const secret = getAuthSecret();
    if (!secret) {
      res.status(503).json({ error: "Set AUTH_SECRET in server/.env" });
      return;
    }
    const payload = verifyToken(tok, secret);
    if (!payload?.sub) {
      res.status(401).json({ error: "Invalid or expired token" });
      return;
    }
    const user = findUserById(payload.sub);
    if (!user) {
      res.status(401).json({ error: "User not found" });
      return;
    }
    res.json({ user: withRoleFlags(publicUser(user)) });
  } catch (err) {
    next(err);
  }
});

authRouter.patch("/profile", async (req, res, next) => {
  try {
    const tok = bearer(req);
    if (!tok) {
      res.status(401).json({ error: "Missing token" });
      return;
    }
    const body = req.body || {};
    const dashboardIn = body.dashboard && typeof body.dashboard === "object" ? body.dashboard : null;
    if (dashboardIn) {
      const nextOperationPostcode = String(dashboardIn.operationPostcode || "").trim();
      if (nextOperationPostcode) {
        try {
          const { snapshot } = await getOrRefreshFuelSnapshot();
          const cohortPatch = await buildDashboardCohortPatch(dashboardIn, snapshot);
          if (cohortPatch) {
            body.dashboard = { ...dashboardIn, ...cohortPatch };
          }
        } catch (snapErr) {
          console.warn(
            "[auth/profile] fuel snapshot unavailable for cohort:",
            snapErr && snapErr.message ? snapErr.message : snapErr
          );
        }
      }
    }

    const jwtSecret = getDevJwtSecret();
    if (jwtSecret) {
      // Dev JWT must stay small — do not embed hundreds of localStations in the bearer token.
      const slim = { ...body };
      if (slim.dashboard && typeof slim.dashboard === "object") {
        const ls = slim.dashboard.localStations;
        const n = Array.isArray(ls) ? ls.length : 0;
        slim.dashboard = { ...slim.dashboard };
        delete slim.dashboard.localStations;
        slim.dashboard.localStationsCount = n;
      }
      const patched = patchDevSessionToken(tok, slim, jwtSecret);
      if (patched) {
        const mergedDash =
          body.dashboard && typeof body.dashboard === "object" ? body.dashboard : {};
        res.json({
          user: withRoleFlags({
            ...patched.user,
            dashboard: { ...patched.user.dashboard, ...mergedDash },
          }),
          token: patched.token,
        });
        return;
      }
    }

    if (isSupabaseAuthEnabled()) {
      const user = await updateSupabaseProfile(tok, {
        name: typeof body.name === "string" ? body.name : undefined,
        dashboard: body.dashboard,
      });
      if (!user) {
        res.status(401).json({ error: "User not found" });
        return;
      }
      res.json({ user: withRoleFlags(user) });
      return;
    }

    const secret = getAuthSecret();
    if (!secret) {
      res.status(503).json({ error: "Set AUTH_SECRET in server/.env" });
      return;
    }
    const payload = verifyToken(tok, secret);
    if (!payload?.sub) {
      res.status(401).json({ error: "Invalid or expired token" });
      return;
    }
    const user = updateUserProfile(payload.sub, {
      name: typeof body.name === "string" ? body.name : undefined,
      dashboard: body.dashboard,
    });
    if (!user) {
      res.status(401).json({ error: "User not found" });
      return;
    }
    res.json({ user: withRoleFlags(publicUser(user)) });
  } catch (e) {
    const status = Number(e.status);
    if (status >= 400 && status < 600) {
      res.status(status).json({ error: e.message });
      return;
    }
    next(e);
  }
});
