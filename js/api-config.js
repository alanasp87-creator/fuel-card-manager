/**
 * Backend base URL (auth + GOV.UK Fuel Finder proxy on the same server).
 * Override with window.FUEL_API_PROXY_OVERRIDE when not on localhost:8787.
 */

window.FUEL_API_PROXY_OVERRIDE = (function () {
  var h = window.location.hostname;
  if (h && h.indexOf("localhost") === -1 && h.indexOf("127.0.0.1") === -1) {
    var proto = window.location.protocol || "https:";
    return proto + "//" + h + ":8080";
  }
  return "";
})();

function fuelIsPrivateLanHost(hostname) {
  return /^(10\.|192\.168\.|172\.(1[6-9]|2[0-9]|3[0-1])\.)/.test(hostname);
}

/** IPv6 loopback must be bracketed in URLs (http://::1 is invalid; http://[::1] is valid). */
function fuelHostnameForApiUrl(hostname) {
  var h = String(hostname || "");
  if (h === "::1" || h === "[::1]") return "[::1]";
  return h;
}

function fuelIsLoopbackOrLanHost(hostname) {
  var h = String(hostname || "");
  return (
    h === "localhost" ||
    h === "127.0.0.1" ||
    h === "::1" ||
    h === "[::1]" ||
    fuelIsPrivateLanHost(h)
  );
}

/**
 * Where the browser will call the Node server (auth + /nearby + /dashboard/*).
 * Order: FUEL_API_PROXY_OVERRIDE → same host as the page on port 8787 (localhost / LAN) → file: →
 * optional <meta name="fuel-api-base" content="http://host:8787"> → http://127.0.0.1:8787
 */
window.FUEL_FINDER_PROXY_BASE = (function () {
  var o = String(window.FUEL_API_PROXY_OVERRIDE || "").replace(/\/$/, "");
  if (o) return o;
  var h = window.location.hostname;
  var p = window.location.protocol;
  if (fuelIsLoopbackOrLanHost(h)) {
    return p + "//" + fuelHostnameForApiUrl(h) + ":8787";
  }
  if (p === "file:") return "http://127.0.0.1:8787";
  try {
    var metaEl =
      typeof document !== "undefined" &&
      document.querySelector &&
      document.querySelector('meta[name="fuel-api-base"]');
    var metaRaw = metaEl && metaEl.getAttribute("content") != null ? String(metaEl.getAttribute("content")).trim() : "";
    if (metaRaw) return metaRaw.replace(/\/$/, "");
  } catch (e) {}
  var fallback = "http://127.0.0.1:8787";
  try {
    console.warn(
      "[Fuel] API base unknown for hostname \"" +
        h +
        '". Using ' +
        fallback +
        " — start Node on port 8787, or set <meta name=\"fuel-api-base\" content=\"http://YOUR_HOST:8787\"> or window.FUEL_API_PROXY_OVERRIDE."
    );
  } catch (e) {}
  return fallback;
})();

window.FUEL_SUPABASE_ANON_KEY = "";

/** Force dev menu in Replit environments */
if (window.location.hostname && /replit\.dev$/.test(window.location.hostname)) {
  window.FUEL_FORCE_DEV_MENU = true;
}

/** Floating dev menu (skip login): localhost, loopback IPv6, LAN, or file://. Set window.FUEL_FORCE_DEV_MENU = true to override. */
window.FUEL_SHOW_DEV_MENU = (function () {
  if (window.FUEL_FORCE_DEV_MENU === true) return true;
  var h = window.location.hostname;
  if (window.location.protocol === "file:") return true;
  return fuelIsLoopbackOrLanHost(h);
})();

/* ── Fuel Finder proxy (GOV.UK via Node) ───────────────────────────── */

function proxyBase() {
  var b = String(window.FUEL_FINDER_PROXY_BASE || "").replace(/\/$/, "");
  if (!b) throw new Error("No API URL — run the Node server on port 8787.");
  return b;
}

function authHeaders() {
  var h = { Accept: "application/json" };
  var anon = String(window.FUEL_SUPABASE_ANON_KEY || "").trim();
  if (/supabase\.co\/functions\/v1\//i.test(proxyBase()) && anon) {
    h.Authorization = "Bearer " + anon;
    h.apikey = anon;
  }
  return h;
}

function isTrivialMessage(s) {
  if (typeof s !== "string") return true;
  var t = s.trim();
  if (!t) return true;
  if (/^error$/i.test(t)) return true;
  return false;
}

var FUEL_SETUP_HINT =
  "Add FUEL_CLIENT_ID and FUEL_CLIENT_SECRET to server/.env from the GOV.UK Fuel Finder developer portal, restart the server, then run: cd server && npm run verify-fuel-finder";

