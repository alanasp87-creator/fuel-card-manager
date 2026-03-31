import { classifyStationKind } from "./stationKind.mjs";

/**
 * GOV.UK Fuel Finder API — matches official model: REST resources, read via GET, auth via OAuth 2.0 client credentials.
 * Guidance: https://www.gov.uk/guidance/access-the-latest-fuel-prices-and-forecourt-data-via-api-or-email
 * Portal (Information Recipient apps): https://www.developer.fuel-finder.service.gov.uk/
 * Token: POST JSON { client_id, client_secret }. Data: GET with Authorization: Bearer <token>.
 * Confirm resource paths and query names in the portal docs; override FUEL_FINDER_* env vars if they differ.
 */

/** Public service host (resolves in DNS); override via env if the portal shows different URLs. */
const DEFAULT_TOKEN_URL =
  "https://www.fuel-finder.service.gov.uk/api/v1/oauth/generate_access_token";
const DEFAULT_API_BASE = "https://www.fuel-finder.service.gov.uk/api/v1";
const DEFAULT_PRICES_PATH = "/pfs/fuel-prices";
const DEFAULT_FORECOURTS_PATH = "/pfs";

let cache = { accessToken: null, expiresAtMs: 0 };
/** Single in-flight OAuth request — avoids parallel client_credentials calls (common 429 cause). */
let tokenFetchPromise = null;

const CATALOG_TTL_MS = Number(process.env.FUEL_CATALOG_TTL_MINUTES || 15) * 60_000;
let catalogCache = { prices: null, forecourts: null, fetchedAtMs: 0, promise: null };

/**
 * Drop in-memory forecourt + price cache so the next snapshot build hits GOV again.
 * Snapshot refresh must call this; otherwise a new fuel-snapshots.json can get a fresh
 * capturedAt while still using catalog data from minutes ago (TTL reuse).
 */
export function invalidateFuelCatalogCache() {
  catalogCache = { prices: null, forecourts: null, fetchedAtMs: 0, promise: null };
}

/** GOV.UK stack sometimes uses api.fuelfinder.service.gov.uk in docs or redirects; that host often does not resolve in public DNS. www.fuel-finder.service.gov.uk does. */
function rewriteLegacyFuelfinderHost(inputUrl) {
  try {
    const u = new URL(inputUrl);
    if (u.hostname === "api.fuelfinder.service.gov.uk") {
      u.hostname = "www.fuel-finder.service.gov.uk";
    }
    return u.toString();
  } catch {
    return inputUrl;
  }
}

/**
 * Fetch with redirect: manual so we can rewrite Location to www before following.
 * Avoids ENOTFOUND when the server redirects to api.fuelfinder.service.gov.uk.
 */
async function fetchFuelFinder(inputUrl, init = {}) {
  let url = rewriteLegacyFuelfinderHost(inputUrl);
  let method = init.method || "GET";
  let headers = init.headers && typeof init.headers === "object" ? { ...init.headers } : {};
  let body = init.body;

  for (let hop = 0; hop < 10; hop++) {
    let res;
    try {
      res = await fetch(url, { method, headers, body, redirect: "manual" });
    } catch (err) {
      throw err;
    }
    if (res.status < 300 || res.status >= 400) return res;
    const loc = res.headers.get("location") || res.headers.get("Location");
    if (!loc) return res;
    url = rewriteLegacyFuelfinderHost(new URL(loc, url).toString());
    if (res.status === 303) {
      method = "GET";
      body = undefined;
      delete headers["Content-Type"];
    }
  }
  const e = new Error("Too many redirects from Fuel Finder API");
  e.status = 502;
  e.statusCode = 502;
  throw e;
}

