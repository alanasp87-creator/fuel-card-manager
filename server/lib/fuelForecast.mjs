import { getBrentCrudeHistory, getDieselPriceHistory } from "./brentCrude.mjs";
import { getLatestFuelSnapshot } from "./fuelSnapshots.mjs";

function computeEnglandAvgFromSnapshot(snapshot) {
  const stations = Array.isArray(snapshot?.stations) ? snapshot.stations : [];
  const prices = [];
  for (const s of stations) {
    const p = pickB7Price(s.prices);
    if (p != null && p > 50 && p < 500) prices.push(p);
  }
  if (prices.length === 0) return null;
  return Math.round((prices.reduce((a, b) => a + b, 0) / prices.length) * 10) / 10;
}

function pickB7Price(prices) {
  if (!prices || typeof prices !== "object") return null;
  const p = {};
  Object.keys(prices).forEach((k) => {
    const ku = String(k).toUpperCase().replace(/\s+/g, "_");
    const v = Number(prices[k]);
    if (Number.isFinite(v)) p[ku] = v;
  });
  if (p.B7 != null) return p.B7;
  if (p.DIESEL != null) return p.DIESEL;
  if (p.B7_STANDARD != null) return p.B7_STANDARD;
  return null;
}

function movingAverage(arr, window) {
  const result = [];
  for (let i = 0; i < arr.length; i++) {
    const start = Math.max(0, i - window + 1);
    const slice = arr.slice(start, i + 1);
    const avg = slice.reduce((a, b) => a + b, 0) / slice.length;
    result.push(Math.round(avg * 100) / 100);
  }
  return result;
}

function percentChange(recent, previous) {
  if (!previous || previous === 0) return 0;
  return ((recent - previous) / previous) * 100;
}

function trendDirection(values, lookback) {
  if (values.length < lookback + 1) return 0;
  const recent = values.slice(-lookback);
  const earlier = values.slice(-(lookback * 2), -lookback);
  if (earlier.length === 0) return 0;
  const recentAvg = recent.reduce((a, b) => a + b, 0) / recent.length;
  const earlierAvg = earlier.reduce((a, b) => a + b, 0) / earlier.length;
  return recentAvg - earlierAvg;
}

function buildPumpHistory(dieselHistory, crudeHistory, currentEnglandAvg) {
  const pumpByDate = new Map();
  for (const e of dieselHistory) {
    if (e.avg != null && Number.isFinite(e.avg)) {
      pumpByDate.set(e.date, e.avg);
    }
  }

  if (currentEnglandAvg != null && !pumpByDate.has(new Date().toISOString().slice(0, 10))) {
    pumpByDate.set(new Date().toISOString().slice(0, 10), currentEnglandAvg);
  }

  const result = [];
  for (const crude of crudeHistory) {
    const pumpVal = pumpByDate.get(crude.date) ?? null;
    result.push({ date: crude.date, pumpPpl: pumpVal });
  }

  if (result.length > 0 && pumpByDate.size > 0) {
    let lastKnown = null;
    for (let i = 0; i < result.length; i++) {
      if (result[i].pumpPpl != null) {
        lastKnown = result[i].pumpPpl;
      } else if (lastKnown != null) {
        result[i].pumpPpl = lastKnown;
      }
    }
    for (let i = result.length - 1; i >= 0; i--) {
      if (result[i].pumpPpl != null) break;
      if (lastKnown != null) result[i].pumpPpl = lastKnown;
    }
    const firstKnown = result.find((r) => r.pumpPpl != null)?.pumpPpl;
    if (firstKnown != null) {
      for (let i = 0; i < result.length; i++) {
        if (result[i].pumpPpl != null) break;
        result[i].pumpPpl = firstKnown;
      }
    }
  }

  return result;
}

function computeSpreadHistory(crudeHistory, pumpHistory) {
  const spreads = [];
  for (let i = 0; i < crudeHistory.length; i++) {
    const pump = pumpHistory[i]?.pumpPpl;
    if (pump != null) {
      spreads.push({
        date: crudeHistory[i].date,
        spread: Math.round((pump - crudeHistory[i].pencePerLitre) * 100) / 100,
      });
    }
  }
  return spreads;
}

