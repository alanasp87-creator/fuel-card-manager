(function () {
  "use strict";

  var APP_THEME_STORAGE_KEY = "fuel_app_theme";

  function initAppTheme() {
    var root = document.documentElement;
    var buttons = document.querySelectorAll("[data-app-theme-toggle]");
    if (!buttons.length) return;

    function applyTheme(mode) {
      var isLight = mode === "light";
      if (isLight) root.setAttribute("data-app-theme", "light");
      else root.removeAttribute("data-app-theme");
      try {
        localStorage.setItem(APP_THEME_STORAGE_KEY, isLight ? "light" : "dark");
      } catch (e) {}

      buttons.forEach(function (btn) {
        var t = btn.getAttribute("data-app-theme-toggle");
        var on = (t === "light" && isLight) || (t === "dark" && !isLight);
        btn.classList.toggle("is-active", on);
        btn.setAttribute("aria-pressed", on ? "true" : "false");
      });
    }

    var mode = "dark";
    try {
      var s = localStorage.getItem(APP_THEME_STORAGE_KEY);
      if (s === "light") mode = "light";
      else if (s === "dark") mode = "dark";
      else if (root.getAttribute("data-app-theme") === "light") mode = "light";
    } catch (e) {
      if (root.getAttribute("data-app-theme") === "light") mode = "light";
    }
    applyTheme(mode);

    buttons.forEach(function (btn) {
      btn.addEventListener("click", function () {
        var t = btn.getAttribute("data-app-theme-toggle");
        applyTheme(t === "light" ? "light" : "dark");
      });
    });
  }

  function bindShell(user) {
    var wrap = document.getElementById("app-user-wrap");
    var label = document.getElementById("app-user-label");
    var badge = document.getElementById("app-admin-badge");
    var signOut = document.getElementById("app-sign-out");
    var reauth = document.getElementById("sidebar-reauth");

    if (wrap && label) {
      label.textContent = user.name
        ? user.name + " · " + user.email
        : user.email;
      wrap.hidden = false;
      if (badge) badge.hidden = !user.isAdmin;
      var navAdmin = document.getElementById("nav-admin");
      if (navAdmin) navAdmin.hidden = !user.isAdmin;
    }
    if (signOut) {
      signOut.hidden = false;
      signOut.addEventListener("click", function () {
        window.FuelAuth.logout();
      });
    }
    if (reauth) reauth.hidden = false;

  }

  function initNavigation() {
    var sidebar = document.getElementById("app-sidebar");
    var backdrop = document.getElementById("app-backdrop");
    var toggle = document.querySelector(".app-menu-toggle");
    var titleEl = document.getElementById("app-page-title");
    var views = document.querySelectorAll(".app-view");
    var links = document.querySelectorAll(".app-nav__link[data-view]");

    var titles = {
      dashboard: "Fuel Snapshot",
      loads: "Load board",
      profile: "Profile",
      admin: "Admin Panel",
    };

    function setView(id) {
      views.forEach(function (v) {
        v.classList.toggle("is-active", v.id === "view-" + id);
      });
      links.forEach(function (l) {
        l.classList.toggle("is-active", l.getAttribute("data-view") === id);
      });
      if (titleEl && titles[id]) titleEl.textContent = titles[id];

      try {
        if (id === "dashboard") {
          history.replaceState(null, "", window.location.pathname + window.location.search);
        } else {
          history.replaceState(
            null,
            "",
            window.location.pathname + window.location.search + "#" + id
          );
        }
      } catch (err) {}

      closeMobileNav();

      if (id === "dashboard" && typeof window.refuelDashboardMetrics === "function") {
        window.refuelDashboardMetrics();
      }
      if (id === "reports" && typeof window.refuelReports === "function") {
        window.refuelReports();
      }
    }

    function closeMobileNav() {
      if (sidebar) sidebar.classList.remove("is-open");
      if (backdrop) backdrop.classList.remove("is-visible");
    }

    links.forEach(function (btn) {
      btn.addEventListener("click", function () {
        var id = btn.getAttribute("data-view");
        if (id) setView(id);
      });
    });

    if (toggle && sidebar) {
      toggle.addEventListener("click", function () {
        var open = sidebar.classList.toggle("is-open");
        if (backdrop) backdrop.classList.toggle("is-visible", open);
      });
    }
    if (backdrop) {
      backdrop.addEventListener("click", closeMobileNav);
    }

    function viewIdFromHash() {
      var hash = (window.location.hash || "").replace(/^#\/?/, "");
      if (
        hash === "loads" ||
        hash === "profile" ||
        hash === "admin"
      ) {
        return hash;
      }
      return "dashboard";
    }

    setView(viewIdFromHash());
    window.addEventListener("hashchange", function () {
      setView(viewIdFromHash());
    });

  }

  document.addEventListener("DOMContentLoaded", function () {
    initAppTheme();

    if (typeof window.FuelAuth === "undefined") {
      console.warn("FuelAuth not loaded");
      return;
    }
    window.FuelAuth.guardApp()
      .then(function (user) {
        if (!user) return;
        bindShell(user);
        initNavigation();
        try {
          if (typeof window.initDashboardLocalFuel === "function") {
            window.initDashboardLocalFuel(user);
          }
        } catch (err) {
          console.error("initDashboardLocalFuel", err);
        }
        try {
          if (typeof window.initProfilePage === "function") {
            window.initProfilePage(user);
          }
        } catch (err) {
          console.error("initProfilePage", err);
        }
        try {
          if (typeof window.initAdminPanel === "function") {
            window.initAdminPanel(user);
          }
        } catch (err) {
          console.error("initAdminPanel", err);
        }
      })
      .catch(function (err) {
        console.error("FuelAuth.guardApp", err);
        try {
          var page = location.pathname.split("/").pop() || "app.html";
          location.replace("login.html?return=" + encodeURIComponent(page));
        } catch (e) {}
      });
  });
})();
