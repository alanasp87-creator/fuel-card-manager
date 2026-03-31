import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import { getAuthSecret, verifyToken } from "../lib/tokens.mjs";
import { findUserById } from "../lib/usersRepo.mjs";
import { getSupabaseServiceClient, isSupabaseAuthEnabled, meFromAccessToken } from "../lib/supabaseAuth.mjs";
import { tryVerifyDevSession, devUserFromPayload } from "../lib/devAuth.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LOADS_PATH = path.join(__dirname, "..", "loads.json");
const MAX_ITEMS = 250;

export const loadBoardRouter = express.Router();

function bearer(req) {
  const auth = req.headers.authorization || "";
  const match = auth.match(/^Bearer\s+(.+)$/i);
  return match ? match[1].trim() : "";
}

function loadStore() {
  try {
    const raw = fs.readFileSync(LOADS_PATH, "utf8");
    const parsed = JSON.parse(raw);
    const loads = Array.isArray(parsed.loads) ? parsed.loads : [];
    return { loads };
  } catch {
    return { loads: [] };
  }
}

function saveStore(store) {
  fs.writeFileSync(LOADS_PATH, JSON.stringify(store, null, 2), "utf8");
}

function safeText(value, maxLen) {
  return String(value || "").trim().slice(0, maxLen);
}

function safeNum(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  return Math.round(n * 1e6) / 1e6;
}

function safeBool(value) {
  if (value === true || value === 1) return true;
  if (value === false || value === 0) return false;
  const s = String(value ?? "").trim().toLowerCase();
  return s === "1" || s === "true" || s === "yes" || s === "on";
}

async function requireUser(req, res) {
  const tok = bearer(req);
  if (!tok) {
    res.status(401).json({ error: "Missing token" });
    return null;
  }

  const devPayload = tryVerifyDevSession(tok);
  if (devPayload) {
    const user = devUserFromPayload(devPayload);
    return { id: user.id, email: user.email, name: user.name || "" };
  }

  if (isSupabaseAuthEnabled()) {
    const user = await meFromAccessToken(tok);
    if (!user?.id) {
      res.status(401).json({ error: "Invalid or expired token" });
      return null;
    }
    return { id: user.id, email: user.email, name: user.name || "" };
  }

  const secret = getAuthSecret();
  if (!secret) {
    res.status(503).json({ error: "Set AUTH_SECRET in server/.env" });
    return null;
  }
  const payload = verifyToken(tok, secret);
  if (!payload?.sub) {
    res.status(401).json({ error: "Invalid or expired token" });
    return null;
  }
  const user = findUserById(payload.sub);
  if (!user) {
    res.status(401).json({ error: "User not found" });
    return null;
  }
  return { id: user.id, email: user.email, name: user.name || "" };
}

function prefsDb(res) {
  const db = getSupabaseServiceClient();
  if (!db) {
    res.status(501).json({ error: "Supabase is not configured on the server" });
    return null;
  }
  return db;
}

function normalizeSavedIds(body) {
  const raw = body?.ids;
  if (!Array.isArray(raw)) return [];
  const out = [];
  const seen = {};
  for (let i = 0; i < raw.length; i++) {
    const id = String(raw[i] ?? "").trim();
    if (!id || seen[id]) continue;
    seen[id] = true;
    out.push(id);
  }
  return out;
}

async function listLoadsFromSupabase(supabase) {
  const { data, error } = await supabase
    .from("load_board_loads")
    .select("id, payload, created_at")
    .order("created_at", { ascending: false })
    .limit(MAX_ITEMS);
  if (error) throw error;
  return (data || [])
    .map((row) => {
      const p = row.payload;
      if (!p || typeof p !== "object") return null;
      const merged = { ...p, id: row.id };
      if (!merged.createdAt) merged.createdAt = row.created_at;
      return merged;
    })
    .filter(Boolean);
}

async function insertLoadSupabase(supabase, item) {
  const payload = JSON.parse(JSON.stringify(item));
  const { error } = await supabase.from("load_board_loads").insert({
    id: item.id,
    payload,
    created_at: item.createdAt || new Date().toISOString(),
  });
  if (error) {
    const err = new Error(error.message || "Could not save load");
    err.status = 400;
    throw err;
  }
}

