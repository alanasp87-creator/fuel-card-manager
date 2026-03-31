/**
 * Classify forecourts into supermarket / motorway / independent using names and address text.
 * GOV.UK Fuel Finder does not expose a dedicated site-type field in our integration; this is heuristic.
 */

/** @typedef {'supermarket' | 'motorway' | 'independent'} StationKind */

const KIND_LABELS = {
  supermarket: "Supermarket",
  motorway: "Motorway",
  independent: "Independent",
};

export { KIND_LABELS };

/**
 * @param {Record<string, unknown>} row Raw forecourt row and/or normalized station fields
 * @returns {StationKind}
 */
export function classifyStationKind(row) {
  if (!row || typeof row !== "object") return "independent";
  const loc = row.location && typeof row.location === "object" ? row.location : {};
  const bits = [
    row.trading_name,
    row.brand_name,
    row.brand,
    row.name,
    row.address,
    row.site_name,
    loc.address_line_1,
    loc.address_line_2,
    loc.city,
    loc.county,
  ];
  const hay = bits
    .filter((x) => x != null && String(x).trim() !== "")
    .map((x) => String(x).toLowerCase())
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
