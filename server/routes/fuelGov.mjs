import express from "express";
import {
  hasFuelFinderCredentials,
  nearestPostcode,
  fetchPricesNearPostcode,
  normalizeRows,
  upstreamErrorMessage,
} from "../lib/fuelFinderGov.mjs";

export const fuelGovRouter = express.Router();

const NO_CREDS = "Set FUEL_CLIENT_ID and FUEL_CLIENT_SECRET in server/.env (GOV.UK Fuel Finder developer portal).";

const NOT_SUPPORTED =
  "This search mode is not supported with the GOV.UK Fuel Finder API. Use Nearby with a UK postcode or location.";

function noCredsStations(res) {
  res.status(200).json({ stations: [], message: NO_CREDS });
}

function wrap(fn) {
  return (req, res, next) => {
    Promise.resolve(fn(req, res)).catch(next);
  };
}

fuelGovRouter.get("/nearby", wrap(async (req, res) => {
  if (!hasFuelFinderCredentials()) {
    noCredsStations(res);
    return;
  }

  const postcodeIn = String(req.query.postcode || "").trim();
  const latQ = req.query.lat;
  const lngQ = req.query.lng;
  const radiusKm = Math.min(100, Math.max(1, Number(req.query.radius_km) || 10));
  const kindFilter = String(req.query.kind || "")
    .trim()
    .toLowerCase();

  let postcode = postcodeIn.replace(/\s+/g, "").toUpperCase();

  let clientLat = latQ != null && latQ !== "" ? Number(latQ) : null;
  let clientLng = lngQ != null && lngQ !== "" ? Number(lngQ) : null;
  if (clientLat != null && Number.isNaN(clientLat)) clientLat = null;
  if (clientLng != null && Number.isNaN(clientLng)) clientLng = null;

  try {
    if (!postcode) {
      if (clientLat == null || clientLng == null) {
        res.status(400).json({ error: "Provide postcode= or both lat= and lng=", stations: [] });
        return;
      }
      postcode = await nearestPostcode(clientLat, clientLng);
    }

    const r = await fetchPricesNearPostcode(postcode, radiusKm, clientLat, clientLng);
    if (!r.ok) {
      const st = r.status >= 400 && r.status < 600 ? r.status : 502;
      if (r.retryAfter != null && String(r.retryAfter).trim() !== "") {
        res.setHeader("Retry-After", String(r.retryAfter).trim());
      }
      res.status(st).json({
        stations: [],
        error: upstreamErrorMessage(r.status, r.data),
        source: "gov.uk-fuel-finder",
      });
      return;
    }

    const out = normalizeRows(r.data);
    out.stations.sort((a, b) => (a.distanceKm ?? 999) - (b.distanceKm ?? 999));
    let stations = out.stations;
    if (kindFilter === "supermarket" || kindFilter === "motorway" || kindFilter === "independent") {
      stations = stations.filter((s) => s.stationKind === kindFilter);
    }
    const msg =
      stations.length === 0
        ? `No stations returned within ${radiusKm} km of ${postcode}.`
        : undefined;
    res.json({
      stations,
      count: stations.length,
      source: "gov.uk-fuel-finder",
      ...(msg ? { message: msg } : {}),
    });
  } catch (e) {
    let st =
      e && typeof e.status === "number" && e.status >= 400 && e.status < 600
        ? e.status
        : undefined;
    if (st == null && e && typeof e.statusCode === "number" && e.statusCode >= 400 && e.statusCode < 600) {
      st = e.statusCode;
    }
    const msg = String(e && e.message ? e.message : "Server error");
    const causeCode = e && e.cause && typeof e.cause === "object" && e.cause.code != null ? String(e.cause.code) : "";
    if (st == null && /ENOTFOUND|ECONNREFUSED|ETIMEDOUT|CERT_|fetch failed|getaddrinfo/i.test(msg + " " + causeCode)) {
      st = 502;
    }
    if (st == null) st = 500;
    res.status(st).json({
      error: msg,
      stations: [],
      source: "gov.uk-fuel-finder",
    });
  }
}));

function notSupported(_req, res) {
  res.status(501).json({ stations: [], error: NOT_SUPPORTED, source: "gov.uk-fuel-finder" });
}

fuelGovRouter.get("/brand/:brand", notSupported);
fuelGovRouter.get("/fuel-type/:type", notSupported);
fuelGovRouter.get("/prices", notSupported);
fuelGovRouter.get("/stations", notSupported);
fuelGovRouter.get("/status", notSupported);
fuelGovRouter.get("/updates", notSupported);
