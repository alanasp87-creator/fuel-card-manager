import express from "express";
import { requireAdmin, withRoleFlags } from "../lib/adminUsers.mjs";
import { listUsers, deleteUser, updateUser } from "../lib/usersRepo.mjs";
import {
  isSupabaseAuthEnabled,
  listAllSupabaseUsers,
  deleteSupabaseUser,
  updateSupabaseUserByAdmin,
  meFromAccessToken
} from "../lib/supabaseAuth.mjs";
import { tryVerifyDevSession, devUserFromPayload } from "../lib/devAuth.mjs";
import { findUserById, publicUser } from "../lib/usersRepo.mjs";
import { getAuthSecret, verifyToken } from "../lib/tokens.mjs";

export const adminRouter = express.Router();

function bearer(req) {
  const auth = req.headers.authorization || "";
  const m = auth.match(/^Bearer\s+(.+)$/i);
  return m ? m[1].trim() : null;
}

// Middleware to populate req.user for requireAdmin
async function populateUser(req, res, next) {
  const tok = bearer(req);
  if (!tok) {
    next();
    return;
  }

  // Check dev session
  const devPayload = tryVerifyDevSession(tok);
  if (devPayload) {
    req.user = withRoleFlags(devUserFromPayload(devPayload));
    next();
    return;
  }

  // Check Supabase
  if (isSupabaseAuthEnabled()) {
    try {
      const user = await meFromAccessToken(tok);
      if (user) req.user = withRoleFlags(user);
    } catch (e) {
      console.warn("[admin/populateUser] Supabase getUser failed:", e.message);
    }
    next();
    return;
  }

  // Check local secret
  const secret = getAuthSecret();
  if (secret) {
    try {
      const payload = verifyToken(tok, secret);
      if (payload?.sub) {
        const user = findUserById(payload.sub);
        if (user) req.user = withRoleFlags(publicUser(user));
      }
    } catch (e) {}
  }
  next();
}

adminRouter.use(populateUser);
adminRouter.use(requireAdmin);

adminRouter.get("/users", async (req, res, next) => {
  try {
    if (isSupabaseAuthEnabled()) {
      const users = await listAllSupabaseUsers();
      res.json({ users: users.map(withRoleFlags) });
      return;
    }
    const users = listUsers();
    res.json({ users: users.map(withRoleFlags) });
  } catch (e) {
    next(e);
  }
});

adminRouter.delete("/users/:id", async (req, res, next) => {
  try {
    const { id } = req.params;
    if (isSupabaseAuthEnabled()) {
      await deleteSupabaseUser(id);
      res.json({ ok: true });
      return;
    }
    const ok = deleteUser(id);
    if (!ok) {
      res.status(404).json({ error: "User not found" });
      return;
    }
    res.json({ ok: true });
  } catch (e) {
    next(e);
  }
});

adminRouter.patch("/users/:id", async (req, res, next) => {
  try {
    const { id } = req.params;
    const body = req.body || {};
    if (isSupabaseAuthEnabled()) {
      const user = await updateSupabaseUserByAdmin(id, body);
      if (!user) {
        res.status(404).json({ error: "User not found" });
        return;
      }
      res.json({ user: withRoleFlags(user) });
      return;
    }
    const user = updateUser(id, body);
    if (!user) {
      res.status(404).json({ error: "User not found" });
      return;
    }
    res.json({ user: withRoleFlags(user) });
  } catch (e) {
    next(e);
  }
});