function deepFirstString(obj, maxLen, depth, seen) {
  if (depth === undefined) depth = 0;
  if (seen === undefined) seen = [];
  if (!obj || typeof obj !== "object" || depth > 5) return "";
  if (seen.indexOf(obj) !== -1) return "";
  seen.push(obj);
  var vals = Object.keys(obj)
    .sort()
    .map(function (k) {
      return obj[k];
    });
  for (var i = 0; i < vals.length; i++) {
    var v = vals[i];
    if (typeof v === "string") {
      var t = v.trim();
      if (t.length >= 8 && !isTrivialMessage(t)) return t.slice(0, maxLen);
    } else if (v && typeof v === "object") {
      var inner = deepFirstString(v, maxLen, depth + 1, seen);
      if (inner) return inner;
    }
  }
  return "";
}

function extractClientUpstreamText(d, maxLen) {
  if (maxLen === undefined) maxLen = 600;
  if (d == null) return "";
  if (typeof d === "string") {
    var ts = d.trim();
    return ts && !isTrivialMessage(ts) ? ts.slice(0, maxLen) : "";
  }
  if (typeof d !== "object") return "";

  if (typeof d.error === "string") {
    var errStr = d.error.trim();
    if (errStr && !isTrivialMessage(errStr)) return errStr.slice(0, maxLen);
  }
  if (d.error && typeof d.error === "object" && typeof d.error.message === "string") {
    var em0 = d.error.message.trim();
    if (em0 && !isTrivialMessage(em0)) return em0.slice(0, maxLen);
  }

  var keys = ["message", "msg", "detail", "description", "title", "reason"];
  for (var k = 0; k < keys.length; k++) {
    var v = d[keys[k]];
    if (typeof v === "string") {
      var t = v.trim();
      if (t && !isTrivialMessage(t)) return t.slice(0, maxLen);
    }
  }
  if (typeof d._unparsed === "string" && d._unparsed.trim()) {
    return d._unparsed.trim().slice(0, 200);
  }
  return deepFirstString(d, maxLen, 0, []);
}

function pickHttpErrorMessage(data, res, rawText) {
  var status = res.status;
  if (status === 501) {
    var m = extractClientUpstreamText(data);
    return (m || "This search is not available for the GOV.UK Fuel Finder API.") + " (HTTP 501)";
  }
  if (status === 429) {
    var ra = res.headers && res.headers.get ? res.headers.get("retry-after") : null;
    var tail = ra ? " Retry-After: " + ra + "s." : "";
    var rmsg = extractClientUpstreamText(data);
    if (rmsg && /rapidapi/i.test(rmsg)) {
      return (
        "Rate limited (HTTP 429). This app uses the GOV.UK Fuel Finder API only — a “RapidAPI” message usually means the wrong API URL in server/.env or an old server still running. Set FUEL_FINDER_API_BASE to the official host from the developer portal, restart Node, hard-refresh the page." +
        tail
      );
    }
    return (
      (rmsg || "Too many requests. Wait and try again, or check Fuel Finder portal usage limits.") +
      " (HTTP 429)" +
      tail
    );
  }
  if (status === 502) {
    var m502 = extractClientUpstreamText(data);
    return (
      (m502 ||
        "Your Node server could not reach the GOV.UK Fuel Finder API (DNS, firewall, offline host, or wrong URL).") +
      " See the server terminal, check FUEL_FINDER_TOKEN_URL and FUEL_FINDER_API_BASE in server/.env, run cd server && npm run verify-fuel-finder. (HTTP 502)"
    );
  }
  if (status === 500) {
    var m5 = extractClientUpstreamText(data);
    if (/ENOTFOUND|ECONNREFUSED|fetch failed|getaddrinfo|Cannot reach Fuel Finder/i.test(m5)) {
      var apiHint = /api\.fuelfinder\.service\.gov\.uk/i.test(m5)
        ? " The server rewrites api.fuelfinder.service.gov.uk → www.fuel-finder.service.gov.uk; pull latest code, restart Node, and ensure FUEL_FINDER_* use the www host or leave defaults."
        : " Set FUEL_FINDER_TOKEN_URL and FUEL_FINDER_API_BASE from the developer portal (prefer www.fuel-finder.service.gov.uk) and restart the server.";
      return m5 + " — " + apiHint + " (HTTP 500 upstream/network)";
    }
  }
  if (status === 403 || status === 401) {
    var a = extractClientUpstreamText(data);
    if (a) return a + " (HTTP " + status + ")";
    return FUEL_SETUP_HINT + " (HTTP " + status + ")";
  }
  var fromJson = extractClientUpstreamText(data);
  if (fromJson) return fromJson + " (HTTP " + status + ")";
  if (rawText && typeof rawText === "string") {
    var snippet = rawText.trim().replace(/\s+/g, " ").slice(0, 180);
    if (snippet && snippet.indexOf("<") !== 0) return snippet + " (HTTP " + status + ")";
  }
  return "Fuel API HTTP " + status + ". " + FUEL_SETUP_HINT;
}

