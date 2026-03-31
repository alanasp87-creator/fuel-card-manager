import express from "express";
import { getAuthSecret, verifyToken } from "../lib/tokens.mjs";
import { findUserById, publicUser, updateUserProfile } from "../lib/usersRepo.mjs";
import {
  isSupabaseAuthEnabled,
  meFromAccessToken,
  patchSupabaseProfileDashboardById,
} from "../lib/supabaseAuth.mjs";
import { withRoleFlags } from "../lib/adminUsers.mjs";
import { tryVerifyDevSession, devUserFromPayload } from "../lib/devAuth.mjs";
import { computeCategoryMetrics, computeNationalMetrics } from "../lib/fuelCohorts.mjs";
import { getFuelPriceMaxAgeHoursRounded } from "../lib/fuelPriceFreshness.mjs";
import {
  getFuelSnapshotMeta,
  getOrRefreshFuelSnapshot,
  refreshFuelSnapshot,
} from "../lib/fuelSnapshots.mjs";
import { buildDashboardCohortPatch, refreshAllUserCohorts } from "../lib/fuelSync.mjs";

export const dashboardRouter = express.Router();

function bearer(req) {
  const auth = req.headers.authorization || "";
  const m = auth.match(/^Bearer\s+(.+)$/i);
  return m ? m[1].trim() : null;
}

async function resolveUser(req) {
  const tok = bearer(req);
  if (!tok) return null;

  const devPayload = tryVerifyDevSession(tok);
  if (devPayload) {
    return {
      mode: "dev",
      token: tok,
      user: withRoleFlags(devUserFromPayload(devPayload)),
    };
  }

  if (isSupabaseAuthEnabled()) {
    const u = await meFromAccessToken(tok);
    if (!u) return null;
    return { mode: "supabase", token: tok, user: withRoleFlags(u) };
  }

  const secret = getAuthSecret();
  if (!secret) return null;
  const payload = verifyToken(tok, secret);
  if (!payload?.sub) return null;
  const raw = findUserById(payload.sub);
  if (!raw) return null;
  return { mode: "local", token: tok, user: withRoleFlags(publicUser(raw)) };
}

async function persistDashboardPatch(ctx, patch) {
  if (!ctx || !patch || typeof patch !== "object") return null;
  if (ctx.mode === "local") {
    const u = updateUserProfile(ctx.user.id, { dashboard: patch });
    return u ? withRoleFlags(publicUser(u)) : null;
  }
  if (ctx.mode === "supabase") {
    await patchSupabaseProfileDashboardById(ctx.user.id, patch);
    const fresh = await meFromAccessToken(ctx.token);
    return fresh ? withRoleFlags(fresh) : null;
  }
  return ctx.user;
}

dashboardRouter.get("/dashboard/fuel-metrics", async (req, res, next) => {
  try {
    const ctx = await resolveUser(req);
    if (!ctx) {
      res.status(401).json({ error: "Missing or invalid token" });
      return;
    }
    const { snapshot, staleFallback } = await getOrRefreshFuelSnapshot();
    const dashboard =
      ctx.user?.dashboard && typeof ctx.user.dashboard === "object" ? ctx.user.dashboard : {};

    let localStations = Array.isArray(dashboard.localStations) ? dashboard.localStations : [];
    if (!localStations.length && String(dashboard.operationPostcode || "").trim()) {
      const patch = await buildDashboardCohortPatch(dashboard, snapshot);
      if (patch) {
        const fresh = await persistDashboardPatch(ctx, patch);
        if (
          fresh &&
          fresh.dashboard &&
          Array.isArray(fresh.dashboard.localStations) &&
          fresh.dashboard.localStations.length > 0
        ) {
          localStations = fresh.dashboard.localStations;
        } else if (Array.isArray(patch.localStations) && patch.localStations.length > 0) {
          localStations = patch.localStations;
        }
      }
    }

    const metrics = computeCategoryMetrics(localStations, snapshot);
    res.set("Cache-Control", "no-store");
    res.json({
      snapshot: { ...getFuelSnapshotMeta(), staleFallback: Boolean(staleFallback) },
      priceFreshnessMaxAgeHours: getFuelPriceMaxAgeHoursRounded(),
      ...metrics,
    });
  } catch (e) {
    next(e);
  }
});

dashboardRouter.get("/dashboard/fuel-metrics/national", async (req, res, next) => {
  try {
    const ctx = await resolveUser(req);
    if (!ctx) {
      res.status(401).json({ error: "Missing or invalid token" });
      return;
    }
    const { snapshot, staleFallback } = await getOrRefreshFuelSnapshot();
    const metrics = computeNationalMetrics(snapshot);
    res.set("Cache-Control", "no-store");
    res.json({
      snapshot: { ...getFuelSnapshotMeta(), staleFallback: Boolean(staleFallback) },
      priceFreshnessMaxAgeHours: getFuelPriceMaxAgeHoursRounded(),
      ...metrics,
    });
  } catch (e) {
    next(e);
  }
});

dashboardRouter.get("/admin/fuel-snapshot/status", async (req, res) => {
  const ctx = await resolveUser(req);
  if (!ctx) {
    res.status(401).json({ error: "Missing or invalid token" });
    return;
  }
  if (!ctx.user?.isAdmin) {
    res.status(403).json({ error: "Admin only" });
    return;
  }
  res.json(getFuelSnapshotMeta());
});

dashboardRouter.post("/admin/fuel-snapshot/refresh", async (req, res, next) => {
  try {
    const ctx = await resolveUser(req);
    if (!ctx) {
      res.status(401).json({ error: "Missing or invalid token" });
      return;
    }
    if (!ctx.user?.isAdmin) {
      res.status(403).json({ error: "Admin only" });
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
