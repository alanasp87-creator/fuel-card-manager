import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { fetchCatalogStationsSnapshot, invalidateFuelCatalogCache } from "./fuelFinderGov.mjs";
import { getFuelPriceMaxAgeMs, isSnapshotCatalogFresh } from "./fuelPriceFreshness.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SNAPSHOT_PATH = path.join(__dirname, "..", "fuel-snapshots.json");
const DEFAULT_STORE = { latest: null };
let inFlight = null;

function loadStore() {
  try {
    const raw = fs.readFileSync(SNAPSHOT_PATH, "utf8");
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return { ...DEFAULT_STORE };
    return {
      latest: parsed.latest && typeof parsed.latest === "object" ? parsed.latest : null,
    };
  } catch {
    return { ...DEFAULT_STORE };
  }
}

function saveStore(store) {
  fs.writeFileSync(SNAPSHOT_PATH, JSON.stringify(store, null, 2), "utf8");
}

function denyStaleDiskFallback() {
  const v = process.env.FUEL_SNAPSHOT_DENY_STALE_FALLBACK?.trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes";
}

function canServeDiskSnapshotWhenGovFails(stale) {
  if (!stale || !Array.isArray(stale.stations) || stale.stations.length === 0) return false;
  return isSnapshotCatalogFresh(stale, getFuelPriceMaxAgeMs());
}

export function getLatestFuelSnapshot() {
  const store = loadStore();
  return store.latest && typeof store.latest === "object" ? store.latest : null;
}

export function getFuelSnapshotMeta() {
  const latest = getLatestFuelSnapshot();
  if (!latest) return { exists: false, capturedAt: null, count: 0 };
  return {
    exists: true,
    capturedAt: latest.capturedAt || null,
    count: Array.isArray(latest.stations) ? latest.stations.length : 0,
  };
}

export async function refreshFuelSnapshot() {
  if (inFlight) return inFlight;
  inFlight = (async () => {
    invalidateFuelCatalogCache();
    const page = await fetchCatalogStationsSnapshot();
    if (!page.ok) {
      const err = new Error("Could not refresh fuel snapshot");
      err.status = page.status || 502;
      err.data = page.data;
      throw err;
    }
    const stations = Array.isArray(page.data?.stations) ? page.data.stations : [];
    const capturedAt =
      typeof page.data?.capturedAt === "string" && page.data.capturedAt
        ? page.data.capturedAt
        : new Date().toISOString();
    const latest = {
      capturedAt,
      stations,
      count: stations.length,
      refreshedAt: new Date().toISOString(),
    };
    saveStore({ latest });
    return latest;
  })().finally(() => {
    inFlight = null;
  });
  return inFlight;
}

export function fuelSnapshotMaxAgeMs() {
  const n = Number(process.env.FUEL_SNAPSHOT_MAX_AGE_MS);
  if (Number.isFinite(n) && n >= 60_000) return n;
  return 15 * 60 * 1000;
}

export async function getOrRefreshFuelSnapshot(maxAgeMs) {
  const limit = maxAgeMs != null ? maxAgeMs : fuelSnapshotMaxAgeMs();
  const latest = getLatestFuelSnapshot();
  if (latest && latest.capturedAt) {
    const age = Date.now() - Date.parse(latest.capturedAt);
    if (Number.isFinite(age) && age >= 0 && age <= limit) {
      return { snapshot: latest, staleFallback: false };
    }
  }
  try {
    const snap = await refreshFuelSnapshot();
    return { snapshot: snap, staleFallback: false };
  } catch (e) {
    const stale = getLatestFuelSnapshot();
    if (stale && Array.isArray(stale.stations) && stale.stations.length > 0) {
      if (denyStaleDiskFallback() && !canServeDiskSnapshotWhenGovFails(stale)) throw e;
      console.warn(
        "[fuel-snapshot] GOV refresh failed — serving last saved snapshot from disk. " +
          (e && e.message ? e.message : e)
      );
      return { snapshot: stale, staleFallback: true };
    }
    throw e;
  }
}
