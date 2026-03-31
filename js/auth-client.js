/**
 * Browser auth helper — talks to Node server /auth/* routes.
 * Requires js/api-config.js first (uses FUEL_FINDER_PROXY_BASE as the backend URL).
 */

(function () {
  "use strict";

  var TOKEN_KEY = "fuel_auth_token";
  var REFRESH_KEY = "fuel_auth_refresh";
  var ME_CACHE_KEY = "fuel_me_cache";

  function apiBase() {
    var b = String(window.FUEL_FINDER_PROXY_BASE || "").replace(/\/$/, "");
    return b;
  }

  window.FuelAuth = {
    TOKEN_KEY: TOKEN_KEY,
    REFRESH_KEY: REFRESH_KEY,

    getToken: function () {
      return localStorage.getItem(TOKEN_KEY) || "";
    },

    setToken: function (t) {
      if (t) localStorage.setItem(TOKEN_KEY, t);
      else localStorage.removeItem(TOKEN_KEY);
    },

    setRefreshToken: function (t) {
      if (t) localStorage.setItem(REFRESH_KEY, t);
      else localStorage.removeItem(REFRESH_KEY);
    },

    clear: function () {
      localStorage.removeItem(TOKEN_KEY);
      localStorage.removeItem(REFRESH_KEY);
      try {
        localStorage.removeItem(ME_CACHE_KEY);
      } catch (e) {}
    },

    cacheUser: function (user) {
      if (!user || typeof user !== "object") return;
      try {
        localStorage.setItem(ME_CACHE_KEY, JSON.stringify(user));
      } catch (e) {}
    },

    readCachedUser: function () {
      try {
        var raw = localStorage.getItem(ME_CACHE_KEY);
        if (!raw) return null;
        var u = JSON.parse(raw);
        return u && typeof u === "object" ? u : null;
      } catch (e) {
        return null;
      }
    },

    /**
     * Supabase-backed auth: refresh access token. Returns true if tokens were updated.
     * @returns {Promise<boolean>}
     */
    tryRefresh: async function () {
      var rt = localStorage.getItem(REFRESH_KEY);
      if (!rt) return false;
      var base = apiBase();
      if (!base) return false;
      try {
        var res = await fetch(base + "/auth/refresh", {
          method: "POST",
          headers: { "Content-Type": "application/json", Accept: "application/json" },
          body: JSON.stringify({ refresh_token: rt }),
        });
        if (res.status === 401) {
          this.clear();
          return false;
        }
        if (!res.ok) return false;
        var data = await res.json().catch(function () { return {}; });
        if (!data.token) return false;
        this.setToken(data.token);
        if (data.refresh_token) this.setRefreshToken(data.refresh_token);
        return true;
      } catch (e) {
        return false;
      }
    },

    apiBase: apiBase,

    authHeaders: function () {
      var h = { Accept: "application/json" };
      var t = this.getToken();
      if (t) h.Authorization = "Bearer " + t;
      return h;
    },

    /**
     * @returns {Promise<object|null|undefined>}
     *   user — session OK
     *   null — server said unauthorized (401 after refresh)
     *   undefined — could not reach server or transient error (do not treat as logout)
     */
    me: async function () {
      var self = this;
      var base = apiBase();
      if (!base) return null;
      var t = this.getToken();
      if (!t) return null;

      var maxAttempts = 5;
      var attempt = 0;

      async function oneFetch() {
        var res = await fetch(base + "/auth/me", {
          headers: self.authHeaders(),
          cache: "no-store",
        });
        if (res.status === 401) {
          var refreshed = await self.tryRefresh();
          if (refreshed) {
            res = await fetch(base + "/auth/me", {
              headers: self.authHeaders(),
              cache: "no-store",
            });
          }
        }
        return res;
      }

      while (attempt < maxAttempts) {
        attempt++;
        try {
          var res = await oneFetch();

          if (res.ok) {
            var data = await res.json().catch(function () {
              return {};
            });
            if (data.user && typeof data.user === "object") {
              self.cacheUser(data.user);
              return data.user;
            }
            if (attempt < maxAttempts) {
              await new Promise(function (r) {
                setTimeout(r, 250 * attempt);
              });
              continue;
            }
            return undefined;
          }

          if (res.status === 401) {
            return null;
          }

          if (attempt < maxAttempts) {
            await new Promise(function (r) {
              setTimeout(r, 200 * attempt);
            });
            continue;
          }
          return undefined;
        } catch (e) {
          console.warn("FuelAuth.me: request failed", e);
          if (attempt < maxAttempts) {
            await new Promise(function (r) {
              setTimeout(r, 200 * attempt);
            });
            continue;
          }
          return undefined;
        }
      }
      return undefined;
    },

    /**
     * Local dev only: POST /auth/dev-session (no body unless server sets FUEL_DEV_SECRET).
     * @param {string} [optionalSecret] — only if FUEL_DEV_SECRET is set on the server
     * @returns {Promise<object>} user
     */
    devBypass: async function (optionalSecret) {
      var base = apiBase();
      if (!base) throw new Error("No API URL — start the server on port 8787.");
      var body = {};
      if (optionalSecret) body.secret = String(optionalSecret);
      var res = await fetch(base + "/auth/dev-session", {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify(body),
      });
      var data = await res.json().catch(function () { return {}; });
      if (!res.ok) {
        var msg = (data && data.error) || "Dev sign-in failed";
        if (res.status === 404) {
          msg =
            "Dev sign-in is off on the server. Set FUEL_ALLOW_DEV_AUTH=true in server/.env and restart Node.";
        } else if (res.status === 503) {
          msg =
            (data && data.error) ||
            "Server needs FUEL_DEV_JWT_SECRET or AUTH_SECRET (16+ characters) to sign dev sessions.";
        } else if (res.status === 401) {
          msg =
            (data && data.error) ||
            (optionalSecret
              ? "Invalid dev secret."
              : "Unauthorized — if the server sets FUEL_DEV_SECRET, your client must send it (see dev menu).");
        }
        throw new Error(msg);
      }
      this.setToken(data.token);
      localStorage.removeItem(REFRESH_KEY);
      if (data.user) this.cacheUser(data.user);
      return data.user;
    },

    login: async function (email, password) {
      var base = apiBase();
      if (!base) throw new Error("No API URL — start the server on port 8787.");
      var res = await fetch(base + "/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({ email: email, password: password }),
      });
      var data = await res.json().catch(function () { return {}; });
      if (!res.ok) throw new Error(data.error || "Login failed");
      this.setToken(data.token);
      if (data.refresh_token) this.setRefreshToken(data.refresh_token);
      else localStorage.removeItem(REFRESH_KEY);
      if (data.user) this.cacheUser(data.user);
      return data.user;
    },

    register: async function (email, password, name) {
      var base = apiBase();
      if (!base) throw new Error("No API URL — start the server on port 8787.");
      var res = await fetch(base + "/auth/register", {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({ email: email, password: password, name: name || "" }),
      });
      var data = await res.json().catch(function () { return {}; });
      if (!res.ok) throw new Error(data.error || "Sign up failed");
      this.setToken(data.token);
      if (data.refresh_token) this.setRefreshToken(data.refresh_token);
      else localStorage.removeItem(REFRESH_KEY);
      if (data.user) this.cacheUser(data.user);
      return data.user;
    },

    /**
     * PATCH /auth/profile — merges `dashboard` and/or updates `name`.
     * @returns {Promise<object>} updated user
     */
    patchProfile: async function (partial) {
      var base = apiBase();
      if (!base) throw new Error("No API URL — start the server on port 8787.");
      var res = await fetch(base + "/auth/profile", {
        method: "PATCH",
        headers: Object.assign(
          { "Content-Type": "application/json" },
          this.authHeaders()
        ),
        body: JSON.stringify(partial && typeof partial === "object" ? partial : {}),
      });
      var data = await res.json().catch(function () { return {}; });
      if (res.status === 401) {
        var refreshed = await this.tryRefresh();
        if (refreshed) {
          res = await fetch(base + "/auth/profile", {
            method: "PATCH",
            headers: Object.assign(
              { "Content-Type": "application/json" },
              this.authHeaders()
            ),
            body: JSON.stringify(partial && typeof partial === "object" ? partial : {}),
          });
          data = await res.json().catch(function () { return {}; });
        }
      }
      if (!res.ok) throw new Error(data.error || "Could not save profile");
      if (data.token) this.setToken(data.token);
      if (data.user) this.cacheUser(data.user);
      return data.user;
    },

    /** Redirect to login if session invalid. @returns {Promise<object|null>} */
    guardApp: async function () {
      var base = apiBase();
      if (!base) {
        console.warn("FuelAuth: no proxy URL");
        return null;
      }

      var user = await this.me();

      if (user === undefined && this.getToken()) {
        await new Promise(function (r) {
          setTimeout(r, 500);
        });
        user = await this.me();
      }
      if (user === undefined && this.getToken()) {
        await new Promise(function (r) {
          setTimeout(r, 1200);
        });
        user = await this.me();
      }

      if (user === undefined) {
        var cached = this.readCachedUser();
        if (cached) {
          window.__FUEL_USER__ = cached;
          console.warn(
            "FuelAuth: using cached profile — API unreachable; check the server on port 8787."
          );
          return cached;
        }
      }

      if (user === undefined) {
        var page0 = location.pathname.split("/").pop() || "app.html";
        location.replace("login.html?return=" + encodeURIComponent(page0));
        return null;
      }

      if (user === null) {
        this.clear();
        var page2 = location.pathname.split("/").pop() || "app.html";
        location.replace("login.html?return=" + encodeURIComponent(page2));
        return null;
      }

      window.__FUEL_USER__ = user;
      return user;
    },

    logout: function () {
      this.clear();
      location.href = "login.html";
    },
  };
})();
