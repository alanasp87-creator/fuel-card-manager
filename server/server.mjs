/**
 * Fuel backend — Express + auth (Supabase or users.json).
 *
 *   npm start   (from server/)   or   node server.mjs from this folder
 *
 * Loads server/.env from this file's directory — not process.cwd().
 * Env: see .env.example
 */

import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";
import { createApp } from "./app.mjs";
import { isSupabaseAuthEnabled } from "./lib/supabaseAuth.mjs";
import { devAuthEnabled } from "./lib/devAuth.mjs";
import { hasFuelFinderCredentials, fuelFinderStartupSummary } from "./lib/fuelFinderGov.mjs";
import { fuelSnapshotMaxAgeMs, refreshFuelSnapshot } from "./lib/fuelSnapshots.mjs";
import { refreshAllUserCohorts } from "./lib/fuelSync.mjs";
import { refreshBrentCrudeHistory } from "./lib/brentCrude.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, ".env") });

const PORT = Number(process.env.PORT) || 8787;
/** Bind address: 0.0.0.0 = all interfaces (localhost + LAN). Override with HOST=127.0.0.1 for local-only. */
const HOST = String(process.env.HOST ?? "0.0.0.0").trim() || "0.0.0.0";
const app = createApp();

async function runBrentCrudeRefresh(reason) {
  try {
    const history = await refreshBrentCrudeHistory();
    console.log(
      `[brent-crude] ${reason}: ${history.length} entries, latest=${history.length > 0 ? history[history.length - 1].date : "none"}`
    );
  } catch (err) {
    console.warn(
      `[brent-crude] ${reason} failed:`,
      err && err.message ? err.message : err
    );
  }
}

async function runSnapshotRefreshJob(reason) {
  if (!hasFuelFinderCredentials()) return;
  try {
    const snapshot = await refreshFuelSnapshot();
    const cohorts = await refreshAllUserCohorts(snapshot);
    console.log(
      `[fuel-snapshot] ${reason}: captured ${Array.isArray(snapshot.stations) ? snapshot.stations.length : 0} stations; cohorts updated=${cohorts.updated} skipped=${cohorts.skipped} failed=${cohorts.failed}`
    );
  } catch (err) {
    console.warn(
      `[fuel-snapshot] ${reason} failed:`,
      err && err.message ? err.message : err
    );
  }
}

app.listen(PORT, HOST, () => {
  console.log(`Fuel API → http://127.0.0.1:${PORT}  (bound ${HOST}:${PORT})`);
  console.log(
    `  Auth: POST /auth/register  POST /auth/login  POST /auth/refresh  GET /auth/me  PATCH /auth/profile` +
      (devAuthEnabled() ? `  POST /auth/dev-session` : "")
  );
  if (hasFuelFinderCredentials()) {
    const s = fuelFinderStartupSummary();
    console.log(`  Fuel Finder (GOV.UK): /nearby  (${s.apiBase})  verify: npm run verify-fuel-finder`);
    const everyMinutes = Math.max(
      60,
      Number(process.env.FUEL_SNAPSHOT_REFRESH_MINUTES) || 360
    );
    console.log(`  Snapshot refresh: every ${everyMinutes} minutes (default 4x/day)`);
    console.log(
      `  Snapshot max age before re-fetch: ${Math.round(fuelSnapshotMaxAgeMs() / 60000)} min (FUEL_SNAPSHOT_MAX_AGE_MS)`
    );
    setTimeout(() => {
      runSnapshotRefreshJob("startup");
      runBrentCrudeRefresh("startup");
    }, 10_000);
    setInterval(() => {
      runSnapshotRefreshJob("schedule");
      runBrentCrudeRefresh("schedule");
    }, everyMinutes * 60 * 1000);
    console.log(`  Forecast: GET /forecast  (Brent crude + pump price analysis)`);
  } else {
    console.log(`  Fuel Finder: add FUEL_CLIENT_ID + FUEL_CLIENT_SECRET to .env → https://www.developer.fuel-finder.service.gov.uk/`);
    setTimeout(() => { runBrentCrudeRefresh("startup-standalone"); }, 10_000);
    setInterval(() => { runBrentCrudeRefresh("schedule-standalone"); }, 360 * 60 * 1000);
  }
  if (isSupabaseAuthEnabled()) {
    console.log(`  Users: Supabase Auth + public.profiles`);
  } else {
    console.log(`  Users: users.json + AUTH_SECRET`);
    if (!process.env.AUTH_SECRET?.trim() || process.env.AUTH_SECRET.trim().length < 16) {
      console.warn(`  ⚠ Add AUTH_SECRET to .env (min 16 chars) for login/sign-up`);
    }
  }
  if (devAuthEnabled()) {
    console.warn(`  ⚠ FUEL_ALLOW_DEV_AUTH is on — POST /auth/dev-session bypasses normal login`);
  }
});
