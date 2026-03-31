/**
 * Loads server/.env and requests an OAuth token (and optional prices probe).
 * Run from server/: npm run verify-fuel-finder
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";
import {
  hasFuelFinderCredentials,
  getAccessToken,
  fetchPricesNearPostcode,
  fuelFinderStartupSummary,
} from "../lib/fuelFinderGov.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, "..", ".env") });

if (!hasFuelFinderCredentials()) {
  console.error("FUEL_CLIENT_ID / FUEL_CLIENT_SECRET missing in server/.env");
  process.exit(1);
}

const sum = fuelFinderStartupSummary();
console.log(`API base: ${sum.apiBase}  client: ${sum.clientHint}\n`);

try {
  await getAccessToken();
  console.log("OK — OAuth2 client_credentials token received.\n");
} catch (e) {
  console.error("Token failed:", e.message);
  if (e.cause) console.error("Cause:", e.cause.code || e.cause.message || e.cause);
  process.exit(1);
}

const probe = process.argv[2] || process.env.FUEL_FINDER_VERIFY_POSTCODE || "SW1A1AA";
const r = await fetchPricesNearPostcode(probe, 10);
if (!r.ok) {
  console.error("Prices probe failed:", r.status, JSON.stringify(r.data).slice(0, 500));
  process.exit(1);
}
console.log(`Prices probe OK (${probe}, 10 km). Top-level keys:`, Object.keys(r.data || {}));
console.log(JSON.stringify(r.data, null, 2).slice(0, 1500));
process.exit(0);