/** Turn undici/node fetch failures into HTTP 502–style errors (not generic 500). */
function mapFetchError(err, what) {
  const c = err && err.cause;
  const code = c && typeof c === "object" && c.code != null ? String(c.code) : "";
  const host = c && typeof c === "object" && c.hostname != null ? String(c.hostname) : "";
  const tail = code ? ` (${code}${host ? ": " + host : ""})` : "";
  const e = new Error(
    `${what}: ${err && err.message ? err.message : "network error"}${tail}. ` +
      `If you see ENOTFOUND for api.fuelfinder.service.gov.uk, this server rewrites that host to www.fuel-finder.service.gov.uk — restart Node after updating. Otherwise copy exact URLs from the developer portal into FUEL_FINDER_TOKEN_URL and FUEL_FINDER_API_BASE.`
  );
  e.status = 502;
  e.statusCode = 502;
  return e;
}

function num(v) {
  if (v == null || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function isTrueLike(v) {
  return typeof v === "string" && /^(1|true|yes|on)$/i.test(v.trim());
}

function tokenUrlCandidates() {
  const configured = rewriteLegacyFuelfinderHost(
    process.env.FUEL_FINDER_TOKEN_URL?.trim() || DEFAULT_TOKEN_URL
  );
  const out = [configured];
  try {
    const u = new URL(configured);
    if (/generate_secret_token$/i.test(u.pathname)) {
      u.pathname = u.pathname.replace(/generate_secret_token$/i, "generate_access_token");
      out.push(u.toString());
    }
  } catch {
    // Keep configured URL only.
  }
  return Array.from(new Set(out));
}

function buildTokenRequestVariants(client_id, client_secret, scope, preferJson) {
  const jsonPayload = { client_id, client_secret };
  if (scope) jsonPayload.scope = scope;
  const jsonInit = {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify(jsonPayload),
  };

  const formBody = new URLSearchParams({
    grant_type: "client_credentials",
    client_id,
    client_secret,
  });
  if (scope) formBody.set("scope", scope);
  const formInit = {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
    },
    body: formBody,
  };

  return preferJson
    ? [
        { mode: "json", init: jsonInit },
        { mode: "form", init: formInit },
      ]
    : [
        { mode: "form", init: formInit },
        { mode: "json", init: jsonInit },
      ];
}

/** OAuth2 uses access_token; Fuel Finder may return secret_token inside { success, data }. */
function pickAccessToken(data, depth = 0) {
  if (!data || typeof data !== "object" || depth > 3) return null;
  if (data.success === true && data.data && typeof data.data === "object") {
    const inner = pickAccessToken(data.data, depth + 1);
    if (inner) return inner;
  }
  for (const k of ["access_token", "token", "secret_token", "bearer_token"]) {
    const v = data[k];
    if (typeof v === "string" && v.trim()) return v.trim();
  }
  if (data.data && typeof data.data === "object") return pickAccessToken(data.data, depth + 1);
  return null;
}

/** Error bodies from www.fuel-finder.service.gov.uk often use { success, data: { message } }. */
function pickFuelFinderErrorMessage(data) {
  if (!data || typeof data !== "object") return "";
  const inner = data.data;
  if (inner && typeof inner === "object") {
    if (typeof inner.message === "string" && inner.message.trim()) return inner.message.trim();
    if (typeof inner.error === "string" && inner.error.trim()) return inner.error.trim();
  }
  if (typeof data.message === "string" && data.message.trim() && !/^\s*[\[{]/.test(data.message)) {
    return data.message.trim();
  }
  return "";
}

export function hasFuelFinderCredentials() {
  return Boolean(
    process.env.FUEL_CLIENT_ID?.trim() && process.env.FUEL_CLIENT_SECRET?.trim()
  );
}

export function fuelFinderStartupSummary() {
  if (!hasFuelFinderCredentials()) return null;
  const id = process.env.FUEL_CLIENT_ID.trim();
  return {
    apiBase: rewriteLegacyFuelfinderHost(
      process.env.FUEL_FINDER_API_BASE?.trim() || DEFAULT_API_BASE
    ),
    clientHint: `${id.slice(0, 6)}…${id.slice(-4)}`,
  };
}

async function fetchToken() {
  const client_id = process.env.FUEL_CLIENT_ID?.trim();
  const client_secret = process.env.FUEL_CLIENT_SECRET?.trim();
  if (!client_id || !client_secret) {
    const e = new Error("Missing FUEL_CLIENT_ID or FUEL_CLIENT_SECRET in server/.env");
    e.status = 500;
    throw e;
  }

  const tokenUrls = tokenUrlCandidates();
  // Official Fuel Finder endpoint uses JSON; env can force form mode for legacy/proxy setups.
  const useJsonBody = process.env.FUEL_FINDER_TOKEN_JSON_BODY == null
    ? true
    : isTrueLike(process.env.FUEL_FINDER_TOKEN_JSON_BODY);
  const scope = process.env.FUEL_FINDER_OAUTH_SCOPE?.trim();
  const requestVariants = buildTokenRequestVariants(client_id, client_secret, scope, useJsonBody);
  const attemptLabels = [];
  let lastErr = null;

  for (const tokenUrl of tokenUrls) {
    for (const variant of requestVariants) {
      attemptLabels.push(`${tokenUrl} (${variant.mode})`);
      let res;
      try {
        res = await fetchFuelFinder(tokenUrl, variant.init);
      } catch (err) {
        lastErr = mapFetchError(err, "Cannot reach Fuel Finder token URL");
        continue;
      }

      const text = await res.text();
      let data;
      try {
        data = JSON.parse(text);
      } catch {
        data = { raw: text };
      }

      if (!res.ok) {
        const govMsg = pickFuelFinderErrorMessage(data);
        const msg =
          govMsg ||
          (typeof data.error_description === "string" ? data.error_description : "") ||
          (typeof data.message === "string" ? data.message : "") ||
          `OAuth token request failed (HTTP ${res.status})`;
        const err = new Error(msg);
        err.status = res.status >= 400 && res.status < 600 ? res.status : 502;
        err.data = data;
        lastErr = err;
        continue;
      }

      if (data && data.success === false) {
        const err = new Error(
          pickFuelFinderErrorMessage(data) || "Token endpoint returned success: false — check portal credentials and app activation."
        );
        err.status = 400;
        err.data = data;
        lastErr = err;
        continue;
      }

      const access_token = pickAccessToken(data);
      if (!access_token) {
        const err = new Error(
          "Token response missing access_token (or token / secret_token) — check FUEL_FINDER_TOKEN_URL and the expected payload mode."
        );
        err.status = 502;
        err.data = data;
        lastErr = err;
        continue;
      }

      const expiresIn =
        num(data.expires_in) ??
        num(data.expiresIn) ??
        num(data.expires_in_seconds) ??
        num(data.data?.expires_in) ??
        num(data.data?.expiresIn) ??
        3600;
      cache = {
        accessToken: access_token,
        expiresAtMs: Date.now() + Math.max(60, expiresIn - 120) * 1000,
      };
      return cache.accessToken;
    }
  }

  const err = lastErr || new Error("OAuth token request failed");
  if (!err.status) err.status = 502;
  err.message = `${err.message} (tried: ${attemptLabels.join(" | ")})`;
  throw err;
}

export async function getAccessToken() {
  if (cache.accessToken && Date.now() < cache.expiresAtMs) {
    return cache.accessToken;
  }
  if (tokenFetchPromise) return tokenFetchPromise;
  tokenFetchPromise = fetchToken().finally(() => {
    tokenFetchPromise = null;
  });
  return tokenFetchPromise;
}

/** Nearest postcode for lat/lng (postcodes.io). */
export async function nearestPostcode(lat, lng) {
  let r;
  try {
    r = await fetch(
      `https://api.postcodes.io/postcodes?lon=${encodeURIComponent(lng)}&lat=${encodeURIComponent(lat)}`
    );
  } catch (err) {
    throw mapFetchError(err, "Cannot reach postcodes.io");
  }
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !j.result?.length) {
    const err = new Error("Could not resolve a UK postcode for this location.");
    err.status = 400;
    throw err;
  }
  return String(j.result[0].postcode || "").replace(/\s+/g, "");
}

async function postcodeToCoordinates(postcode) {
  const pc = String(postcode || "").replace(/\s+/g, "").toUpperCase();
  if (!pc) {
    const err = new Error("Postcode is required.");
    err.status = 400;
    throw err;
  }
  let r;
  try {
    r = await fetch(`https://api.postcodes.io/postcodes/${encodeURIComponent(pc)}`);
  } catch (err) {
    throw mapFetchError(err, "Cannot reach postcodes.io");
  }
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !j.result) {
    const err = new Error("Could not resolve that UK postcode.");
    err.status = 400;
    throw err;
  }
  return {
    lat: num(j.result.latitude),
    lng: num(j.result.longitude),
  };
}

/** Resolve UK postcode to coordinates for server-side cohort builds. */
export async function geocodeUKPostcode(postcode) {
  return postcodeToCoordinates(postcode);
}

function haversineKm(lat1, lon1, lat2, lon2) {
  const toRad = (d) => (d * Math.PI) / 180;
  const R = 6371;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) *
      Math.sin(dLon / 2) * Math.sin(dLon / 2);
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function coerceRows(data) {
  if (Array.isArray(data)) return data;
  if (!data || typeof data !== "object") return [];
  if (Array.isArray(data.data)) return data.data;
  if (data.data && typeof data.data === "object" && Array.isArray(data.data.data)) {
    return data.data.data;
  }
  return [];
}

async function fetchFuelFinderJson(url, token) {
  let res;
  try {
    res = await fetchFuelFinder(url, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/json",
      },
    });
  } catch (err) {
    throw mapFetchError(err, "Cannot reach Fuel Finder API");
  }

  const text = await res.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    data = { raw: text };
  }

  return {
    ok: res.ok,
    status: res.status,
    data,
    retryAfter: res.headers.get("retry-after") || res.headers.get("Retry-After") || null,
  };
}

