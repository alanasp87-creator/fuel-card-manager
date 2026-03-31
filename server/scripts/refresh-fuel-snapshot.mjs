/**
 * Pull latest GOV.UK Fuel Finder data into fuel-snapshots.json and refresh user cohorts.
 * Usage: npm run refresh-snapshot   (from server/)
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";
import { hasFuelFinderCredentials } from "../lib/fuelFinderGov.mjs";
import { refreshFuelSnapshot, getFuelSnapshotMeta } from "../lib/fuelSnapshots.mjs";
import { refreshAllUserCohorts } from "../lib/fuelSync.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, "..", ".env") });

if (!hasFuelFinderCredentials()) {
  console.error("Missing FUEL_CLIENT_ID / FUEL_CLIENT_SECRET — set server/.env from the GOV Fuel Finder portal.");
  process.exit(1);
}

try {
  const snapshot = await refreshFuelSnapshot();
  const n = Array.isArray(snapshot.stations) ? snapshot.stations.length : 0;
  const meta = getFuelSnapshotMeta();
  console.log(`Snapshot OK: ${n} stations (captured ${meta.capturedAt || "?"})`);
  try {
    const cohorts = await refreshAllUserCohorts(snapshot);
    console.log(
      `Cohorts: updated=${cohorts.updated} skipped=${cohorts.skipped} failed=${cohorts.failed}`
    );
  } catch (e) {
    console.warn("Cohort refresh:", e && e.message ? e.message : e);
  }
} catch (e) {
  console.error(e && e.message ? e.message : e);
  process.exit(1);
}
