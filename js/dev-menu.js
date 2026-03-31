/**
 * Floating developer menu — skip login via POST /auth/dev-session (no password by default).
 * Requires api-config.js + auth-client.js. Only mounts when FUEL_SHOW_DEV_MENU is true.
 */
(function () {
  "use strict";

  var LS_OPEN = "fuel_dev_menu_open";

  function el(tag, attrs, children) {
    var n = document.createElement(tag);
    if (attrs) {
      Object.keys(attrs).forEach(function (k) {
        if (k === "class") n.className = attrs[k];
        else if (k === "text") n.textContent = attrs[k];
        else n.setAttribute(k, attrs[k]);
      });
    }
    (children || []).forEach(function (c) {
      if (c) n.appendChild(c);
    });
    return n;
  }

  function mount() {
    if (!window.FUEL_SHOW_DEV_MENU) return;
    if (!window.FuelAuth || typeof window.FuelAuth.devBypass !== "function") return;

    var root = el("div", { class: "fuel-dev-menu", id: "fuel-dev-menu" });
    var toggle = el("button", {
      type: "button",
      class: "fuel-dev-menu__toggle",
      "aria-expanded": "false",
      "aria-controls": "fuel-dev-menu-panel",
      text: "Dev",
    });
    var panel = el("div", {
      class: "fuel-dev-menu__panel",
      id: "fuel-dev-menu-panel",
      hidden: "",
    });

    var title = el("p", { class: "fuel-dev-menu__title", text: "Developer" });
    var hint = el("p", {
      class: "fuel-dev-menu__hint",
      text: "Opens a local dev session (admin). Turn off FUEL_ALLOW_DEV_AUTH before exposing the API publicly; use ADMIN_EMAILS when you go live.",
    });
    var err = el("p", { class: "fuel-dev-menu__err", id: "fuel-dev-menu-err" });
    var ok = el("p", { class: "fuel-dev-menu__ok", id: "fuel-dev-menu-ok" });

    var rowPing = el("div", { class: "fuel-dev-menu__actions" });
    var btnPing = el("button", {
      type: "button",
      class: "btn btn-primary fuel-dev-menu__btn",
      text: "Test API (GET /health)",
      title: "No login — confirms the Node server responds (unlike GOV snapshot refresh, which can return 429)",
    });
    rowPing.appendChild(btnPing);

    var row = el("div", { class: "fuel-dev-menu__actions" });
    var btnGo = el("button", { type: "button", class: "btn btn-ghost fuel-dev-menu__btn", text: "Skip login" });
    var btnRefreshLabel = "Refresh fuel snapshot";
    var btnRefresh = el("button", {
      type: "button",
      class: "btn btn-ghost fuel-dev-menu__btn",
      text: btnRefreshLabel,
      title:
        "Reload GOV.UK prices: tries /auth/dev-fuel-snapshot-refresh (dev token), then /admin/fuel-snapshot/refresh (admins)",
    });
    row.appendChild(btnGo);
    row.appendChild(btnRefresh);

    var navRow = el("div", { class: "fuel-dev-menu__nav" });
    var aApp = el("a", { href: "app.html", text: "Open app" });
    var aLogin = el("a", { href: "login.html", text: "Sign-in page" });
    navRow.appendChild(aApp);
    navRow.appendChild(document.createTextNode(" · "));
    navRow.appendChild(aLogin);

    panel.appendChild(title);
    panel.appendChild(hint);
    panel.appendChild(err);
    panel.appendChild(ok);
    panel.appendChild(rowPing);
    panel.appendChild(row);
    panel.appendChild(navRow);

    root.appendChild(toggle);
    root.appendChild(panel);
    document.body.appendChild(root);

    function setErr(msg) {
      err.textContent = msg || "";
      err.style.display = msg ? "block" : "none";
      if (msg) {
        ok.textContent = "";
        ok.style.display = "none";
      }
    }

    function setOk(msg) {
      ok.textContent = msg || "";
      ok.style.display = msg ? "block" : "none";
      if (msg) {
        err.textContent = "";
        err.style.display = "none";
      }
    }

    function openPanel(open) {
      panel.hidden = !open;
      toggle.setAttribute("aria-expanded", open ? "true" : "false");
      try {
        localStorage.setItem(LS_OPEN, open ? "1" : "0");
      } catch (e) {}
    }

    try {
      if (localStorage.getItem(LS_OPEN) === "1") openPanel(true);
    } catch (e) {}

    toggle.addEventListener("click", function () {
      openPanel(panel.hidden);
    });

    function go() {
      setErr("");
      btnGo.disabled = true;
      window.FuelAuth
        .devBypass()
        .then(function () {
          var page = location.pathname.split("/").pop() || "";
          if (page === "login.html" || page === "signup.html") {
            var q = new URLSearchParams(location.search);
            location.href = q.get("return") || "app.html";
          } else if (page !== "app.html") {
            location.href = "app.html";
          } else {
            location.reload();
          }
        })
        .catch(function (ex) {
          setErr(ex.message || "Failed");
        })
        .finally(function () {
          btnGo.disabled = false;
        });
    }

    btnGo.addEventListener("click", go);

    btnPing.addEventListener("click", function () {
      setErr("");
      setOk("");
      if (typeof window.fuelPingBackendHealth !== "function") {
        setErr("api-config.js not loaded (fuelPingBackendHealth missing).");
        return;
      }
      btnPing.disabled = true;
      window
        .fuelPingBackendHealth()
        .then(function (r) {
          if (r.ok) setOk(r.message || "OK");
          else setErr(r.message || "Failed");
        })
        .catch(function (ex) {
          setErr(ex && ex.message ? ex.message : "Request failed");
        })
        .finally(function () {
          btnPing.disabled = false;
        });
    });

    function parseResponseJson(res, text) {
      var data = {};
      var t = text != null ? String(text) : "";
      if (t.trim()) {
        try {
          data = JSON.parse(t);
        } catch (e) {
          data = { error: t.slice(0, 400) };
        }
      }
      return data && typeof data === "object" ? data : {};
    }

    function postSnapshotRefresh(apiRoot, headers, path) {
      return fetch(apiRoot + path, {
        method: "POST",
        headers: headers,
        body: "{}",
      }).then(function (res) {
        return res.text().then(function (text) {
          return { res: res, data: parseResponseJson(res, text) };
        });
      });
    }

    function refreshFuelSnapshot() {
      setErr("");
      setOk("");
      if (!window.FuelAuth || typeof window.FuelAuth.apiBase !== "function") return;
      var base = window.FuelAuth.apiBase();
      if (!base) {
        setErr("No API URL — set FUEL_FINDER_PROXY_BASE / run the server on :8787.");
        return;
      }
      if (typeof window.FuelAuth.getToken !== "function" || !window.FuelAuth.getToken()) {
        setErr("Sign in or use Skip login first.");
        return;
      }
      btnRefresh.disabled = true;
      btnRefresh.textContent = "Refreshing…";
      var headers = Object.assign({}, window.FuelAuth.authHeaders(), {
        "Content-Type": "application/json",
      });
      var apiRoot = base.replace(/\/$/, "");

      function finishSuccess(data) {
        var snap = data.snapshot || {};
        var n = snap.count != null ? snap.count : "?";
        var line = "Snapshot OK — " + n + " stations.";
        if (data.cohortsError) {
          line += " Cohort note: " + data.cohortsError;
        }
        setOk(line);
        if (typeof window.refuelDashboardMetrics === "function") {
          window.refuelDashboardMetrics();
        }
        try {
          window.dispatchEvent(new CustomEvent("fuel-snapshot-refreshed", { detail: data }));
        } catch (e) {}
      }

      function failMessage(status, data) {
        var errText = (data && (data.error || data.message)) || "";
        if (errText) return errText;
        if (status === 401) return "Unauthorized — sign in again or use Skip login (dev).";
        if (status === 403) return "Forbidden — add your email to ADMIN_EMAILS or use Skip login.";
        if (status === 404) return "Endpoint not found — update the server.";
        if (status === 503) return "Server misconfigured (e.g. GOV Fuel Finder credentials).";
        return "Refresh failed (" + status + ").";
      }

      function tryWithOptionalSessionRefresh() {
        if (typeof window.FuelAuth.tryRefresh !== "function") {
          return Promise.resolve(false);
        }
        return window.FuelAuth.tryRefresh().then(function (ok) {
          if (!ok) return false;
          headers = Object.assign({}, window.FuelAuth.authHeaders(), {
            "Content-Type": "application/json",
          });
          return true;
        });
      }

      postSnapshotRefresh(apiRoot, headers, "/auth/dev-fuel-snapshot-refresh")
        .then(function (x) {
          if (x.res.ok) {
            finishSuccess(x.data);
            return null;
          }
          if (x.res.status === 401 && typeof window.FuelAuth.tryRefresh === "function") {
            return tryWithOptionalSessionRefresh().then(function (refreshed) {
              if (!refreshed) return x;
              return postSnapshotRefresh(apiRoot, headers, "/auth/dev-fuel-snapshot-refresh");
            });
          }
          return x;
        })
        .then(function (x) {
          if (!x) return;
          if (x.res && x.res.ok) {
            finishSuccess(x.data);
            return;
          }
          if (x.res && (x.res.status === 401 || x.res.status === 404)) {
            return postSnapshotRefresh(apiRoot, headers, "/admin/fuel-snapshot/refresh");
          }
          var msg = failMessage(x.res ? x.res.status : 0, x.data || {});
          setErr(msg);
        })
        .then(function (x) {
          if (!x || !x.res) return;
          if (x.res.ok) {
            finishSuccess(x.data);
            return;
          }
          setErr(failMessage(x.res.status, x.data || {}));
        })
        .catch(function (ex) {
          setErr(ex && ex.message ? ex.message : "Request failed");
        })
        .finally(function () {
          btnRefresh.disabled = false;
          btnRefresh.textContent = btnRefreshLabel;
        });
    }

    btnRefresh.addEventListener("click", refreshFuelSnapshot);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", mount);
  } else {
    mount();
  }
})();