loadBoardRouter.get("/loads", async (req, res, next) => {
  try {
    const user = await requireUser(req, res);
    if (!user) return;

    if (isSupabaseAuthEnabled()) {
      const supabase = getSupabaseServiceClient();
      if (!supabase) {
        res.status(503).json({ error: "Supabase client unavailable" });
        return;
      }
      const items = await listLoadsFromSupabase(supabase);
      res.json({ loads: items });
      return;
    }

    const store = loadStore();
    const items = store.loads
      .slice()
      .sort((a, b) => String(b.createdAt || "").localeCompare(String(a.createdAt || "")))
      .slice(0, MAX_ITEMS);
    res.json({ loads: items });
  } catch (err) {
    next(err);
  }
});

loadBoardRouter.post("/loads", async (req, res, next) => {
  try {
    const user = await requireUser(req, res);
    if (!user) return;

    const origin = safeText(req.body?.origin, 120);
    const destination = safeText(req.body?.destination, 120);
    const loadType = safeText(req.body?.loadType, 80);
    const pickupDate = safeText(req.body?.pickupDate, 20);
    const pickupDateFrom = safeText(req.body?.pickupDateFrom, 20);
    const pickupDateTo = safeText(req.body?.pickupDateTo, 20);
    const pickupTimeFrom = safeText(req.body?.pickupTimeFrom, 10);
    const pickupTimeTo = safeText(req.body?.pickupTimeTo, 10);
    const pickupScheduleType = safeText(req.body?.pickupScheduleType, 16);
    const pickupByDate = safeText(req.body?.pickupByDate, 20);
    const pickupByTime = safeText(req.body?.pickupByTime, 10);
    const pickupOnDate = safeText(req.body?.pickupOnDate, 20);
    const pickupOnTime = safeText(req.body?.pickupOnTime, 10);
    const collectionVehicleType = safeText(req.body?.collectionVehicleType, 80);
    const collectionBodyType = safeText(req.body?.collectionBodyType, 80);
    const tailLiftOption = safeText(req.body?.tailLiftOption, 32) || "none";
    const tailLiftTuckUnder = safeBool(req.body?.tailLiftTuckUnder);
    const tailLiftHandrails = safeBool(req.body?.tailLiftHandrails);
    const tailLiftRequired =
      tailLiftOption === "standard" ||
      tailLiftOption === "heavy" ||
      tailLiftOption === "platform";
    const deliveryDate = safeText(req.body?.deliveryDate, 20);
    const deliveryTimeFrom = safeText(req.body?.deliveryTimeFrom, 10);
    const deliveryTimeTo = safeText(req.body?.deliveryTimeTo, 10);
    const deliveryScheduleType = safeText(req.body?.deliveryScheduleType, 16);
    const deliveryByDate = safeText(req.body?.deliveryByDate, 20);
    const deliveryByTime = safeText(req.body?.deliveryByTime, 10);
    const deliveryOnDate = safeText(req.body?.deliveryOnDate, 20);
    const deliveryOnTime = safeText(req.body?.deliveryOnTime, 10);
    const loadSize = safeText(req.body?.loadSize, 30);
    const referenceNo = safeText(req.body?.referenceNo, 60);
    const notes = safeText(req.body?.notes, 400);
    const weightKg = safeNum(req.body?.weightKg);
    const volumeM3 = safeNum(req.body?.volumeM3);
    const lengthM = safeNum(req.body?.lengthM);
    const pallets = safeNum(req.body?.pallets);
    let pricingMode = safeText(req.body?.pricingMode, 16).toLowerCase();
    if (pricingMode !== "bids") pricingMode = "fixed";
    let rateAmount = safeNum(req.body?.rateAmount);
    const mileageMiles = safeNum(req.body?.mileageMiles);
    let currency = safeText(req.body?.currency, 8).toUpperCase();
    if (pricingMode === "bids") {
      rateAmount = null;
      currency = "";
    }
    const originPostcode = safeText(req.body?.originPostcode, 16).toUpperCase();
    const destinationPostcode = safeText(req.body?.destinationPostcode, 16).toUpperCase();
    const originLat = safeNum(req.body?.originLat);
    const originLng = safeNum(req.body?.originLng);
    const destinationLat = safeNum(req.body?.destinationLat);
    const destinationLng = safeNum(req.body?.destinationLng);

    if (!originPostcode) {
      res.status(400).json({ error: "Collection postcode is required" });
      return;
    }
    if (!destinationPostcode) {
      res.status(400).json({ error: "Delivery postcode is required" });
      return;
    }
    if (!pickupDate) {
      res.status(400).json({ error: "Pickup date is required" });
      return;
    }

    const item = {
      id: crypto.randomUUID(),
      origin,
      destination,
      loadType,
      pickupDate,
      pickupDateFrom,
      pickupDateTo,
      pickupTimeFrom,
      pickupTimeTo,
      pickupScheduleType,
      pickupByDate,
      pickupByTime,
      pickupOnDate,
      pickupOnTime,
      collectionVehicleType,
      collectionBodyType,
      tailLiftOption,
      tailLiftTuckUnder,
      tailLiftHandrails,
      tailLiftRequired,
      deliveryDate,
      deliveryTimeFrom,
      deliveryTimeTo,
      deliveryScheduleType,
      deliveryByDate,
      deliveryByTime,
      deliveryOnDate,
      deliveryOnTime,
      loadSize,
      referenceNo,
      notes,
      weightKg,
      volumeM3,
      lengthM,
      pallets,
      pricingMode,
      rateAmount,
      mileageMiles,
      currency,
      originPostcode,
      destinationPostcode,
      originLat,
      originLng,
      destinationLat,
      destinationLng,
      createdAt: new Date().toISOString(),
      postedBy: {
        userId: user.id,
        name: user.name || "",
        email: user.email,
      },
    };

    if (isSupabaseAuthEnabled()) {
      const supabase = getSupabaseServiceClient();
      if (!supabase) {
        res.status(503).json({ error: "Supabase client unavailable" });
        return;
      }
      await insertLoadSupabase(supabase, item);
      res.status(201).json({ load: item });
      return;
    }

    const store = loadStore();
    store.loads.unshift(item);
    store.loads = store.loads.slice(0, MAX_ITEMS);
    saveStore(store);

    res.status(201).json({ load: item });
  } catch (err) {
    next(err);
  }
});

