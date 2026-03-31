import { geocodeUKPostcode } from "./fuelFinderGov.mjs";
import {
  getFuelPriceMaxAgeMs,
  isSnapshotCatalogFresh,
  isSnapshotPriceFresh,
} from "./fuelPriceFreshness.mjs";

export const USER_COHORT_RADIUS_KM = 30;
const PRICE_FLOOR_PPL = 50;
const PRICE_CEIL_PPL = 500;

function num(v) {
  if (v == null || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function haversineKm(lat1, lon1, lat2, lon2) {
  const toRad = (d) => (d * Math.PI) / 180;
  const R = 6371;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) * Math.sin(dLon / 2);
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function normalizePriceMap(prices) {
  if (!prices || typeof prices !== "object") return {};
  const out = {};
  Object.keys(prices).forEach((k) => {
    const n = num(prices[k]);
    if (n != null) out[String(k).toUpperCase()] = n;
  });
  return out;
}

function stationIdOf(station) {
  if (!station || typeof station !== "object") return "";
  const raw = station.stationId != null ? station.stationId : station.station_id;
  return String(raw || "").trim();
}

function stationKindOf(station) {
  const k = String(station?.stationKind || "").trim().toLowerCase();
  return k === "supermarket" || k === "motorway" || k === "independent" ? k : "independent";
}

function pickDisplayPrice(priceMap) {
  if (!priceMap || typeof priceMap !== "object") return null;
  const p = normalizePriceMap(priceMap);
  const raw = p.B7 != null ? p.B7 : p.B7_STANDARD != null ? p.B7_STANDARD : null;
  if (raw == null) return null;
  if (raw < PRICE_FLOOR_PPL || raw > PRICE_CEIL_PPL) return null;
  return raw;
}

function stationLabelFromSnapshotRow(row) {
  if (!row || typeof row !== "object") return "Station";
  const n = row.name ?? row.trading_name ?? row.brand_name ?? row.brand;
  return String(n || "Station").trim().slice(0, 200);
}

function priceLastUpdatedIsoFromRow(row) {
  if (!row || typeof row !== "object") return null;
  const raw = row.lastUpdated != null ? row.lastUpdated : row.last_updated;
  if (typeof raw !== "string" || !raw.trim()) return null;
  return raw.trim();
}

function summaryFromPriceEntries(entries, stationCount) {
  const priced = Array.isArray(entries) ? entries.filter((e) => e && Number.isFinite(e.price)) : [];
  if (priced.length === 0) {
    return {
      stationCount,
      averagePrice: null,
      lowestPrice: null,
      highestPrice: null,
      lowestStation: null,
      topCheapestStations: [],
    };
  }
  let sum = 0;
  let low = priced[0];
  let high = priced[0];
  for (const e of priced) {
    const p = e.price;
    sum += p;
    if (p < low.price) low = e;
    if (p > high.price) high = e;
  }
  const avg = sum / priced.length;
  const sorted = [...priced].sort((a, b) => a.price - b.price);
  const mk = (e) => ({
    stationId: e.stationId,
    name: e.name,
    postcode: e.postcode,
    address: e.address,
    distanceKm: e.distanceKm,
    pricePence: Math.round(e.price * 10) / 10,
    priceLastUpdated: e.priceLastUpdated ?? null,
  });
  return {
    stationCount,
    averagePrice: Math.round(avg * 10) / 10,
    lowestPrice: Math.round(low.price * 10) / 10,
    highestPrice: Math.round(high.price * 10) / 10,
    lowestStation: mk(low),
    topCheapestStations: sorted.slice(0, 5).map(mk),
  };
}

export async function buildUserCohortFromPostcode(postcode, snapshot, radiusKm = USER_COHORT_RADIUS_KM) {
  const clean = String(postcode || "").trim().replace(/\s+/g, "").toUpperCase();
  if (!clean) {
    return {
      operationPostcode: "",
      localStations: [],
      localStationsUpdatedAt: new Date().toISOString(),
      localStationsRadiusKm: radiusKm,
    };
  }
  const geo = await geocodeUKPostcode(clean);
  const originLat = num(geo?.lat);
  const originLng = num(geo?.lng);
  if (originLat == null || originLng == null) {
    const err = new Error("Could not resolve operation postcode coordinates.");
    err.status = 400;
    throw err;
  }
  const rows = Array.isArray(snapshot?.stations) ? snapshot.stations : [];
  const seen = new Set();
  const localStations = [];
  for (const row of rows) {
    const id = stationIdOf(row);
    if (!id || seen.has(id)) continue;
    const lat = num(row?.lat);
    const lng = num(row?.lng);
    if (lat == null || lng == null) continue;
    const distanceKm = haversineKm(originLat, originLng, lat, lng);
    if (!(distanceKm <= radiusKm)) continue;
    seen.add(id);
    localStations.push({
      stationId: id,
      stationKind: stationKindOf(row),
      postcode: String(row?.postcode || "").trim(),
      address: String(row?.address || "").trim().slice(0, 300),
      lat,
      lng,
      distanceKm: Math.round(distanceKm * 10) / 10,
      savedSource: "autoRadius",
    });
  }
  localStations.sort((a, b) => (a.distanceKm ?? 99999) - (b.distanceKm ?? 99999));
  return {
    operationPostcode: clean,
    localStations,
    localStationsUpdatedAt: new Date().toISOString(),
    localStationsRadiusKm: radiusKm,
  };
}

function emptyMetricsResult(snapshot, snapshotCatalogStale) {
  const emptyRow = {
    stationCount: 0,
    averagePrice: null,
    lowestPrice: null,
    highestPrice: null,
    lowestStation: null,
    topCheapestStations: [],
  };
  return {
    capturedAt: snapshot?.capturedAt || null,
    snapshotCatalogStale: Boolean(snapshotCatalogStale),
    categories: {
      supermarket: { ...emptyRow },
      motorway: { ...emptyRow },
      independent: { ...emptyRow },
    },
    totals: { ...emptyRow },
  };
}

export function computeCategoryMetrics(localStations, snapshot) {
  const stations = Array.isArray(localStations) ? localStations : [];
  const maxAgeMs = getFuelPriceMaxAgeMs();
  if (!isSnapshotCatalogFresh(snapshot, maxAgeMs)) return emptyMetricsResult(snapshot, true);

  const byId = new Map();
  const allSnapshotRows = Array.isArray(snapshot?.stations) ? snapshot.stations : [];
  for (const row of allSnapshotRows) {
    const id = stationIdOf(row);
    if (!id || byId.has(id)) continue;
    byId.set(id, row);
  }

  const buckets = {
    supermarket: { entries: [] },
    motorway: { entries: [] },
    independent: { entries: [] },
  };
  const totals = { entries: [] };

  for (const s of stations) {
    const id = stationIdOf(s);
    if (!id) continue;
    const kind = stationKindOf(s);
    const row = byId.get(id);
    if (!row) continue;
    const p = pickDisplayPrice(row.prices);
    if (p == null || !isSnapshotPriceFresh(row, maxAgeMs)) continue;
    const entry = {
      price: p,
      stationId: id,
      name: stationLabelFromSnapshotRow(row),
      postcode: String(row.postcode || "").trim(),
      address: String(row.address || "").trim().slice(0, 300),
      distanceKm: s.distanceKm != null && Number.isFinite(Number(s.distanceKm)) ? Number(s.distanceKm) : null,
      priceLastUpdated: priceLastUpdatedIsoFromRow(row),
    };
    buckets[kind].entries.push(entry);
    totals.entries.push(entry);
  }

  const sup = buckets.supermarket.entries;
  const mot = buckets.motorway.entries;
  const ind = buckets.independent.entries;
  const tot = totals.entries;

  return {
    capturedAt: snapshot?.capturedAt || null,
    snapshotCatalogStale: false,
    categories: {
      supermarket: summaryFromPriceEntries(sup, sup.length),
      motorway: summaryFromPriceEntries(mot, mot.length),
      independent: summaryFromPriceEntries(ind, ind.length),
    },
    totals: summaryFromPriceEntries(tot, tot.length),
  };
}

export function computeNationalMetrics(snapshot) {
  const maxAgeMs = getFuelPriceMaxAgeMs();
  if (!isSnapshotCatalogFresh(snapshot, maxAgeMs)) return emptyMetricsResult(snapshot, true);

  const allRows = Array.isArray(snapshot?.stations) ? snapshot.stations : [];
  const buckets = {
    supermarket: { entries: [] },
    motorway: { entries: [] },
    independent: { entries: [] },
  };
  const totals = { entries: [] };
  const seen = new Set();

  for (const row of allRows) {
    const id = stationIdOf(row);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const p = pickDisplayPrice(row.prices);
    if (p == null || !isSnapshotPriceFresh(row, maxAgeMs)) continue;
    const kind = stationKindOf(row);
    const entry = {
      price: p,
      stationId: id,
      name: stationLabelFromSnapshotRow(row),
      postcode: String(row.postcode || "").trim(),
      address: String(row.address || "").trim().slice(0, 300),
      distanceKm: null,
      priceLastUpdated: priceLastUpdatedIsoFromRow(row),
    };
    buckets[kind].entries.push(entry);
    totals.entries.push(entry);
  }

  const sup = buckets.supermarket.entries;
  const mot = buckets.motorway.entries;
  const ind = buckets.independent.entries;
  const tot = totals.entries;

  return {
    capturedAt: snapshot?.capturedAt || null,
    snapshotCatalogStale: false,
    categories: {
      supermarket: summaryFromPriceEntries(sup, sup.length),
      motorway: summaryFromPriceEntries(mot, mot.length),
      independent: summaryFromPriceEntries(ind, ind.length),
    },
    totals: summaryFromPriceEntries(tot, tot.length),
  };
}
