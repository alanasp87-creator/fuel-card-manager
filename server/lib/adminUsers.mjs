export function parseAdminEmails() {
  const raw = process.env.ADMIN_EMAILS?.trim();
  if (!raw) return new Set();
  return new Set(
    raw
      .split(/[,;]+/)
      .map((e) => e.trim().toLowerCase())
      .filter(Boolean)
  );
}

export function isAdminEmail(email) {
  if (!email) return false;
  return parseAdminEmails().has(String(email).trim().toLowerCase());
}

/** Adds isAdmin from ADMIN_EMAILS (or keeps explicit true). */
export function withRoleFlags(user) {
  if (!user || typeof user !== "object") return user;
  const isAdmin = user.isAdmin === true || isAdminEmail(user.email);
  return { ...user, isAdmin };
}

/** Middleware to ensure the user is an admin. Requires req.user to be set (e.g. by a bearer/me check). */
export function requireAdmin(req, res, next) {
  const user = req.user;
  if (!user || user.isAdmin !== true) {
    res.status(403).json({ error: "Administration privileges required" });
    return;
  }
  next();
}