loadBoardRouter.get("/saved-ids", async (req, res, next) => {
  try {
    const user = await requireUser(req, res);
    if (!user) return;
    const db = prefsDb(res);
    if (!db) return;

    const { data, error } = await db
      .from("load_board_saved_ids")
      .select("ids")
      .eq("user_id", user.id)
      .maybeSingle();
    if (error) throw error;
    const raw = data?.ids;
    const ids = Array.isArray(raw) ? raw.map((x) => String(x ?? "").trim()).filter(Boolean) : [];
    res.json({ ids });
  } catch (err) {
    next(err);
  }
});

loadBoardRouter.put("/saved-ids", async (req, res, next) => {
  try {
    const user = await requireUser(req, res);
    if (!user) return;
    const db = prefsDb(res);
    if (!db) return;

    const ids = normalizeSavedIds(req.body);
    const { error } = await db.from("load_board_saved_ids").upsert(
      {
        user_id: user.id,
        ids,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "user_id" }
    );
    if (error) throw error;
    res.json({ ok: true, ids });
  } catch (err) {
    next(err);
  }
});

loadBoardRouter.get("/post-draft", async (req, res, next) => {
  try {
    const user = await requireUser(req, res);
    if (!user) return;
    const db = prefsDb(res);
    if (!db) return;

    const { data, error } = await db
      .from("load_board_post_drafts")
      .select("draft")
      .eq("user_id", user.id)
      .maybeSingle();
    if (error) throw error;
    const draft = data?.draft && typeof data.draft === "object" && !Array.isArray(data.draft) ? data.draft : null;
    res.json({ draft });
  } catch (err) {
    next(err);
  }
});

loadBoardRouter.put("/post-draft", async (req, res, next) => {
  try {
    const user = await requireUser(req, res);
    if (!user) return;
    const db = prefsDb(res);
    if (!db) return;

    const d = req.body?.draft;
    if (!d || typeof d !== "object" || Array.isArray(d)) {
      res.status(400).json({ error: "draft object required" });
      return;
    }
    const { error } = await db.from("load_board_post_drafts").upsert(
      {
        user_id: user.id,
        draft: d,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "user_id" }
    );
    if (error) throw error;
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

loadBoardRouter.delete("/post-draft", async (req, res, next) => {
  try {
    const user = await requireUser(req, res);
    if (!user) return;
    const db = prefsDb(res);
    if (!db) return;

    const { error } = await db.from("load_board_post_drafts").delete().eq("user_id", user.id);
    if (error) throw error;
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});
