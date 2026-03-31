import express from "express";
import { findUserById, updateUserProfile } from "../lib/usersRepo.mjs";
import { getAuthSecret, verifyToken } from "../lib/tokens.mjs";
import { isSupabaseAuthEnabled, meFromAccessToken } from "../lib/supabaseAuth.mjs";
import { tryVerifyDevSession } from "../lib/devAuth.mjs";

export const webhooksRouter = express.Router();

function bearer(req) {
  const auth = req.headers.authorization || "";
  const m = auth.match(/^Bearer\s+(.+)$/i);
  return m ? m[1].trim() : null;
}

async function resolveAuthUserId(req) {
  const tok = bearer(req);
  if (!tok) return null;

  const devPayload = tryVerifyDevSession(tok);
  if (devPayload) return devPayload.userId || devPayload.sub || null;

  if (isSupabaseAuthEnabled()) {
    const u = await meFromAccessToken(tok);
    return u?.id ?? null;
  }

  const secret = getAuthSecret();
  if (!secret) return null;
  const payload = verifyToken(tok, secret);
  return payload?.sub ?? null;
}


/**
 * POST /webhooks/fuel-prices/import
 * Bulk import weekly fuel price data.
 *
 * Body:
 *   {
 *     "userId": "uuid",
 *     "data": [
 *       { "date": "2025-07-29", "diesel": 131.77 },
 *       { "date": "2025-08-04", "diesel": 134.30 }
 *     ]
 *   }
 */
webhooksRouter.post("/fuel-prices/import", (req, res) => {
  try {
    const { userId, data } = req.body || {};
    if (!userId || !Array.isArray(data)) {
      res.status(400).json({ error: "userId and data array required" });
      return;
    }

    const user = findUserById(userId);
    if (!user) {
      res.status(404).json({ error: "User not found" });
      return;
    }

    const dashboard = user.dashboard || {};
    const history = dashboard.fuelPriceHistory || [];

    // Import new entries
    data.forEach((entry) => {
      if (!entry.date || entry.diesel === undefined) return;
      // Remove duplicate for same date
      const filtered = history.filter((h) => h.date !== entry.date);
      filtered.push({
        date: entry.date,
        card: "diesel",
        prices: { diesel: entry.diesel },
        timestamp: new Date().toISOString(),
      });
      history.length = 0;
      history.push(...filtered);
    });

    const updated = updateUserProfile(userId, {
      dashboard: { ...dashboard, fuelPriceHistory: history },
    });

    if (!updated) {
      res.status(500).json({ error: "Failed to import data" });
      return;
    }

    res.json({
      success: true,
      message: `Imported ${data.length} price entries`,
      count: history.length,
    });
  } catch (e) {
    console.error("[webhook/fuel-prices/import]", e);
    res.status(500).json({ error: e.message || "Import failed" });
  }
});

/**
 * GET /webhooks/fuel-prices/history?userId=<uuid>&card=<cardName>
 * Retrieve stored fuel price history (weekly snapshots).
 */
webhooksRouter.get("/fuel-prices/history", (req, res) => {
  try {
    const { userId, card } = req.query;
    if (!userId) {
      res.status(400).json({ error: "userId required" });
      return;
    }

    const user = findUserById(userId);
    if (!user) {
      res.status(404).json({ error: "User not found" });
      return;
    }

    const dashboard = user.dashboard || {};
    const history = dashboard.fuelPriceHistory || [];
    const filtered = card
      ? history.filter((h) => h.card === card)
      : history;

    res.json({
      success: true,
      userId,
      card: card || "all",
      count: filtered.length,
      data: filtered.sort((a, b) => a.date.localeCompare(b.date)),
    });
  } catch (e) {
    console.error("[webhook/fuel-prices/history]", e);
    res.status(500).json({
      error: e.message || "Failed to retrieve history",
    });
  }
});

/**
 * GET /webhooks/user-price-history/history?userId=<uuid>
 * Retrieve stored user price trend history (auto-captured daily snapshots).
 * Requires auth — userId must match the authenticated caller.
 */
webhooksRouter.get("/user-price-history/history", async (req, res) => {
  try {
    const { userId } = req.query;
    if (!userId) {
      res.status(400).json({ error: "userId required" });
      return;
    }

    const authUserId = await resolveAuthUserId(req);
    if (!authUserId) {
      res.status(401).json({ error: "Authentication required" });
      return;
    }
    if (authUserId !== userId) {
      res.status(403).json({ error: "Access denied" });
      return;
    }

    let dashboard = {};

    if (isSupabaseAuthEnabled()) {
      const u = await meFromAccessToken(bearer(req));
      dashboard = u?.dashboard && typeof u.dashboard === "object" ? u.dashboard : {};
    } else {
      const user = findUserById(userId);
      // Dev-session users may not exist in local store — return empty history gracefully
      dashboard = user?.dashboard || {};
    }

    const history = Array.isArray(dashboard.userPriceHistory)
      ? dashboard.userPriceHistory.slice().sort((a, b) => a.date.localeCompare(b.date))
      : [];

    res.json({
      success: true,
      userId,
      count: history.length,
      data: history,
    });
  } catch (e) {
    console.error("[webhook/user-price-history/history]", e);
    res.status(500).json({ error: e.message || "Failed to retrieve history" });
  }
});

/**
 * GET /webhooks/status
 * Health check for webhook service.
 */
webhooksRouter.get("/status", (req, res) => {
  res.json({ ok: true, service: "webhooks" });
});
