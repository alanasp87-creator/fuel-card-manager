const DEFAULT_MS = 96 * 60 * 60 * 1000;
const MIN_MS = 60 * 1000;

export function getFuelPriceMaxAgeMs() {
  const n = Number(process.env.FUEL_PRICE_MAX_AGE_MS);
  if (Number.isFinite(n) && n >= MIN_MS) return n;
  return DEFAULT_MS;
}

export function getFuelPriceMaxAgeHoursRounded() {
  const ms = getFuelPriceMaxAgeMs();
  return Math.round(ms / (60 * 60 * 1000));
}

export function isSnapshotPriceFresh(row, maxAgeMs) {
  const raw = row?.lastUpdated ?? row?.last_updated;
  if (typeof raw !== "string" || !raw.trim()) return false;
  const t = Date.parse(raw.trim());
  if (!Number.isFinite(t)) return false;
  const age = Date.now() - t;
  if (age < 0) return false;
  return age <= maxAgeMs;
}

export function isSnapshotCatalogFresh(snapshot, maxAgeMs) {
  const raw = snapshot?.refreshedAt ?? snapshot?.capturedAt;
  if (typeof raw !== "string" || !raw.trim()) return false;
  const t = Date.parse(raw.trim());
  if (!Number.isFinite(t)) return false;
  const age = Date.now() - t;
  if (age < 0) return false;
  return age <= maxAgeMs;
}