export function computeForecast() {
  const crudeHistory = getBrentCrudeHistory();
  const dieselHistory = getDieselPriceHistory();
  const snapshot = getLatestFuelSnapshot();
  const englandAvg = computeEnglandAvgFromSnapshot(snapshot);

  if (crudeHistory.length < 5) {
    return {
      signal: "insufficient_data",
      direction: "stable",
      confidence: "low",
      recommendation: "Hold",
      explanation: "Not enough data to generate a forecast. Please wait for more Brent crude price data to accumulate.",
      englandAvgDiesel: englandAvg,
      latestCrude: null,
      spread: null,
      crudeHistory: [],
      pumpHistory: [],
      dataQuality: "insufficient",
    };
  }

  const crudePpl = crudeHistory.map((e) => e.pencePerLitre);

  const latestCrudePpl = crudePpl[crudePpl.length - 1];
  const latestCrudeUsd = crudeHistory[crudeHistory.length - 1].usdPerBarrel;

  const crudeTrend7d = trendDirection(crudePpl, 7);
  const crudeTrend14d = trendDirection(crudePpl, 14);

  const crudeChange7d = crudeHistory.length >= 8
    ? percentChange(crudePpl[crudePpl.length - 1], crudePpl[crudePpl.length - 8])
    : 0;
  const crudeChange14d = crudeHistory.length >= 15
    ? percentChange(crudePpl[crudePpl.length - 1], crudePpl[crudePpl.length - 15])
    : 0;

  const pumpAligned = buildPumpHistory(dieselHistory, crudeHistory, englandAvg);
  const latestPump = englandAvg ?? pumpAligned.findLast((p) => p.pumpPpl != null)?.pumpPpl ?? null;

  const spread = latestPump != null ? Math.round((latestPump - latestCrudePpl) * 100) / 100 : null;

  const spreadHistory = computeSpreadHistory(crudeHistory, pumpAligned);
  const recentSpreads = spreadHistory.slice(-30).map((s) => s.spread);
  const avgSpread = recentSpreads.length > 0
    ? recentSpreads.reduce((a, b) => a + b, 0) / recentSpreads.length
    : null;

  const hasPumpData = dieselHistory.length > 0 || englandAvg != null;
  const dataQuality = crudeHistory.some((e) => e.source !== "synthetic")
    ? (hasPumpData ? "live" : "crude-only")
    : (hasPumpData ? "synthetic-crude" : "synthetic");

  let direction = "stable";
  let confidence = "medium";
  let recommendation = "Hold";
  let explanation = "";

  const THRESHOLD_STRONG = 3.0;
  const THRESHOLD_MODERATE = 1.5;

  if (crudeTrend7d > THRESHOLD_STRONG && crudeTrend14d > THRESHOLD_MODERATE) {
    direction = "up";
    confidence = "high";
    recommendation = "Buy Now";
    explanation = `Brent crude has risen significantly over the last 7-14 days (+${crudeChange7d.toFixed(1)}% in 7d). Pump prices typically follow crude increases within 1-2 weeks. Consider filling up now before prices rise.`;
  } else if (crudeTrend7d > THRESHOLD_MODERATE) {
    direction = "up";
    confidence = "medium";
    recommendation = "Buy Now";
    explanation = `Brent crude is trending upward over the past week (+${crudeChange7d.toFixed(1)}% in 7d). Pump prices may follow within 1-3 weeks. Filling up sooner rather than later could save money.`;
  } else if (crudeTrend7d < -THRESHOLD_STRONG && crudeTrend14d < -THRESHOLD_MODERATE) {
    direction = "down";
    confidence = "high";
    recommendation = "Wait";
    explanation = `Brent crude has dropped significantly over the last 7-14 days (${crudeChange7d.toFixed(1)}% in 7d). Pump prices should follow with a 1-2 week lag. Waiting to fill up could save you money.`;
  } else if (crudeTrend7d < -THRESHOLD_MODERATE) {
    direction = "down";
    confidence = "medium";
    recommendation = "Wait";
    explanation = `Brent crude is trending downward (${crudeChange7d.toFixed(1)}% in 7d). If the drop continues, pump prices should ease within 1-3 weeks.`;
  } else if (spread != null && avgSpread != null && spread > avgSpread + 5) {
    direction = "down";
    confidence = "low";
    recommendation = "Wait";
    explanation = `The spread between pump price and crude cost is wider than usual (${spread.toFixed(1)}p vs avg ${avgSpread.toFixed(1)}p). Retailers may reduce prices to stay competitive.`;
  } else if (spread != null && avgSpread != null && spread < avgSpread - 3) {
    direction = "up";
    confidence = "low";
    recommendation = "Buy Now";
    explanation = `The pump-crude spread is narrower than usual (${spread.toFixed(1)}p vs avg ${avgSpread.toFixed(1)}p). Retailers may need to raise prices to restore margins.`;
  } else {
    direction = "stable";
    confidence = "medium";
    recommendation = "Hold";
    explanation = `Brent crude is relatively stable (${crudeChange7d >= 0 ? "+" : ""}${crudeChange7d.toFixed(1)}% in 7d). No significant pump price change expected in the near term.`;
  }

  const last90Crude = crudeHistory.slice(-90).map((e) => ({
    date: e.date,
    usdPerBarrel: e.usdPerBarrel,
    pencePerLitre: e.pencePerLitre,
  }));

  const last90Pump = pumpAligned.slice(-90).map((e) => ({
    date: e.date,
    pumpPpl: e.pumpPpl,
  }));

  return {
    signal: "forecast_ready",
    direction,
    confidence,
    recommendation,
    explanation,
    englandAvgDiesel: englandAvg,
    latestCrude: {
      date: crudeHistory[crudeHistory.length - 1].date,
      usdPerBarrel: latestCrudeUsd,
      pencePerLitre: latestCrudePpl,
    },
    spread,
    avgSpread: avgSpread != null ? Math.round(avgSpread * 100) / 100 : null,
    crudeChange7d: Math.round(crudeChange7d * 100) / 100,
    crudeChange14d: Math.round(crudeChange14d * 100) / 100,
    crudeHistory: last90Crude,
    pumpHistory: last90Pump,
    pumpPrice: latestPump,
    dataQuality,
    generatedAt: new Date().toISOString(),
  };
}
