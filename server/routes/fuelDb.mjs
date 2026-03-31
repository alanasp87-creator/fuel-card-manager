import express from "express";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getStations, getDbStats } from "../lib/fuelStationsDb.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const fuelDbRouter = express.Router();

/**
 * GET /fuel-db/stations
 * Query cached fuel stations database.
 *
 * Query params:
 *   - postcode: Filter by postcode
 *   - minPrice: Min diesel price (pence)
 *   - maxPrice: Max diesel price (pence)
 *   - brand: Filter by brand/name
 *   - limit: Max results (default 100)
 */
fuelDbRouter.get("/stations", (req, res) => {
  try {
    const filter = {
      postcode: req.query.postcode,
      minPrice: req.query.minPrice,
      maxPrice: req.query.maxPrice,
      brand: req.query.brand,
      limit: Number(req.query.limit) || 100,
    };

    const stations = getStations(filter);
    res.json({
      success: true,
      count: stations.length,
      data: stations,
    });
  } catch (e) {
    console.error("[fuel-db/stations]", e);
    res.status(500).json({ error: e.message || "Query failed" });
  }
});

/**
 * GET /fuel-db/stats
 * Get database statistics.
 */
fuelDbRouter.get("/stats", (req, res) => {
  try {
    const stats = getDbStats();
    res.json({ success: true, ...stats });
  } catch (e) {
    console.error("[fuel-db/stats]", e);
    res.status(500).json({ error: e.message || "Failed to get stats" });
  }
});

/**
 * GET /fuel-db/prices
 * Get price statistics (min/max/avg diesel).
 */
fuelDbRouter.get("/prices", (req, res) => {
  try {
    const stations = getStations({});
    const prices = stations
      .map((s) => s.prices?.B7 || s.prices?.diesel)
      .filter((p) => typeof p === "number" && p > 0);

    if (prices.length === 0) {
      res.json({
        success: true,
        message: "No price data available",
        count: 0,
      });
      return;
    }

    const min = Math.min(...prices);
    const max = Math.max(...prices);
    const avg = prices.reduce((a, b) => a + b, 0) / prices.length;

    res.json({
      success: true,
      count: prices.length,
      min: min.toFixed(2),
      max: max.toFixed(2),
      average: avg.toFixed(2),
    });
  } catch (e) {
    console.error("[fuel-db/prices]", e);
    res.status(500).json({ error: e.message || "Failed to get prices" });
  }
});

/**
 * POST /fuel-db/sync
 * Trigger manual sync from GOV.UK Fuel Finder API to local database.
 * Requires: FUEL_CLIENT_ID and FUEL_CLIENT_SECRET in server/.env
 */
fuelDbRouter.post("/sync", (req, res) => {
  const syncScript = path.join(__dirname, "..", "scripts", "sync-fuel-stations.mjs");

  console.log("[fuel-db/sync] Starting background sync...");

  const proc = spawn("node", [syncScript], {
    cwd: path.join(__dirname, ".."),
    detached: false,
  });

  let output = "";
  let error = "";

  proc.stdout.on("data", (data) => {
    output += data.toString();
  });

  proc.stderr.on("data", (data) => {
    error += data.toString();
  });

  proc.on("close", (code) => {
    if (code === 0) {
      console.log("[fuel-db/sync] Sync completed successfully");
    } else {
      console.error("[fuel-db/sync] Sync failed with exit code", code);
    }
  });

  // Return immediately — sync happens in background
  res.json({
    success: true,
    message: "Sync started in background. Check server logs for progress.",
    note: "Requires FUEL_CLIENT_ID and FUEL_CLIENT_SECRET in server/.env",
  });
});
