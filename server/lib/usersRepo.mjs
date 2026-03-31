import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { hashPassword } from "./tokens.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const USERS_PATH = path.join(__dirname, "..", "users.json");

function loadStore() {
  try {
    const raw = fs.readFileSync(USERS_PATH, "utf8");
    const j = JSON.parse(raw);
    return { users: Array.isArray(j.users) ? j.users : [] };
  } catch {
    return { users: [] };
  }
}

function saveStore(store) {
  fs.writeFileSync(USERS_PATH, JSON.stringify(store, null, 2), "utf8");
}

function toUser(u) {
  return {
    id: u.id,
    email: u.email,
    name: u.name || "",
    passwordHash: u.passwordHash,
    salt: u.salt,
    createdAt: u.createdAt,
    dashboard: u.dashboard && typeof u.dashboard === "object" ? u.dashboard : {},
    isAdmin: u.isAdmin === true,
  };
}

export function publicUser(u) {
  return {
    id: u.id,
    email: u.email,
    name: u.name || "",
    createdAt: u.createdAt,
    dashboard: u.dashboard && typeof u.dashboard === "object" ? u.dashboard : {},
    isAdmin: u.isAdmin === true,
  };
}

export function findUserByEmail(email) {
  const e = email.trim().toLowerCase();
  const store = loadStore();
  const u = store.users.find((x) => x.email === e);
  return u ? toUser(u) : null;
}

export function findUserById(id) {
  const store = loadStore();
  const u = store.users.find((x) => x.id === id);
  return u ? toUser(u) : null;
}

export function emailExists(email) {
  const e = email.trim().toLowerCase();
  return loadStore().users.some((x) => x.email === e);
}

export function createUser({ email, name, password }) {
  const store = loadStore();
  const salt = crypto.randomBytes(16).toString("base64");
  const passwordHash = hashPassword(password, salt);
  const id = crypto.randomUUID();
  const createdAt = new Date().toISOString();
  const row = {
    id,
    email: email.trim().toLowerCase(),
    name: String(name || "").slice(0, 120),
    salt,
    passwordHash,
    createdAt,
    dashboard: { lastFuelSearchPostcode: "" },
  };
  store.users.push(row);
  saveStore(store);
  return toUser(row);
}

export function updateUserProfile(userId, { name, dashboard }) {
  const store = loadStore();
  const idx = store.users.findIndex((x) => x.id === userId);
  if (idx < 0) return null;
  const u = store.users[idx];
  if (typeof name === "string") u.name = name.trim().slice(0, 120);
  if (dashboard && typeof dashboard === "object") {
    u.dashboard = { ...(u.dashboard || {}), ...dashboard };
  }
  store.users[idx] = u;
  saveStore(store);
  return toUser(u);
}

export function verifyPassword(user, password) {
  return hashPassword(password, user.salt) === user.passwordHash;
}

export function listUsers() {
  const store = loadStore();
  return store.users.map((u) => publicUser(u));
}

export function deleteUser(userId) {
  const store = loadStore();
  const idx = store.users.findIndex((x) => x.id === userId);
  if (idx < 0) return false;
  store.users.splice(idx, 1);
  saveStore(store);
  return true;
}

export function updateUser(userId, data) {
  const store = loadStore();
  const idx = store.users.findIndex((x) => x.id === userId);
  if (idx < 0) return null;
  const u = store.users[idx];
  if (typeof data.name === "string") u.name = data.name.trim().slice(0, 120);
  if (typeof data.email === "string") u.email = data.email.trim().toLowerCase();
  // dashboard updates if needed
  if (data.dashboard && typeof data.dashboard === "object") {
    u.dashboard = { ...(u.dashboard || {}), ...data.dashboard };
  }
  store.users[idx] = u;
  saveStore(store);
  return publicUser(u);
}

export function patchUserDashboard(userId, dashboardPatch) {
  if (!dashboardPatch || typeof dashboardPatch !== "object") return findUserById(userId);
  return updateUserProfile(userId, { dashboard: dashboardPatch });
}
