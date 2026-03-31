import { isSupabaseAuthEnabled, listSupabaseProfilesForFuel, patchSupabaseProfileDashboardById } from "./supabaseAuth.mjs";
import { listUsers, patchUserDashboard } from "./usersRepo.mjs";
import { buildUserCohortFromPostcode } from "./fuelCohorts.mjs";
import { getLatestFuelSnapshot } from "./fuelSnapshots.mjs";
import { recordDieselPrice } from "./brentCrude.mjs";

export async function buildDashboardCohortPatch(dashboard, snapshot) {
  const d = dashboard && typeof dashboard === "object" ? dashboard : {};
  const postcode = String(d.operationPostcode || "").trim();
  if (!postcode) return null;
  return buildUserCohortFromPostcode(postcode, snapshot);
}

function todayIso() {
  return new Date().toISOString().slice(0, 10);
}

function yesterdayIso() {
  const d = new Date();
  d.setDate(d.getDate() - 1);
  return d.toISOString().slice(0, 10);
}

function num(v) {
  if (v == null || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function stationIdOf(s) {
  const raw = s?.stationId ?? s?.station_id ?? s?.node_id ?? s?.id;
  return String(raw || "").trim();
}

function pickB7Price(prices) {
  if (!prices || typeof prices !== "object") return null;
  const p = {};
  Object.keys(prices).forEach((k) => {
    const ku = String(k).toUpperCase().replace(/\s+/g, "_");
    const v = num(prices[k]);
    if (v != null) p[ku] = v;
  });
  if (p.B7 != null) return p.B7;
  if (p.DIESEL != null) return p.DIESEL;
  if (p.B7_STANDARD != null) return p.B7_STANDARD;
  return null;
}

/**
 * Compute avg/min/max diesel from ALL stations in snapshot — no freshness check.
 * Used for history capture so the last API call's data always feeds today's entry.
 */
function computeEnglandMetricsFromSnapshot(snapshot) {
  const stations = Array.isArray(snapshot?.stations) ? snapshot.stations : [];
  const prices = [];
  for (const s of stations) {
    const p = pickB7Price(s.prices);
    if (p != null && p > 50 && p < 500) prices.push(p);
  }
  if (prices.length === 0) return { englandAvg: null, englandMin: null, englandMax: null };
  const avg = prices.reduce((a, b) => a + b, 0) / prices.length;
  return {
    englandAvg: Math.round(avg * 10) / 10,
    englandMin: Math.round(Math.min(...prices) * 10) / 10,
    englandMax: Math.round(Math.max(...prices) * 10) / 10,
  };
}

/**
 * Compute local avg/min/max diesel for the user's cohort stations — no freshness check.
 */
function computeLocalMetricsFromSnapshot(localStations, snapshot) {
  const stations = Array.isArray(localStations) ? localStations : [];
  const allRows = Array.isArray(snapshot?.stations) ? snapshot.stations : [];

  const byId = new Map();
  for (const row of allRows) {
    const id = stationIdOf(row);
    if (id && !byId.has(id)) byId.set(id, row);
  }

  const prices = [];
  for (const s of stations) {
    const id = stationIdOf(s);
    if (!id) continue;
    const row = byId.get(id);
    if (!row) continue;
    const p = pickB7Price(row.prices);
    if (p != null && p > 50 && p < 500) prices.push(p);
  }

  if (prices.length === 0) return { localAvg: null, localMin: null, localMax: null };

  const avg = prices.reduce((a, b) => a + b, 0) / prices.length;
  return {
    localAvg: Math.round(avg * 10) / 10,
    localMin: Math.round(Math.min(...prices) * 10) / 10,
    localMax: Math.round(Math.max(...prices) * 10) / 10,
  };
}

function getUserCardPrices(dashboard) {
  const fuelCards = dashboard?.localFuel?.fuelCards;
  if (!Array.isArray(fuelCards)) return [];
  return fuelCards
    .map((card) => ({
      cardId: card?.id || "unknown",
      label: card?.label || "Card",
      price: card?.userPricePence != null && Number.isFinite(Number(card.userPricePence))
        ? Number(card.userPricePence)
        : null,
    }))
    .filter((c) => c.price != null);
}

function buildUpdatedHistory(existing, today, yesterday, newEntry) {
  const arr = Array.isArray(existing) ? existing : [];
  const withoutToday = arr.filter((h) => h.date !== today);
  withoutToday.push(newEntry);

  // Back-fill yesterday with same values if this is the very first entry
  if (arr.length === 0) {
    withoutToday.push({ ...newEntry, date: yesterday });
  }

  withoutToday.sort((a, b) => a.date.localeCompare(b.date));
  return withoutToday;
}

export async function refreshAllUserCohorts(snapshot) {
  const out = { updated: 0, skipped: 0, failed: 0 };
  if (!snapshot || typeof snapshot !== "object") return out;

  // Use the passed snapshot, but fall back to the last saved one for history
  // so that the last API call always feeds today's chart entry even if credentials
  // are missing or the API call failed this run.
  const historySnapshot = (Array.isArray(snapshot?.stations) && snapshot.stations.length > 0)
    ? snapshot
    : (getLatestFuelSnapshot() || snapshot);

  const supabase = isSupabaseAuthEnabled();

  const rows = supabase
    ? await listSupabaseProfilesForFuel()
    : listUsers().map((u) => ({
        id: String(u.id),
        dashboard: u.dashboard && typeof u.dashboard === "object" ? u.dashboard : {},
      }));

  const { englandAvg, englandMin, englandMax } = computeEnglandMetricsFromSnapshot(historySnapshot);

  try {
    const today2 = new Date().toISOString().slice(0, 10);
    recordDieselPrice(today2, englandAvg, englandMin, englandMax);
  } catch (e) {
    console.warn("[fuelSync] recordDieselPrice failed:", e?.message || e);
  }

  const today = todayIso();
  const yesterday = yesterdayIso();

  for (const r of rows) {
    const dash = r.dashboard && typeof r.dashboard === "object" ? r.dashboard : {};
    const postcode = String(dash.operationPostcode || "").trim();
    if (!postcode) {
      out.skipped += 1;
      continue;
    }
    try {
      const cohortPatch = await buildUserCohortFromPostcode(postcode, snapshot);

      const { localAvg, localMin, localMax } = computeLocalMetricsFromSnapshot(
        cohortPatch.localStations,
        historySnapshot
      );
      const userCardPrices = getUserCardPrices(dash);

      const newEntry = { date: today, userCardPrices, localAvg, localMin, localMax, englandAvg, englandMin, englandMax };
      const existingHistory = Array.isArray(dash.userPriceHistory) ? dash.userPriceHistory : [];
      const updatedHistory = buildUpdatedHistory(existingHistory, today, yesterday, newEntry);

      // Single combined write — works for both local and Supabase
      const combinedPatch = { ...cohortPatch, userPriceHistory: updatedHistory };

      if (supabase) {
        await patchSupabaseProfileDashboardById(r.id, combinedPatch);
      } else {
        patchUserDashboard(r.id, combinedPatch);
      }

      out.updated += 1;
    } catch {
      out.failed += 1;
    }
  }
  return out;
}