async function fetchPagedFuelFinderRows(base, path, token) {
  const normalizedPath = path.startsWith("/") ? path : `/${path}`;
  const all = [];
  const seenIds = new Set();
  const maxBatches = Math.max(1, Number(process.env.FUEL_FINDER_MAX_BATCHES) || 50);

  for (let batch = 1; batch <= maxBatches; batch++) {
    const url = new URL(`${base}${normalizedPath}`);
    url.searchParams.set("batch-number", String(batch));

    const page = await fetchFuelFinderJson(url.toString(), token);
    if (!page.ok) {
      // For batch pagination APIs, a 404 beyond the last batch can be expected.
      if (page.status === 404 && batch > 1) break;
      return page;
    }

    const rows = coerceRows(page.data);
    if (!rows.length) break;

    let addedThisPage = 0;
    for (const row of rows) {
      const id = String(row?.node_id ?? row?.nodeId ?? row?.site_id ?? row?.id ?? "");
      if (id && seenIds.has(id)) continue;
      if (id) seenIds.add(id);
      all.push(row);
      addedThisPage += 1;
    }

    if (addedThisPage === 0 || rows.length < 500) break;
  }

  return { ok: true, status: 200, data: all, retryAfter: null };
}

/** Prefer earlier names in `names` (e.g. b7 before diesel) when multiple rows match. */
function pickPricePoint(prices, names) {
  if (!Array.isArray(prices)) return null;
  const want = names.map((s) => String(s).toLowerCase());
  for (const name of want) {
    for (const p of prices) {
      const t = String(p?.fuel_type ?? p?.fuelType ?? "").toLowerCase();
      if (t !== name) continue;
      const n = num(p?.price);
      if (n != null) return n;
    }
  }
  return null;
}

