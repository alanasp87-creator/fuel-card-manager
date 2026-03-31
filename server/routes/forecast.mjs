import express from "express";
import { getAuthSecret, verifyToken } from "../lib/tokens.mjs";
import { findUserById, publicUser } from "../lib/usersRepo.mjs";
import { isSupabaseAuthEnabled, meFromAccessToken } from "../lib/supabaseAuth.mjs";
import { tryVerifyDevSession } from "../lib/devAuth.mjs";
import { computeForecast } from "../lib/fuelForecast.mjs";
import { refreshBrentCrudeHistory, getBrentCrudeHistory } from "../lib/brentCrude.mjs";

export const forecastRouter = express.Router();

function bearer(req) {
  const auth = req.headers.authorization || "";
  const m = auth.match(/^Bearer\s+(.+)$/i);
  return m ? m[1].trim() : null;
}

async function resolveAuthUser(req) {
  const tok = bearer(req);
  if (!tok) return null;

  const devPayload = tryVerifyDevSession(tok);
  if (devPayload) {
    const uid = devPayload.userId || devPayload.sub || null;
    if (!uid) return null;
    const u = findUserById(uid);
    return u || { id: uid, isAdmin: devPayload.isAdmin === true };
  }

  if (isSupabaseAuthEnabled()) {
    const u = await meFromAccessToken(tok);
    return u ?? null;
  }

  const secret = getAuthSecret();
  if (!secret) return null;
  const payload = verifyToken(tok, secret);
  if (!payload?.sub) return null;
  const u = findUserById(payload.sub);
  return u || null;
}

forecastRouter.get("/forecast", async (req, res) => {
  try {
    const user = await resolveAuthUser(req);
    if (!user) {
      res.status(401).json({ error: "Authentication required" });
      return;
    }

    const forecast = computeForecast();
    res.set("Cache-Control", "no-store");
    res.json({
      success: true,
      ...forecast,
    });
  } catch (e) {
    console.error("[forecast]", e);
    res.status(500).json({ error: e.message || "Forecast generation failed" });
  }
});

forecastRouter.post("/forecast/refresh-crude", async (req, res) => {
  try {
    const user = await resolveAuthUser(req);
    if (!user) {
      res.status(401).json({ error: "Authentication required" });
      return;
    }
    if (!user.isAdmin) {
      res.status(403).json({ error: "Admin access required" });
      return;
    }

    const history = await refreshBrentCrudeHistory();
    res.json({
      success: true,
      count: history.length,
      latest: history.length > 0 ? history[history.length - 1] : null,
    });
  } catch (e) {
    console.error("[forecast/refresh-crude]", e);
    res.status(500).json({ error: e.message || "Crude price refresh failed" });
  }
});