async function apiFetch(path) {
  var url = proxyBase() + path;
  var res;
  try {
    res = await fetch(url, { method: "GET", headers: authHeaders() });
  } catch (e) {
    var em = e && e.message ? e.message : "network error";
    throw new Error("Could not reach " + url + " — is the Fuel server running (port 8787)? " + em);
  }
  var text = await res.text();
  var data = {};
  try {
    data = text ? JSON.parse(text) : {};
  } catch (parseErr) {
    data = { _unparsed: text.slice(0, 400) };
  }
  if (!res.ok) throw new Error(pickHttpErrorMessage(data, res, text));
  return data;
}

/** Match server/lib/stationKind.mjs so filters (Supermarket / Motorway) work if API omits stationKind. */
function inferStationKindClient(row) {
  var parts = [
    row.name,
    row.brand,
    row.trading_name,
    row.tradingName,
    row.address,
    row.site_name,
  ];
  var hay = parts
    .filter(function (x) {
      return x != null && String(x).trim() !== "";
    })
    .map(function (x) {
      return String(x).toLowerCase();
    })
    .join(" | ");
  if (!hay) return "independent";
  if (
    /\bwelcome\s+break\b/.test(hay) ||
    /\broadchef\b/.test(hay) ||
    /\bwestmorland\b/.test(hay) ||
    /\bmotorway\s+service/.test(hay) ||
    /\bmotorway\s+services\b/.test(hay) ||
    (/\bmoto\b/.test(hay) && !/\bpromo/.test(hay)) ||
    (/\bextra\b/.test(hay) &&
      /\b(motorway|service\s+area|services)\b/.test(hay) &&
      !/\btesco\b/.test(hay))
  ) {
    return "motorway";
  }
  if (
    /\btesco\b/.test(hay) ||
    /\bsainsbury/.test(hay) ||
    /\basda\b/.test(hay) ||
    /\bmorrisons\b/.test(hay) ||
    /\baldi\b/.test(hay) ||
    /\blidl\b/.test(hay) ||
    /\bwaitrose\b/.test(hay) ||
    /\bmarks\s*(?:&|and)\s*spencer\b/.test(hay) ||
    /\bm&s\b/.test(hay) ||
    /\bco-?op\b/.test(hay) ||
    /\biceland\b/.test(hay)
  ) {
    return "supermarket";
  }
  if (
    /\bM[0-9]{1,3}[a-z]?\b/.test(hay) &&
    /\bservices\b/.test(hay) &&
    !/\btesco\b/.test(hay)
  ) {
    return "motorway";
  }
  return "independent";
}

/** Used by profile saved list when dashboard rows predate stationKind. */
window.fuelInferStationKind = inferStationKindClient;

/** B7 diesel only — strip E10/petrol keys from upstream price maps. */
function extractB7PricesRecordClient(pr) {
  if (!pr || typeof pr !== "object") return {};
  var out = {};
  for (var k in pr) {
    if (!Object.prototype.hasOwnProperty.call(pr, k)) continue;
    var ku = String(k).toUpperCase().replace(/\s+/g, "_");
    if (ku === "B7" || ku === "B7_STANDARD") out[k] = pr[k];
  }
  if (Object.keys(out).length === 0) {
    var d = firstNumber(pr, ["diesel", "Diesel"]);
    if (d != null) out.B7 = d;
  }
  return out;
}

function dieselPenceFromPricesRecordClient(pr) {
  if (!pr || typeof pr !== "object") return null;
  var v = firstNumber(pr, ["B7", "b7", "B7_STANDARD", "b7_standard"]);
  if (v != null) return v;
  return firstNumber(pr, ["diesel", "Diesel"]);
}

function normalizeStation(row) {
  var prRaw = row.prices && typeof row.prices === "object" ? row.prices : {};
  var prB7 = extractB7PricesRecordClient(prRaw);
  var loc = row.location && typeof row.location === "object" ? row.location : {};

  var sk = row.stationKind;
  var stationKind =
    sk === "supermarket" || sk === "motorway" || sk === "independent"
      ? sk
      : inferStationKindClient(row);

  return {
    name: row.name ?? row.brand ?? row.tradingName ?? "Station",
    address: formatAddress(row),
    lat: row.lat ?? loc.latitude ?? loc.lat ?? row.latitude,
    lng: row.lng ?? loc.longitude ?? loc.lng ?? loc.lon ?? row.longitude ?? row.lon,
    distanceKm: row.distanceKm ?? row.distance_km ?? null,
    stationId: row.stationId ?? row.node_id ?? row.site_id ?? row.id,
    stationKind: stationKind,
    postcode: row.postcode ?? "",
    petrolPence: null,
    dieselPence: dieselPenceFromPricesRecordClient(prRaw) ?? firstNumber(row, ["dieselPence"]),
    prices: prB7,
    lastUpdated: row.lastUpdated ?? row.last_updated ?? null,
    mapUrl: row.mapUrl ?? row.url ?? null,
  };
}