/**
 * Keep B7-grade diesel from GOV fuel_prices[].
 * Prefer explicit B7 / B7_STANDARD; accept fuel_type "diesel" as standard road diesel (B7) when B7 absent.
 * Never include petrol (E10, E5, unleaded) or SDV.
 */
function pricesObjectB7Only(fuelPrices) {
  if (!Array.isArray(fuelPrices)) return {};
  let explicitB7 = null;
  let b7Standard = null;
  let dieselAlias = null;
  for (const p of fuelPrices) {
    const kRaw = String(p?.fuel_type ?? "").trim();
    const v = num(p?.price);
    if (!kRaw || v == null) continue;
    const kNorm = kRaw.toUpperCase().replace(/\s+/g, "_");
    if (
      kNorm === "SDV" ||
      kNorm === "E10" ||
      kNorm === "E5" ||
      kNorm === "UNLEADED" ||
      kNorm === "PETROL"
    ) {
      continue;
    }
    if (kNorm === "B7") explicitB7 = v;
    else if (kNorm === "B7_STANDARD") b7Standard = v;
    else if (kNorm === "DIESEL") dieselAlias = v;
  }
  const out = {};
  if (explicitB7 != null) out.B7 = explicitB7;
  else if (dieselAlias != null) out.B7 = dieselAlias;
  if (b7Standard != null) out.B7_STANDARD = b7Standard;
  return out;
}

