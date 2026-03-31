/**
 * Sync fuel stations from GOV.UK Fuel Finder API to local database.
 * Usage: node scripts/sync-fuel-stations.mjs
 *
 * Requires:
 *   - FUEL_CLIENT_ID in server/.env
 *   - FUEL_CLIENT_SECRET in server/.env
 */

import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";
import { saveStations, getDbStats } from "../lib/fuelStationsDb.mjs";
import { fetchCatalogStationsSnapshot } from "../lib/fuelFinderGov.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, "..", ".env") });

async function syncFuelStations() {
  console.log("Starting fuel stations sync from GOV.UK Fuel Finder API...");

  const clientId = process.env.FUEL_CLIENT_ID?.trim();
  const clientSecret = process.env.FUEL_CLIENT_SECRET?.trim();

  if (!clientId || !clientSecret) {
    console.error("❌ FUEL_CLIENT_ID and FUEL_CLIENT_SECRET required in .env");
    process.exit(1);
  }

  try {
    console.log("Fetching full catalog from GOV.UK API...");
    const result = await fetchCatalogStationsSnapshot();

    if (!result.ok) {
      console.error(`❌ API Error (HTTP ${result.status}):`, result.data);
      process.exit(1);
    }

    const stations = result.data?.stations || [];
    console.log(`✓ Retrieved ${stations.length} stations from GOV.UK API`);

    if (stations.length === 0) {
      console.error("❌ No stations retrieved from Fuel Finder API");
      process.exit(1);
    }

    // Transform to local format
    const transformed = stations.map((s) => ({
      stationId: s.stationId,
      name: s.name,
      brand: s.brand || s.stationKind,
      address: s.address,
      postcode: s.postcode,
      lat: s.lat,
      lng: s.lng,
      prices: s.prices || {},
      lastUpdated: s.lastUpdated,
      kind: s.stationKind,
    }));

    // Save to database
    saveStations(transformed);
    const stats = getDbStats();
    console.log(`\n✅ Sync complete!`);
    console.log(`   Total stations: ${stats.totalStations}`);
    console.log(`   Last sync: ${stats.lastSync}`);
    console.log(`   Sync count: ${stats.syncCount}`);
  } catch (e) {
    console.error("❌ Sync failed:", e.message || e);
    process.exit(1);
  }
}

syncFuelStations().catch((e) => {
  console.error("❌ Sync failed:", e);
  process.exit(1);
});
