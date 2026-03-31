import { createClient } from "@supabase/supabase-js";

const url = () => process.env.SUPABASE_URL?.trim();
const anonKey = () => process.env.SUPABASE_ANON_KEY?.trim();
const serviceKey = () => process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();

export function isSupabaseAuthEnabled() {
  return Boolean(url() && anonKey() && serviceKey());
}

/** Service-role client for server-side reads/writes (bypasses RLS). Returns null if not configured. */
export function getSupabaseServiceClient() {
  if (!isSupabaseAuthEnabled()) return null;
  return serviceClient();
}

function anonClient() {
  return createClient(url(), anonKey(), {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

function serviceClient() {
  return createClient(url(), serviceKey(), {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

function defaultDashboard() {
  return { lastFuelSearchPostcode: "" };
}

async function buildPublicUser(admin, userId, authUser) {
  const { data: profile } = await admin
    .from("profiles")
    .select("name, created_at, dashboard")
    .eq("id", userId)
    .maybeSingle();
  const fromProfile = profile?.name != null && String(profile.name).trim() !== "";
  const name = fromProfile
    ? String(profile.name).trim().slice(0, 120)
    : String(authUser.user_metadata?.name || "").slice(0, 120);
  const createdRaw = profile?.created_at ?? authUser.created_at;
  const createdAt =
    typeof createdRaw === "string"
      ? createdRaw
      : createdRaw
        ? new Date(createdRaw).toISOString()
        : new Date().toISOString();
  const dashboard =
    profile?.dashboard && typeof profile.dashboard === "object" ? profile.dashboard : {};
  return {
    id: userId,
    email: authUser.email ?? "",
    name,
    createdAt,
    dashboard,
  };
}

async function ensureProfileRow(admin, userId, { name } = {}) {
  const { data: existing } = await admin.from("profiles").select("id").eq("id", userId).maybeSingle();
  if (existing) return;
  await admin.from("profiles").insert({
    id: userId,
    name: String(name || "").slice(0, 120),
    dashboard: defaultDashboard(),
  });
}

export async function registerSupabase({ email, password, name }) {
  const admin = serviceClient();
  const emailNorm = email.trim().toLowerCase();
  const { data, error } = await admin.auth.admin.createUser({
    email: emailNorm,
    password,
    email_confirm: true,
    user_metadata: { name: name || "" },
  });
  if (error) {
    const msg = error.message || "Registration failed";
    const dup =
      /already|registered|exists|duplicate/i.test(msg) || error.status === 422;
    const e = new Error(dup ? "An account with this email already exists" : msg);
    e.status = dup ? 409 : 400;
    throw e;
  }
  const created = data.user;
  if (!created?.id) throw new Error("Registration failed");

  const anon = anonClient();
  const { data: sessionData, error: signErr } = await anon.auth.signInWithPassword({
    email: emailNorm,
    password,
  });
  if (signErr || !sessionData.session) {
    const e = new Error(signErr?.message || "Could not create session");
    e.status = 500;
    throw e;
  }
  const sess = sessionData.session;
  await ensureProfileRow(admin, created.id, { name: name || "" });
  const publicUser = await buildPublicUser(admin, created.id, created);
  return {
    token: sess.access_token,
    refresh_token: sess.refresh_token,
    user: publicUser,
  };
}

export async function loginSupabase({ email, password }) {
  const anon = anonClient();
  const { data, error } = await anon.auth.signInWithPassword({
    email: email.trim().toLowerCase(),
    password,
  });
  if (error || !data.session) {
    const e = new Error("Invalid email or password");
    e.status = 401;
    throw e;
  }
  const admin = serviceClient();
  const u = data.user;
  await ensureProfileRow(admin, u.id, { name: u.user_metadata?.name || "" });
  return {
    token: data.session.access_token,
    refresh_token: data.session.refresh_token,
    user: await buildPublicUser(admin, u.id, u),
  };
}

export async function meFromAccessToken(accessToken) {
  const admin = serviceClient();
  const { data, error } = await admin.auth.getUser(accessToken);
  if (error || !data.user) return null;
  const u = data.user;
  await ensureProfileRow(admin, u.id, { name: u.user_metadata?.name || "" });
  return buildPublicUser(admin, u.id, u);
}

export async function updateSupabaseProfile(accessToken, { name, dashboard }) {
  const admin = serviceClient();
  const { data, error } = await admin.auth.getUser(accessToken);
  if (error || !data.user) return null;
  const u = data.user;
  await ensureProfileRow(admin, u.id, { name: u.user_metadata?.name || "" });

  const updates = {};
  if (typeof name === "string") updates.name = name.trim().slice(0, 120);
  if (dashboard && typeof dashboard === "object") {
    const { data: row } = await admin.from("profiles").select("dashboard").eq("id", u.id).maybeSingle();
    const cur =
      row?.dashboard && typeof row.dashboard === "object" ? row.dashboard : defaultDashboard();
    updates.dashboard = { ...cur, ...dashboard };
  }
  if (Object.keys(updates).length > 0) {
    const { error: upErr } = await admin.from("profiles").update(updates).eq("id", u.id);
    if (upErr) {
      const e = new Error(upErr.message || "Update failed");
      e.status = 400;
      throw e;
    }
  }
  const { data: fresh, error: e2 } = await admin.auth.getUser(accessToken);
  if (e2 || !fresh.user) return null;
  return buildPublicUser(admin, fresh.user.id, fresh.user);
}

export async function refreshSupabaseSession(refreshToken) {
  if (!refreshToken || typeof refreshToken !== "string") return null;
  const anon = anonClient();
  const { data, error } = await anon.auth.refreshSession({ refresh_token: refreshToken });
  if (error || !data.session) return null;
  return {
    token: data.session.access_token,
    refresh_token: data.session.refresh_token,
  };
}

export async function listSupabaseProfilesForFuel() {
  const admin = serviceClient();
  const out = [];
  let from = 0;
  const pageSize = 500;
  for (;;) {
    const to = from + pageSize - 1;
    const { data, error } = await admin
      .from("profiles")
      .select("id, dashboard")
      .range(from, to);
    if (error) {
      const e = new Error(error.message || "Could not list profiles");
      e.status = 500;
      throw e;
    }
    const rows = Array.isArray(data) ? data : [];
    rows.forEach((r) => {
      out.push({
        id: String(r.id),
        dashboard: r.dashboard && typeof r.dashboard === "object" ? r.dashboard : {},
      });
    });
    if (rows.length < pageSize) break;
    from += pageSize;
  }
  return out;
}

export async function patchSupabaseProfileDashboardById(userId, dashboardPatch) {
  const admin = serviceClient();
  const { data: row, error: rowErr } = await admin
    .from("profiles")
    .select("dashboard")
    .eq("id", userId)
    .maybeSingle();
  if (rowErr) {
    const e = new Error(rowErr.message || "Could not read profile");
    e.status = 500;
    throw e;
  }
  const current =
    row?.dashboard && typeof row.dashboard === "object" ? row.dashboard : defaultDashboard();
  const next = { ...current, ...dashboardPatch };
  const { error } = await admin.from("profiles").update({ dashboard: next }).eq("id", userId);
  if (error) {
    const e = new Error(error.message || "Could not update profile dashboard");
    e.status = 500;
    throw e;
  }
}

export async function listAllSupabaseUsers() {
  const admin = serviceClient();
  if (!admin) return [];

  // Note: listUsers is paginated, default limit is 50.
  const {
    data: { users: authUsers },
    error: authErr,
  } = await admin.auth.admin.listUsers();
  if (authErr) {
    const e = new Error(authErr.message || "Could not list auth users");
    e.status = 500;
    throw e;
  }

  const { data: profiles, error: profErr } = await admin.from("profiles").select("*");
  if (profErr) {
    const e = new Error(profErr.message || "Could not list profiles");
    e.status = 500;
    throw e;
  }

  return authUsers.map((u) => {
    const p = (profiles || []).find((x) => x.id === u.id);
    return {
      id: u.id,
      email: u.email,
      name: p?.name || u.user_metadata?.name || "",
      createdAt: u.created_at,
      dashboard: p?.dashboard || {},
    };
  });
}

export async function deleteSupabaseUser(userId) {
  const admin = serviceClient();
  if (!admin) return;

  const { error } = await admin.auth.admin.deleteUser(userId);
  if (error) {
    const e = new Error(error.message || "Could not delete user");
    e.status = 500;
    throw e;
  }
  // No need to delete profile manually if ON DELETE CASCADE is set,
  // but if not, we should delete it.
  await admin.from("profiles").delete().eq("id", userId);
}

export async function updateSupabaseUserByAdmin(userId, { email, name, dashboard }) {
  const admin = serviceClient();
  if (!admin) return null;

  const authUpdates = {};
  if (typeof email === "string") authUpdates.email = email.trim().toLowerCase();
  if (typeof name === "string") authUpdates.user_metadata = { ...(authUpdates.user_metadata || {}), name: name.trim() };

  if (Object.keys(authUpdates).length > 0) {
    const { data: u, error: e1 } = await admin.auth.admin.updateUserById(userId, authUpdates);
    if (e1) {
      const e = new Error(e1.message || "Auth update failed");
      e.status = 500;
      throw e;
    }
  }

  const profUpdates = {};
  if (typeof name === "string") profUpdates.name = name.trim().slice(0, 120);
  if (dashboard && typeof dashboard === "object") profUpdates.dashboard = dashboard;

  if (Object.keys(profUpdates).length > 0) {
    const { error: e2 } = await admin.from("profiles").update(profUpdates).eq("id", userId);
    if (e2) {
      const e = new Error(e2.message || "Profile update failed");
      e.status = 500;
      throw e;
    }
  }

  const { data: authUser, error: e3 } = await admin.auth.admin.getUserById(userId);
  if (e3 || !authUser?.user) return null;
  return buildPublicUser(admin, userId, authUser.user);
}