/**
 * GOV price_last_updated for the same B7 diesel row we surface in pricesObjectB7Only + pickDisplayPrice
 * (B7, else DIESEL→B7, else B7_STANDARD). Do not use the first fuel in the array — that is often E10
 * with a recent timestamp while B7 diesel is days old.
 */
function b7DisplayPriceLastUpdatedIso(fuelPrices) {
  if (!Array.isArray(fuelPrices)) return null;
  let explicitB7 = null;
  let b7Standard = null;
  let dieselAlias = null;
  let uB7 = null;
  let uStd = null;
  let uDiesel = null;
  for (const p of fuelPrices) {
    const kRaw = String(p?.fuel_type ?? "").trim();
    const v = num(p?.price);
    if (!kRaw || v == null) continue;
    const kNorm = kRaw.toUpperCase().replace(/\s+/g, "_");
    if (
      kNorm === "SDV" ||
      kNorm === "E10" ||
      kNorm === "E5" ||
      kNorm === "UNLEADED" ||
      kNorm === "PETROL"
    ) {
      continue;
    }
    const upd = typeof p?.price_last_updated === "string" ? p.price_last_updated.trim() : null;
    if (kNorm === "B7") {
      explicitB7 = v;
      uB7 = upd;
    } else if (kNorm === "B7_STANDARD") {
      b7Standard = v;
      uStd = upd;
    } else if (kNorm === "DIESEL") {
      dieselAlias = v;
      uDiesel = upd;
    }
  }
  if (explicitB7 != null) return uB7;
  if (dieselAlias != null) return uDiesel;
  if (b7Standard != null) return uStd;
  return null;
}

/**
 * Strip a flat prices map to B7 diesel only (never pass E10/petrol to the client).
 */
export function extractB7PricesRecord(pr) {
  if (!pr || typeof pr !== "object") return {};
  const out = {};
  for (const k of Object.keys(pr)) {
    const ku = String(k).toUpperCase().replace(/\s+/g, "_");
    if (ku === "B7" || ku === "B7_STANDARD") out[k] = pr[k];
  }
  if (Object.keys(out).length === 0) {
    const d = num(pr.diesel ?? pr.Diesel);
    if (d != null) out.B7 = d;
  }
  return out;
}

