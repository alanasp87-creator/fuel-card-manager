import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH = path.join(__dirname, "..", "fuel-stations-db.json");

function loadDb() {
  try {
    const raw = fs.readFileSync(DB_PATH, "utf8");
    const j = JSON.parse(raw);
    return {
      stations: Array.isArray(j.stations) ? j.stations : [],
      lastSync: j.lastSync || null,
      syncCount: j.syncCount || 0,
    };
  } catch {
    return { stations: [], lastSync: null, syncCount: 0 };
  }
}

function saveDb(db) {
  fs.writeFileSync(DB_PATH, JSON.stringify(db, null, 2), "utf8");
}

export function getStations(filter = {}) {
  const db = loadDb();
  let results = db.stations;

  if (filter.postcode) {
    const pc = String(filter.postcode).toUpperCase().trim();
    results = results.filter((s) => String(s.postcode || "").toUpperCase().includes(pc));
  }

  if (filter.minPrice !== undefined) {
    const min = Number(filter.minPrice);
    results = results.filter((s) => {
      const price = s.prices?.B7 || s.prices?.diesel || 0;
      return price >= min;
    });
  }

  if (filter.maxPrice !== undefined) {
    const max = Number(filter.maxPrice);
    results = results.filter((s) => {
      const price = s.prices?.B7 || s.prices?.diesel || 0;
      return price <= max;
    });
  }

  if (filter.brand) {
    const brand = String(filter.brand).toLowerCase();
    results = results.filter((s) =>
      String(s.brand || s.name || "").toLowerCase().includes(brand)
    );
  }

  if (filter.limit) {
    const limit = Number(filter.limit);
    results = results.slice(0, limit);
  }

  return results;
}

export function saveStations(stations) {
  if (!Array.isArray(stations)) throw new Error("stations must be array");
  const db = {
    stations: stations,
    lastSync: new Date().toISOString(),
    syncCount: (loadDb().syncCount || 0) + 1,
  };
  saveDb(db);
  return db;
}

export function appendStations(newStations) {
  if (!Array.isArray(newStations)) throw new Error("stations must be array");
  const db = loadDb();
  const existing = new Map();
  db.stations.forEach((s) => {
    const key = `${s.name}|${s.postcode}`;
    existing.set(key, s);
  });

  newStations.forEach((s) => {
    const key = `${s.name}|${s.postcode}`;
    existing.set(key, s);
  });

  db.stations = Array.from(existing.values());
  db.lastSync = new Date().toISOString();
  db.syncCount = (db.syncCount || 0) + 1;
  saveDb(db);
  return db;
}

export function getDbStats() {
  const db = loadDb();
  return {
    totalStations: db.stations.length,
    lastSync: db.lastSync,
    syncCount: db.syncCount,
  };
}

export function clearDb() {
  saveDb({ stations: [], lastSync: null, syncCount: 0 });
}