function formatAddress(row) {
  if (row.address && typeof row.address === "string") return row.address;
  return [row.line1, row.line2, row.street, row.town, row.city, row.postcode]
    .filter(Boolean)
    .join(", ");
}

function firstNumber(obj, keys) {
  if (!obj || typeof obj !== "object") return null;
  for (var i = 0; i < keys.length; i++) {
    var v = obj[keys[i]];
    if (typeof v === "number" && !Number.isNaN(v)) return v;
  }
  return null;
}

function pickStationsHint(data) {
  if (!data || typeof data !== "object") return "";
  if (typeof data.message === "string") {
    var m = data.message.trim();
    if (m && !isTrivialMessage(m)) return m;
  }
  if (typeof data.error === "string") {
    var e = data.error.trim();
    if (e && !isTrivialMessage(e)) return e;
  }
  return "";
}

function normalizeStations(data) {
  var rows = data.stations ?? data.results ?? data.data ?? [];
  return {
    stations: rows.map(normalizeStation),
    hint: pickStationsHint(data),
    pagination: data.pagination || null,
    count: data.count ?? rows.length,
  };
}

window.fuelFinderSearch = async function (opts) {
  var q = new URLSearchParams();
  if (opts.postcode) q.set("postcode", opts.postcode.replace(/\s+/g, "").toUpperCase());
  if (opts.lat != null && opts.lng != null) {
    q.set("lat", opts.lat);
    q.set("lng", opts.lng);
  }
  q.set("radius_km", String(opts.radiusKm || 10));
  if (opts.kind === "supermarket" || opts.kind === "motorway" || opts.kind === "independent") {
    q.set("kind", opts.kind);
  }
  return normalizeStations(await apiFetch("/nearby?" + q));
};

window.fuelApiBrand = async function (brand, page, limit) {
  return normalizeStations(
    await apiFetch("/brand/" + encodeURIComponent(brand) + "?page=" + page + "&limit=" + limit)
  );
};

window.fuelApiFuelType = async function (type, page, limit) {
  return normalizeStations(
    await apiFetch("/fuel-type/" + encodeURIComponent(type) + "?page=" + page + "&limit=" + limit)
  );
};

window.fuelApiPrices = async function (min, max, page, limit) {
  var q = "?page=" + page + "&limit=" + limit;
  if (min) q += "&min=" + min;
  if (max) q += "&max=" + max;
  return normalizeStations(await apiFetch("/prices" + q));
};

window.fuelApiStations = async function (page, limit) {
  return normalizeStations(await apiFetch("/stations?page=" + page + "&limit=" + limit));
};

window.fuelApiStatus = async function () {
  return await apiFetch("/status");
};

window.fuelApiUpdates = async function () {
  return await apiFetch("/updates");
};

/**
 * GET /health — no login, no GOV Fuel Finder OAuth. Confirms the Node server is reachable.
 * Use this when snapshot refresh fails with 429 or auth errors.
 */
window.fuelPingBackendHealth = async function () {
  var base = String(window.FUEL_FINDER_PROXY_BASE || "").replace(/\/$/, "");
  if (!base) {
    return {
      ok: false,
      status: 0,
      base: "",
      message: "No API URL — start the server on port 8787 or set FUEL_FINDER_PROXY_BASE.",
    };
  }
  try {
    var res = await fetch(base + "/health", { method: "GET", cache: "no-store" });
    var text = await res.text();
    var body = null;
    try {
      body = text ? JSON.parse(text) : null;
    } catch (e) {
      body = null;
    }
    if (!res.ok) {
      return {
        ok: false,
        status: res.status,
        base: base,
        message: "HTTP " + res.status + " from /health",
      };
    }
    return {
      ok: true,
      status: res.status,
      base: base,
      body: body,
      message: "OK — " + base + "/health (" + res.status + ")" + (body && body.ok ? ", { ok: true }" : ""),
    };
  } catch (e) {
    return {
      ok: false,
      status: 0,
      base: base,
      message: (e && e.message ? e.message : "Network error") + " — is the server running?",
    };
  }
};