export function dieselPenceFromPricesRecord(pr) {
  if (!pr || typeof pr !== "object") return null;
  let v = num(pr.B7 ?? pr.b7 ?? pr.B7_STANDARD ?? pr.b7_standard);
  if (v != null) return v;
  v = num(pr.diesel ?? pr.Diesel);
  if (v != null) return v;
  return null;
}

function flattenAddress(row) {
  const loc = row && row.location && typeof row.location === "object" ? row.location : {};
  return [
    row?.address,
    loc.address_line_1,
    loc.address_line_2,
    loc.city,
    loc.county,
    loc.postcode,
  ]
    .filter(Boolean)
    .join(", ");
}

async function ensureCatalog() {
  if (
    catalogCache.prices &&
    catalogCache.forecourts &&
    Date.now() - catalogCache.fetchedAtMs < CATALOG_TTL_MS
  ) {
    return catalogCache;
  }
  if (catalogCache.promise) return catalogCache.promise;
  catalogCache.promise = (async () => {
    const token = await getAccessToken();
    const base = rewriteLegacyFuelfinderHost(
      (process.env.FUEL_FINDER_API_BASE?.trim() || DEFAULT_API_BASE).replace(/\/$/, "")
    );
    const pricesPath = process.env.FUEL_FINDER_PRICES_PATH?.trim() || DEFAULT_PRICES_PATH;
    const forecourtsPath =
      process.env.FUEL_FINDER_FORECOURTS_PATH?.trim() || DEFAULT_FORECOURTS_PATH;

    const [pricesPage, forecourtsPage] = await Promise.all([
      fetchPagedFuelFinderRows(base, pricesPath, token),
      fetchPagedFuelFinderRows(base, forecourtsPath, token),
    ]);

    if (!pricesPage.ok || !forecourtsPage.ok) {
      catalogCache.promise = null;
      return { prices: pricesPage, forecourts: forecourtsPage, error: true };
    }

    const pricesByNodeId = new Map();
    for (const row of pricesPage.data) {
      const id = row?.node_id ?? row?.nodeId ?? row?.site_id ?? row?.id;
      if (!id) continue;
      pricesByNodeId.set(String(id), Array.isArray(row?.fuel_prices) ? row.fuel_prices : []);
    }

    catalogCache.prices = pricesByNodeId;
    catalogCache.forecourts = forecourtsPage.data;
    catalogCache.fetchedAtMs = Date.now();
    catalogCache.promise = null;
    return catalogCache;
  })();
  return catalogCache.promise;
}

/**
 * Full normalized station catalog from latest upstream dataset.
 * Used by snapshot jobs and cohort/metrics calculations.
 */
export async function fetchCatalogStationsSnapshot() {
  const catalog = await ensureCatalog();
  if (catalog.error) {
    if (!catalog.prices?.ok) return catalog.prices;
    return catalog.forecourts;
  }

  const out = [];
  for (const row of catalog.forecourts) {
    const id = row?.node_id ?? row?.nodeId ?? row?.site_id ?? row?.id;
    const loc = row?.location && typeof row.location === "object" ? row.location : {};
    const lat = num(row?.latitude ?? row?.lat ?? loc?.latitude);
    const lng = num(row?.longitude ?? row?.lng ?? loc?.longitude ?? loc?.lon);
    if (lat == null || lng == null) continue;

    const fuelPrices = id ? catalog.prices.get(String(id)) || [] : [];
    const stationKind = classifyStationKind(row);
    out.push({
      stationId: id != null ? String(id) : null,
      stationKind,
      name: row?.trading_name ?? row?.brand_name ?? row?.brand ?? row?.name ?? "Station",
      address: flattenAddress(row),
      postcode: String(loc?.postcode ?? row?.postcode ?? ""),
      lat,
      lng,
      prices: pricesObjectB7Only(fuelPrices),
      lastUpdated: b7DisplayPriceLastUpdatedIso(fuelPrices),
    });
  }

  return {
    ok: true,
    status: 200,
    data: {
      capturedAt: new Date().toISOString(),
      stations: out,
      count: out.length,
    },
    retryAfter: null,
  };
}

