import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const HISTORY_PATH = path.join(__dirname, "..", "brent-crude-history.json");
const DIESEL_HISTORY_PATH = path.join(__dirname, "..", "diesel-price-history.json");

const BARREL_TO_LITRES = 158.987;
const DEFAULT_GBP_PER_USD = 0.79;
const BRENT_CSV_URL = "https://raw.githubusercontent.com/datasets/oil-prices/main/data/brent-daily.csv";

function loadHistory() {
  try {
    const raw = fs.readFileSync(HISTORY_PATH, "utf8");
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function saveHistory(entries) {
  fs.writeFileSync(HISTORY_PATH, JSON.stringify(entries, null, 2), "utf8");
}

function loadDieselHistory() {
  try {
    const raw = fs.readFileSync(DIESEL_HISTORY_PATH, "utf8");
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function saveDieselHistory(entries) {
  fs.writeFileSync(DIESEL_HISTORY_PATH, JSON.stringify(entries, null, 2), "utf8");
}

function barrelToPencePerLitre(usdPerBarrel, gbpPerUsd) {
  const rate = gbpPerUsd || DEFAULT_GBP_PER_USD;
  const gbpPerBarrel = usdPerBarrel * rate;
  const gbpPerLitre = gbpPerBarrel / BARREL_TO_LITRES;
  return Math.round(gbpPerLitre * 10000) / 100;
}

async function fetchExchangeRate() {
  try {
    const res = await fetch(
      "https://open.er-api.com/v6/latest/USD",
      { signal: AbortSignal.timeout(10_000) }
    );
    if (!res.ok) return DEFAULT_GBP_PER_USD;
    const data = await res.json();
    const gbp = data?.rates?.GBP;
    return typeof gbp === "number" && gbp > 0 ? gbp : DEFAULT_GBP_PER_USD;
  } catch {
    return DEFAULT_GBP_PER_USD;
  }
}

async function fetchBrentFromGitHub(gbpPerUsd) {
  const res = await fetch(BRENT_CSV_URL, { signal: AbortSignal.timeout(15_000) });
  if (!res.ok) return null;
  const text = await res.text();
  const lines = text.trim().split("\n");
  if (lines.length < 2) return null;

  const cutoff = new Date(Date.now() - 180 * 86400000).toISOString().slice(0, 10);
  const entries = [];

  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    const commaIdx = line.indexOf(",");
    if (commaIdx < 0) continue;
    const date = line.slice(0, commaIdx).trim();
    const price = parseFloat(line.slice(commaIdx + 1).trim());
    if (!date || !Number.isFinite(price) || price <= 0) continue;
    if (date < cutoff) continue;

    entries.push({
      date,
      usdPerBarrel: Math.round(price * 100) / 100,
      gbpPerUsd,
      pencePerLitre: barrelToPencePerLitre(price, gbpPerUsd),
      source: "datasets/oil-prices",
    });
  }

  return entries.length > 0 ? entries : null;
}

function generateSyntheticBrentHistory(days = 90) {
  const entries = [];
  const today = new Date();

  const basePrices = [
    72.5, 73.1, 72.8, 73.5, 74.2, 74.8, 75.1, 74.6, 73.9, 73.2,
    72.8, 73.4, 74.1, 74.9, 75.5, 76.2, 76.8, 77.1, 76.5, 75.8,
    75.2, 74.8, 75.3, 76.1, 76.8, 77.5, 78.2, 78.8, 78.3, 77.5,
    76.8, 76.2, 75.8, 76.4, 77.1, 77.8, 78.5, 79.1, 79.8, 80.2,
    79.5, 78.8, 78.2, 77.8, 78.3, 79.1, 79.8, 80.5, 81.2, 80.8,
    80.1, 79.5, 79.1, 79.8, 80.5, 81.2, 81.8, 81.3, 80.5, 79.8,
    79.2, 78.8, 79.5, 80.2, 80.8, 81.5, 82.1, 81.5, 80.8, 80.2,
    79.8, 80.5, 81.2, 81.8, 82.5, 83.1, 82.5, 81.8, 81.2, 80.8,
    81.5, 82.2, 82.8, 83.5, 84.1, 83.5, 82.8, 82.2, 81.8, 82.5,
  ];

  for (let i = 0; i < days; i++) {
    const d = new Date(today);
    d.setDate(d.getDate() - (days - 1 - i));
    if (d.getDay() === 0 || d.getDay() === 6) continue;

    const baseIdx = Math.min(i, basePrices.length - 1);
    const price = basePrices[baseIdx] + (Math.random() - 0.5) * 1.5;

    entries.push({
      date: d.toISOString().slice(0, 10),
      usdPerBarrel: Math.round(price * 100) / 100,
      gbpPerUsd: DEFAULT_GBP_PER_USD,
      pencePerLitre: barrelToPencePerLitre(price, DEFAULT_GBP_PER_USD),
      source: "synthetic",
    });
  }
  return entries;
}

export async function refreshBrentCrudeHistory() {
  const existing = loadHistory();
  const today = new Date().toISOString().slice(0, 10);

  if (existing.length > 0) {
    const latestDate = existing[existing.length - 1]?.date;
    if (latestDate === today && existing.some((e) => e.source !== "synthetic")) {
      return existing;
    }
  }

  const gbpPerUsd = await fetchExchangeRate();

  let liveEntries = null;
  try {
    liveEntries = await fetchBrentFromGitHub(gbpPerUsd);
  } catch (err) {
    console.warn("[brent-crude] GitHub fetch failed:", err?.message || err);
  }

  let updated;
  if (liveEntries && liveEntries.length > 0) {
    updated = liveEntries;
    console.log(`[brent-crude] Fetched ${liveEntries.length} live entries from datasets/oil-prices`);
  } else if (existing.length > 10 && existing.some((e) => e.source !== "synthetic")) {
    const last = existing[existing.length - 1];
    updated = [...existing];
    if (last.date !== today) {
      const variation = (Math.random() - 0.5) * 2;
      const newPrice = (last.usdPerBarrel || 80) + variation;
      updated.push({
        date: today,
        usdPerBarrel: Math.round(newPrice * 100) / 100,
        gbpPerUsd,
        pencePerLitre: barrelToPencePerLitre(newPrice, gbpPerUsd),
        source: "extrapolated",
      });
    }
    console.log(`[brent-crude] Live fetch unavailable, extrapolated from existing data`);
  } else {
    updated = generateSyntheticBrentHistory(90);
    console.log(`[brent-crude] No live data available, using synthetic fallback`);
  }

  updated.sort((a, b) => a.date.localeCompare(b.date));

  const cutoff = new Date(Date.now() - 180 * 86400000).toISOString().slice(0, 10);
  const trimmed = updated.filter((e) => e.date >= cutoff);

  saveHistory(trimmed);
  return trimmed;
}

export function getBrentCrudeHistory() {
  const history = loadHistory();
  if (history.length === 0) {
    const synthetic = generateSyntheticBrentHistory(90);
    saveHistory(synthetic);
    return synthetic;
  }
  return history;
}

export function getLatestBrentPrice() {
  const history = getBrentCrudeHistory();
  return history.length > 0 ? history[history.length - 1] : null;
}

export function recordDieselPrice(date, avgPpl, minPpl, maxPpl) {
  if (avgPpl == null || !Number.isFinite(avgPpl)) return;
  const history = loadDieselHistory();
  const existing = history.find((e) => e.date === date);
  if (existing) {
    existing.avg = avgPpl;
    if (minPpl != null) existing.min = minPpl;
    if (maxPpl != null) existing.max = maxPpl;
  } else {
    history.push({
      date,
      avg: Math.round(avgPpl * 10) / 10,
      min: minPpl != null ? Math.round(minPpl * 10) / 10 : null,
      max: maxPpl != null ? Math.round(maxPpl * 10) / 10 : null,
    });
  }
  history.sort((a, b) => a.date.localeCompare(b.date));
  const cutoff = new Date(Date.now() - 180 * 86400000).toISOString().slice(0, 10);
  const trimmed = history.filter((e) => e.date >= cutoff);
  saveDieselHistory(trimmed);
}

export function getDieselPriceHistory() {
  return loadDieselHistory();
}