async function fetchCatalogNearby(postcode, radiusKm, originLatIn, originLngIn) {
  const catalog = await ensureCatalog();
  if (catalog.error) {
    if (!catalog.prices?.ok) return catalog.prices;
    return catalog.forecourts;
  }

  let originLat = num(originLatIn);
  let originLng = num(originLngIn);
  if (originLat == null || originLng == null) {
    const geo = await postcodeToCoordinates(postcode);
    originLat = geo.lat;
    originLng = geo.lng;
  }

  const out = [];
  for (const row of catalog.forecourts) {
    const id = row?.node_id ?? row?.nodeId ?? row?.site_id ?? row?.id;
    const loc = row?.location && typeof row.location === "object" ? row.location : {};
    const lat = num(row?.latitude ?? row?.lat ?? loc?.latitude);
    const lng = num(row?.longitude ?? row?.lng ?? loc?.longitude ?? loc?.lon);
    if (lat == null || lng == null) continue;

    const d = haversineKm(originLat, originLng, lat, lng);
    if (!(d <= radiusKm)) continue;

    const fuelPrices = id ? catalog.prices.get(String(id)) || [] : [];
    const stationKind = classifyStationKind(row);
    out.push({
      name: row?.trading_name ?? row?.brand_name ?? row?.brand ?? row?.name ?? "Station",
      address: flattenAddress(row),
      postcode: String(loc?.postcode ?? row?.postcode ?? ""),
      lat,
      lng,
      stationId: id ?? null,
      stationKind,
      distance_km: d,
      prices: pricesObjectB7Only(fuelPrices),
      petrolPence: null,
      dieselPence: pickPricePoint(fuelPrices, ["b7", "b7_standard", "diesel"]),
      last_updated: b7DisplayPriceLastUpdatedIso(fuelPrices),
    });
  }

  return { ok: true, status: 200, data: { data: out }, retryAfter: null };
}

function pickPriceRows(raw) {
  if (Array.isArray(raw)) return raw;
  if (!raw || typeof raw !== "object") return [];
  for (const k of ["data", "results", "stations", "items", "forecourts", "sites"]) {
    if (Array.isArray(raw[k])) return raw[k];
  }
  return [];
}

export function normalizeStation(row) {
  if (!row || typeof row !== "object") return null;
  const loc = row.location && typeof row.location === "object" ? row.location : {};
  const prRaw =
    row.prices && typeof row.prices === "object"
      ? row.prices
      : row.fuelPrices && typeof row.fuelPrices === "object"
        ? row.fuelPrices
        : {};

  const lat = num(row.latitude ?? row.lat ?? loc.latitude);
  const lng = num(row.longitude ?? row.lng ?? loc.longitude ?? loc.lon);
  const d = num(row.distance ?? row.distanceKm ?? row.distance_km);

  const stationKind =
    row.stationKind && ["supermarket", "motorway", "independent"].includes(String(row.stationKind))
      ? String(row.stationKind)
      : classifyStationKind(row);

  const prB7 = extractB7PricesRecord(prRaw);

  return {
    name: String(row.brand ?? row.name ?? row.trading_name ?? row.site_name ?? "Station"),
    address: String(row.address ?? row.line1 ?? ""),
    postcode: String(row.postcode ?? ""),
    lat,
    lng,
    petrolPence: null,
    dieselPence: dieselPenceFromPricesRecord(prRaw) ?? num(row.dieselPence),
    distanceKm: d != null ? Math.round(d * 10) / 10 : null,
    stationId: row.stationId ?? row.node_id ?? row.site_id ?? row.id ?? row.uprn ?? null,
    stationKind,
    prices: prB7,
    lastUpdated: row.last_updated ?? row.updated_at ?? row.price_updated_at ?? null,
  };
}

export function normalizeRows(raw) {
  const rows = pickPriceRows(raw);
  const stations = [];
  for (const row of rows) {
    const s = normalizeStation(row);
    if (s) stations.push(s);
  }
  return { stations, rawCount: rows.length };
}

/**
 * GET prices near a postcode. Query param names default to q + radius (km); override via env.
 */
export async function fetchPricesNearPostcode(postcode, radiusKm, lat, lng) {
  const normalizedPath = (process.env.FUEL_FINDER_PRICES_PATH?.trim() || DEFAULT_PRICES_PATH)
    .trim()
    .toLowerCase();
  if (normalizedPath === "/pfs/fuel-prices" || normalizedPath === "pfs/fuel-prices") {
    return fetchCatalogNearby(postcode, radiusKm, lat, lng);
  }

  const token = await getAccessToken();
  const base = rewriteLegacyFuelfinderHost(
    (process.env.FUEL_FINDER_API_BASE?.trim() || DEFAULT_API_BASE).replace(/\/$/, "")
  );
  const path = process.env.FUEL_FINDER_PRICES_PATH?.trim() || DEFAULT_PRICES_PATH;
  const qParam = process.env.FUEL_FINDER_POSTCODE_PARAM?.trim() || "q";
  const radiusParam = process.env.FUEL_FINDER_RADIUS_PARAM?.trim() || "radius";

  const url = new URL(`${base}${path.startsWith("/") ? path : `/${path}`}`);
  const pc = String(postcode).replace(/\s+/g, "").toUpperCase();
  url.searchParams.set(qParam, pc);
  url.searchParams.set(radiusParam, String(radiusKm));

  let res;
  try {
    res = await fetchFuelFinder(url.toString(), {
      method: "GET",
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/json",
      },
    });
  } catch (err) {
    throw mapFetchError(err, "Cannot reach Fuel Finder prices API");
  }

  const text = await res.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    data = { raw: text };
  }

  const retryAfter =
    res.headers.get("retry-after") || res.headers.get("Retry-After") || null;

  if (res.status === 429 && process.env.FUEL_DEBUG_UPSTREAM === "1") {
    console.warn("[Fuel Finder] HTTP 429", url.origin + url.pathname, String(text).slice(0, 400));
  }

  return { ok: res.ok, status: res.status, data, retryAfter };
}

export function upstreamErrorMessage(status, data) {
  const raw =
    data && typeof data === "object"
      ? [
          typeof data.message === "string" ? data.message.trim() : "",
          typeof data.detail === "string" ? data.detail.trim() : "",
          typeof data.error === "string" ? data.error.trim() : "",
          data.error && typeof data.error === "object" && typeof data.error.message === "string"
            ? data.error.message.trim()
            : "",
        ]
          .filter(Boolean)
          .join(" ")
      : "";

  if (status === 429) {
    if (/rapidapi/i.test(raw)) {
      return (
        "HTTP 429 with a RapidAPI-style message — this app only calls the GOV.UK Fuel Finder API. " +
        "Check server/.env: FUEL_FINDER_API_BASE and FUEL_FINDER_TOKEN_URL must be fuelfinder.service.gov.uk hosts (see developer portal). " +
        "Restart the Node server after changes, hard-refresh the browser, and wait before retrying."
      );
    }
    return (
      (raw || "Too many requests from the Fuel Finder API.") +
      " Wait a few minutes and try again, or check usage limits in the developer portal."
    );
  }

  if (data && typeof data === "object") {
    if (typeof data.message === "string" && data.message.trim()) return data.message.trim();
    if (typeof data.detail === "string" && data.detail.trim()) return data.detail.trim();
    if (typeof data.error === "string" && data.error.trim()) return data.error.trim();
    if (data.error && typeof data.error === "object" && typeof data.error.message === "string") {
      return data.error.message.trim();
    }
  }
  return `Fuel Finder API returned HTTP ${status}. See server logs and official API documentation.`;
}
